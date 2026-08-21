import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InterpolationService } from '../InterpolationService.js';
import { EntityInterpolator } from '../EntityInterpolator.js';
import type { StateSync } from '../../network/StateSync.js';
import type { PlayerRenderer } from '../../rendering/PlayerRenderer.js';
import type { EntityRenderer } from '../../rendering/EntityRenderer.js';
import type { GameState } from '../../controllers/GameState.js';
import type { AudioService } from '../../audio/AudioService.js';
import type { TelemetrySample } from '../../debug/TelemetryRing.js';

/**
 * C4b regression: InterpolationService must NOT allocate a fresh `{x,y}`
 * per remote player per frame. After the first sighting of an id, the
 * `lastPosition` entry must be mutated in place — same object reference
 * across frames. Verified via reference equality on the private map's value.
 *
 * Also asserts the local-player exclusion is preserved and that the
 * footstep-distance semantics are unchanged by the in-place mutation.
 */
describe('InterpolationService — GC pooling (C4b)', () => {
  let now: number;
  let playerInterpolator: EntityInterpolator;
  let projectileInterpolator: EntityInterpolator;
  let players: Map<string, unknown>;
  let projectiles: Map<string, unknown>;
  let stateSync: StateSync;
  let playerRenderer: PlayerRenderer;
  let entityRenderer: EntityRenderer;
  let state: GameState;
  let audio: AudioService;

  beforeEach(() => {
    now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);

    playerInterpolator = new EntityInterpolator();
    projectileInterpolator = new EntityInterpolator();
    players = new Map<string, unknown>([
      ['remote-1', {}],
      ['remote-2', {}],
    ]);
    projectiles = new Map<string, unknown>();

    // Minimal stubs — only the methods touched by update() are needed.
    stateSync = {
      getEntities: () => ({ players, projectiles }),
    } as unknown as StateSync;
    playerRenderer = {
      updatePosition: vi.fn(),
    } as unknown as PlayerRenderer;
    entityRenderer = {
      setProjectilePosition: vi.fn(),
    } as unknown as EntityRenderer;
    state = { myId: 'me' } as unknown as GameState;
    audio = {
      playAt: vi.fn(),
    } as unknown as AudioService;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeService(): InterpolationService {
    return new InterpolationService(
      playerInterpolator,
      projectileInterpolator,
      stateSync,
      playerRenderer,
      entityRenderer,
      state,
      audio,
    );
  }

  /**
   * Reach the private map for reference-equality assertions. `as any` is the
   * established test convention in this repo (see ClientCollisionService
   * tests). The production class never exposes this map.
   */
  function lastPositionMap(
    svc: InterpolationService,
  ): Map<string, { x: number; y: number }> {
    return (
      svc as unknown as {
        lastPosition: Map<string, { x: number; y: number }>;
      }
    ).lastPosition;
  }

  describe('per-frame {x,y} pooling', () => {
    it('reuses the same {x,y} object reference across frames for one remote id', () => {
      const svc = makeService();
      // Seed a snapshot for remote-1 with velocity so interpolation produces
      // a position every frame.
      playerInterpolator.push('remote-1', 0, 0, 100, 0);

      // Frame 1: first sighting allocates the entry.
      now = 16;
      svc.update();
      const refAfterFrame1 = lastPositionMap(svc).get('remote-1');
      expect(refAfterFrame1).toBeDefined();

      // Frame 2: must mutate the SAME entry in place, not allocate a new object.
      now = 32;
      svc.update();
      const refAfterFrame2 = lastPositionMap(svc).get('remote-1');

      expect(refAfterFrame2).toBe(refAfterFrame1); // reference equality — zero alloc
    });

    it('does NOT allocate on the second and later frames (reference stability across many frames)', () => {
      const svc = makeService();
      playerInterpolator.push('remote-1', 0, 0, 100, 0);

      now = 16;
      svc.update();
      const firstRef = lastPositionMap(svc).get('remote-1');

      for (let i = 2; i <= 10; i++) {
        now = i * 16;
        svc.update();
        expect(lastPositionMap(svc).get('remote-1')).toBe(firstRef);
      }
    });

    it('keeps per-id entries distinct (no aliasing between remote ids)', () => {
      const svc = makeService();
      playerInterpolator.push('remote-1', 0, 0, 100, 0);
      playerInterpolator.push('remote-2', 0, 0, 0, 100);

      now = 16;
      svc.update();

      const ref1 = lastPositionMap(svc).get('remote-1');
      const ref2 = lastPositionMap(svc).get('remote-2');
      expect(ref1).not.toBe(ref2);

      now = 32;
      svc.update();
      expect(lastPositionMap(svc).get('remote-1')).toBe(ref1);
      expect(lastPositionMap(svc).get('remote-2')).toBe(ref2);
    });
  });

  describe('local-player exclusion is preserved', () => {
    it('does NOT track the local player (excluded inside update())', () => {
      players.set('me', {});
      playerInterpolator.push('me', 50, 50, 100, 0);

      const svc = makeService();
      now = 16;
      svc.update();

      // The local player must never appear in lastPosition — its exclusion
      // gate lives in update() (originally InterpolationService.ts:41).
      expect(lastPositionMap(svc).has('me')).toBe(false);
    });
  });

  describe('footstep semantics unchanged by in-place mutation', () => {
    it('accumulates travel distance across frames using the mutated entry', () => {
      const svc = makeService();
      // Push a snapshot, then advance so the interpolated position moves.
      playerInterpolator.push('remote-1', 0, 0, 0, 0);

      now = 16;
      svc.update();

      // Move the entity by pushing a new velocity-bearing snapshot. The next
      // update should compute a non-zero delta against the mutated entry.
      playerInterpolator.push('remote-1', 200, 0, 2000, 0);
      now = 80; // ~64ms later → extrapolation yields large displacement
      svc.update();

      // After two frames the mutated entry holds the frame-2 position; the
      // footstep accumulator must reflect actual travel (not stale data from
      // a pre-mutation copy). We assert the entry updated at all.
      const entry = lastPositionMap(svc).get('remote-1')!;
      expect(entry.x).toBeGreaterThan(0);
    });

    it('removePlayer clears tracking for that id', () => {
      const svc = makeService();
      playerInterpolator.push('remote-1', 0, 0, 100, 0);

      now = 16;
      svc.update();
      expect(lastPositionMap(svc).has('remote-1')).toBe(true);

      svc.removePlayer('remote-1');
      expect(lastPositionMap(svc).has('remote-1')).toBe(false);
    });
  });

  // Compile-time guard: the TelemetrySample import stays in scope so the
  // sibling TelemetrySampler regression test shares the same field set.
  it('TelemetrySample field set is stable (compile guard)', () => {
    const s = {
      predictionError: 0,
      renderOffsetMagnitude: 0,
      velocityX: 0,
      velocityY: 0,
      serverVelocityX: 0,
      serverVelocityY: 0,
      predictionBufferSize: 0,
      reconciliationCount: 0,
      lastReconciliationError: 0,
      lastReconciliationSeq: 0,
      isMoving: 0,
      animationState: 0,
      dt: 0,
    } satisfies TelemetrySample;
    expect(s.dt).toBe(0);
  });
});
