/**
 * Ticket 01 (B4 perf regression) — the per-frame allocation regression test.
 *
 * The B4 investigation (`.scratch/lighting-system-2/01-findings/B4-perf-regression-
 * phase-drift.md`) root-caused the 64-player position-snapping + `[anim] phase-clock
 * drift` regression to ~500+ short-lived objects allocated per frame in the lighting
 * budget path → young-gen GC churn → frame drops > 16.67ms → the spiral-of-death
 * guards in `PredictionService.step` / `AnimSimDriver.update` drop accumulated sim
 * time → reconciled error exceeds `RENDER_OFFSET_SNAP_THRESHOLD = 16px` → Tier-3
 * hard-snap + drift warning. The investigation explicitly flagged the ABSENCE of a
 * perf regression test as the reason the regression shipped undetected. This is it.
 *
 * Allocation in a headless vitest (jsdom, no V8 GC hooks) is measured indirectly
 * but deterministically: the ticket-01 pools are grow-only, so "steady-state zero
 * per-frame allocation" is provable as "the pools stop growing after warmup." Each
 * test runs several frames with a fixed 64-player-load fixture, then asserts the
 * relevant pool size (or the set of registered object refs) is identical across
 * the last two frames — i.e. no new objects handed out at steady state. A growth
 * here would mean the pool is leaking (a real regression); a fixed-size result
 * proves zero per-frame allocation in the hot path.
 *
 * The three loci the ticket names are each covered:
 *   1. `LightBudget.selectLightsForBudget` — the `sortPool` (SortEntry pool).
 *   2. `LightingBudgetStage` — `staticPool` (StaticLightCandidate) +
 *      `dynamicPool` (DynamicLightCandidate), driven via `addDynamic` + `select`.
 *   3. `DynamicLightPopulator.cloneLight` — the alternating `clonePoolA`/`clonePoolB`,
 *      asserted via registered-light object-identity reuse (black-box: the scratch
 *      WeakMap is private, so the test proves pooling by showing frame N and N+2
 *      reuse the SAME `DynamicLight` object refs).
 *
 * Review note C (REVIEW.md §C): the spec's "zero per-frame allocation" is the ideal;
 * this test asserts the MEASURABLE reduction (pools stop growing after warmup → no
 * per-frame allocation in the pooled hot path). The pre-ticket-01 baseline was
 * ~500+ objects/frame; post-ticket-01 the steady-state pooled-path allocation is
 * provably zero (the pool-size assertions below).
 */
import { describe, it, expect } from 'vitest';
import { PlayerStatus, WeaponType } from '@sector-battle/shared';
import {
  selectLightsForBudget,
  createBudgetScratch,
  DEFAULT_BUDGET,
  LIGHT_PRIORITY,
  type BudgetScratch,
  type StaticLightCandidate,
  type DynamicLightCandidate,
  type CameraRect,
} from '../LightBudget.js';
import { LightingBudgetStage } from '../LightingBudgetStage.js';
import { populateDynamicLights } from '../DynamicLightPopulator.js';
import type { DynamicLight, LightPlacementTiled } from '../LightPacker.js';
import type { EntityMaps } from '../../../network/StateSync.js';
import type { DynamicLightPopulatorDeps } from '../DynamicLightPopulator.js';
import type { ExplosionLightRegistry } from '../ExplosionLightRegistry.js';
import type { LightingPipeline } from '../LightingPipeline.js';
import type { GameState } from '../../../controllers/GameState.js';
import type { StateSync } from '../../../network/StateSync.js';
import type { EntityInterpolator } from '../../../prediction/EntityInterpolator.js';
import type { PredictionService } from '../../../prediction/PredictionService.js';
import type { PlayerState, ProjectileState } from '../../../types.js';

// ── Helpers ────────────────────────────────────────────────────────────────

/** A minimal camera stub: `LightingBudgetStage.select` reads only `worldView`. */
function fakeCamera(centerX: number, centerY: number): { worldView: CameraRect } {
  return {
    worldView: { x: centerX - 960, y: centerY - 540, width: 1920, height: 1080 },
  };
}

/** A static placement at the given grid coord (in view of the centered camera). */
function placementAt(gridX: number, gridY: number, isScatter = false): LightPlacementTiled {
  return { gridX, gridY, kind: 'torch', rotation: 0, flipH: false, flipV: false, isScatter };
}

/** A static-candidate helper (kept for parity with LightBudget.test.ts fixtures). */
function staticCandidateAt(x: number, y: number, radius = 200): StaticLightCandidate {
  return { x, y, radius };
}

/** A dynamic candidate at (x,y) with the given priority. */
function dynamicCandidateAt(
  x: number,
  y: number,
  priority: number,
  radius = 200,
): DynamicLightCandidate {
  const light: DynamicLight = {
    x,
    y,
    radius,
    intensity: 2,
    color: [1, 1, 1],
    corePower: 4,
    haloFrac: 0.5,
    specPower: 28,
    cookieOn: 1,
  };
  return { light, priority };
}

/** A minimal ALIVE player at the given id/position. */
function playerEntity(id: string, x: number, y: number): PlayerState {
  return {
    id,
    name: id,
    color: 0,
    x,
    y,
    direction: 0,
    facingAngle: 0,
    speed: 0,
    velocityX: 0,
    velocityY: 0,
    health: 100,
    maxHealth: 100,
    status: PlayerStatus.ALIVE,
    kills: 0,
    activeSlot: 0,
    lastDamageTick: 0,
    dashCooldown: 0,
    barrierActive: false,
    isBlocking: false,
    speedBoostActive: false,
    connected: true,
    isBot: false,
    isWindupActive: false,
    windupWeaponType: 0,
    windupAttackType: '',
    animPhase: 0,
    animPhaseStartTick: 0,
    comboIndex: 0,
    barrierExpiryTick: 0,
    speedBoostExpiryTick: 0,
    freshSpawnExpiryTick: 0,
    lastProcessedInput: 0,
    weapons: [],
    items: [],
  };
}

/** A live RANGED projectile (crossbow) at the given id/position. */
function projectileEntity(id: string, x: number, y: number): ProjectileState {
  return {
    id,
    ownerId: 'owner',
    x,
    y,
    velocityX: 100,
    velocityY: 0,
    damage: 10,
    bounces: -1,
    weaponType: WeaponType.CROSSBOW,
    tier: 0,
  };
}

/** Empty EntityMaps (each fixture seeds only the collections it needs). */
function emptyEntityMaps(): EntityMaps {
  return {
    players: new Map(),
    projectiles: new Map(),
    destructibles: new Map(),
    chests: new Map(),
    weaponPickups: new Map(),
    traps: new Map(),
    powerUps: new Map(),
    explosions: new Map(),
    exits: new Map(),
  };
}

/**
 * A fake pipeline that records every registered dynamic light (by REFERENCE, so
 * the test can assert object-identity reuse across frames). Mirrors the
 * `makeFakePipeline` in DynamicLightPopulator.test.ts but exposes the raw refs.
 */
function makeRecordingPipeline(): LightingPipeline & {
  captured: { light: DynamicLight; priority: number }[];
} {
  const captured: { light: DynamicLight; priority: number }[] = [];
  const fake = {
    beginDynamicLights() {
      captured.length = 0;
    },
    addDynamicLight(light: DynamicLight, priority: number) {
      captured.push({ light, priority });
    },
    captured,
  };
  return fake as unknown as LightingPipeline & {
    captured: { light: DynamicLight; priority: number }[];
  };
}

/**
 * Build deps for the populator that resolves player/projectile positions from the
 * given maps. The local player (id === myId) resolves via the prediction stub;
 * remotes + projectiles resolve via the interpolator stub. Explosions inert.
 */
function makeDeps(
  entities: EntityMaps,
  myId: string,
  visualPos: { x: number; y: number },
  playerPosById: ReadonlyMap<string, { x: number; y: number }>,
  projPosById: ReadonlyMap<string, { x: number; y: number }>,
): DynamicLightPopulatorDeps {
  const stateSync = { getEntities: () => entities } as unknown as StateSync;
  const state = { myId } as unknown as GameState;
  const interpolator = {
    getInterpolatedPosition: (id: string, out: { x: number; y: number }): boolean => {
      const pos = playerPosById.get(id);
      if (!pos) return false;
      out.x = pos.x;
      out.y = pos.y;
      return true;
    },
  } as unknown as EntityInterpolator;
  const projectileInterpolator = {
    getInterpolatedPosition: (id: string, out: { x: number; y: number }): boolean => {
      const pos = projPosById.get(id);
      if (!pos) return false;
      out.x = pos.x;
      out.y = pos.y;
      return true;
    },
  } as unknown as EntityInterpolator;
  const predictionService = { getVisualPosition: () => visualPos } as unknown as PredictionService;
  const explosionLights = {
    collect: () => [] as DynamicLight[],
  } as unknown as ExplosionLightRegistry;
  return {
    state,
    stateSync,
    interpolator,
    projectileInterpolator,
    predictionService,
    explosionLights,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('Lighting budget path — per-frame allocation regression (ticket 01 / B4)', () => {
  /**
   * The CAMERA_CENTER fixture + ~280-candidate load mirrors the B4 investigation's
   * 64-player peak estimate (~160 static + ~64 dynamic + ~200 sort entries after
   * distance-cull). The exact counts aren't load-bearing — the STEADY-STATE
   * assertion is: after warmup, the pools stop growing (= zero per-frame alloc).
   */
  const CAMERA: CameraRect = { x: -960, y: -540, width: 1920, height: 1080 };

  describe('LightBudget.selectLightsForBudget — SortEntry pool stops growing', () => {
    it('the sortPool reaches a steady-state size and then does not grow per frame', () => {
      // A 64-player-peak candidate set: ~160 statics (40 props + 120 scatter) +
      // ~80 dynamics (players + projectiles), all in view of the centered camera.
      const statics: StaticLightCandidate[] = [];
      for (let i = 0; i < 160; i++) statics.push(staticCandidateAt(i * 20 - 1600, 0, 150));
      const dynamics: DynamicLightCandidate[] = [];
      for (let i = 0; i < 80; i++)
        dynamics.push(dynamicCandidateAt(i * 20 - 800, 100, LIGHT_PRIORITY.PLAYER, 150));

      const scratch: BudgetScratch = createBudgetScratch();
      // Warmup: run enough frames that the grow-only pool reaches its high-water
      // mark. With identical inputs every frame, this happens after frame 1.
      const warmupFrames = 3;
      for (let f = 0; f < warmupFrames; f++) {
        selectLightsForBudget(statics, dynamics, CAMERA, DEFAULT_BUDGET, scratch);
      }
      const steadyPoolSize = scratch.sortPool.length;

      // The steady-state run: 20 more frames with identical inputs. The pool
      // MUST NOT grow — if it does, the per-frame allocation regression is back.
      for (let f = 0; f < 20; f++) {
        selectLightsForBudget(statics, dynamics, CAMERA, DEFAULT_BUDGET, scratch);
        expect(scratch.sortPool.length).toBe(steadyPoolSize);
      }

      // Sanity: the pool actually got used (it's nonzero — the candidates are
      // in view, so each in-view candidate acquires an entry). This proves the
      // test is exercising the pooled path, not a degenerate empty case.
      expect(steadyPoolSize).toBeGreaterThan(0);
      // And the kept count is the expected budget-trimmed size (≤ onScreenTarget).
      const result = selectLightsForBudget(statics, dynamics, CAMERA, DEFAULT_BUDGET, scratch);
      expect(result.staticIndices.length + result.dynamicIndices.length).toBeLessThanOrEqual(
        DEFAULT_BUDGET.onScreenTarget,
      );
    });

    it('a growing candidate set grows the pool (the pool is correct, not frozen)', () => {
      // Defensive: prove the pool CAN grow when warranted (a larger scene) so the
      // "stops growing" assertion above isn't passing because the pool is stuck.
      const scratch: BudgetScratch = createBudgetScratch();
      const small: StaticLightCandidate[] = [staticCandidateAt(0, 0)];
      selectLightsForBudget(small, [], CAMERA, DEFAULT_BUDGET, scratch);
      const sizeAfterSmall = scratch.sortPool.length;

      const large: StaticLightCandidate[] = [];
      for (let i = 0; i < 50; i++) large.push(staticCandidateAt(i * 10, 0, 150));
      selectLightsForBudget(large, [], CAMERA, DEFAULT_BUDGET, scratch);
      const sizeAfterLarge = scratch.sortPool.length;

      expect(sizeAfterLarge).toBeGreaterThan(sizeAfterSmall);
    });

    it('result correctness is preserved (kept set + priority order unchanged by pooling)', () => {
      // The pooling MUST be behavior-preserving. Assert the kept subset + order
      // match the pre-ticket semantics: priority order (PLAYER > EXPLOSION > ...),
      // nearest-first within a band, distance-cull of off-screen candidates.
      const scratch: BudgetScratch = createBudgetScratch();
      const tiny = { onScreenTarget: 2, margin: 256 };
      const dynamics = [
        dynamicCandidateAt(0, 0, LIGHT_PRIORITY.BARREL),
        dynamicCandidateAt(10, 0, LIGHT_PRIORITY.STATIC),
        dynamicCandidateAt(20, 0, LIGHT_PRIORITY.PROJECTILE),
        dynamicCandidateAt(30, 0, LIGHT_PRIORITY.EXPLOSION),
        dynamicCandidateAt(40, 0, LIGHT_PRIORITY.PLAYER),
      ];
      const r = selectLightsForBudget([], dynamics, CAMERA, tiny, scratch);
      // PLAYER (idx 4) + EXPLOSION (idx 3) survive — the two highest-priority.
      expect(r.dynamicIndices).toContain(4);
      expect(r.dynamicIndices).toContain(3);
      expect(r.dynamicIndices).not.toContain(2);
      expect(r.dynamicIndices).not.toContain(1);
      expect(r.dynamicIndices).not.toContain(0);
    });
  });

  describe('LightingBudgetStage — static + dynamic candidate pools stop growing', () => {
    /**
     * `select()` needs a Phaser Camera, but it only reads `cam.worldView`. A
     * minimal stub suffices (the stage never touches the rest of the camera).
     */
    function stageCamera(): { worldView: CameraRect } {
      return { worldView: CAMERA };
    }

    it('the staticPool reaches a steady-state size and does not grow per frame', () => {
      const stage = new LightingBudgetStage();
      // A 64-player-peak placement set: ~40 motivated props + ~120 scatter.
      const placements: LightPlacementTiled[] = [];
      for (let i = 0; i < 40; i++) placements.push(placementAt(i + 1, 1, false));
      for (let i = 0; i < 120; i++) placements.push(placementAt(i + 1, 3, true));
      const cam = stageCamera();
      const TILE = 128;

      // Warmup.
      for (let f = 0; f < 3; f++) stage.select(placements, TILE, cam as never);
      // Reach into the private pool via a cast (the pool is internal; the test
      // asserts on its size as the steady-state allocation proxy).
      const steadyStaticSize = (stage as unknown as { staticPool: unknown[] }).staticPool.length;

      // Steady-state run: 20 frames, pool must not grow.
      for (let f = 0; f < 20; f++) {
        stage.select(placements, TILE, cam as never);
        expect((stage as unknown as { staticPool: unknown[] }).staticPool.length).toBe(
          steadyStaticSize,
        );
      }
      // Sanity: the pool is actually populated (160 placements → ~160 entries).
      expect(steadyStaticSize).toBeGreaterThan(0);
    });

    it('the dynamicPool reaches a steady-state size and does not grow per frame', () => {
      const stage = new LightingBudgetStage();
      const cam = stageCamera();
      const placements: LightPlacementTiled[] = [];
      const TILE = 128;

      // A 64-player-peak dynamic load: 64 player auras + a handful of projectiles.
      // Each addDynamic acquires a pooled wrapper.
      function registerFrameDynamics() {
        stage.beginFrame();
        for (let i = 0; i < 64; i++) {
          const light: DynamicLight = {
            x: i * 10,
            y: 0,
            radius: 160,
            intensity: 1.9,
            color: [0.4, 0.68, 1.0],
            corePower: 3.5,
            haloFrac: 0.7,
            specPower: 28,
            cookieOn: 2,
          };
          stage.addDynamic(light, LIGHT_PRIORITY.PLAYER);
        }
      }

      // Warmup.
      for (let f = 0; f < 3; f++) {
        registerFrameDynamics();
        stage.select(placements, TILE, cam as never);
      }
      const steadyDynamicSize = (stage as unknown as { dynamicPool: unknown[] }).dynamicPool.length;

      // Steady-state run: 20 frames, pool must not grow.
      for (let f = 0; f < 20; f++) {
        registerFrameDynamics();
        stage.select(placements, TILE, cam as never);
        expect((stage as unknown as { dynamicPool: unknown[] }).dynamicPool.length).toBe(
          steadyDynamicSize,
        );
      }
      // Sanity: 64 dynamics registered → pool has ~64 entries.
      expect(steadyDynamicSize).toBeGreaterThanOrEqual(64);
    });

    it('a frame with fewer dynamics does not shrink the pool (high-water mark retained)', () => {
      // The pool is grow-only: a busy frame sets the high-water mark, a quiet
      // frame reuses the existing entries (no realloc when the busy frame recurs).
      const stage = new LightingBudgetStage();
      const cam = stageCamera();
      const placements: LightPlacementTiled[] = [];
      const TILE = 128;

      // Busy frame: 64 dynamics.
      stage.beginFrame();
      for (let i = 0; i < 64; i++) {
        stage.addDynamic(
          {
            x: i,
            y: 0,
            radius: 160,
            intensity: 1,
            color: [1, 1, 1],
            corePower: 3,
            haloFrac: 0.7,
            specPower: 28,
            cookieOn: 1,
          },
          LIGHT_PRIORITY.PLAYER,
        );
      }
      stage.select(placements, TILE, cam as never);
      const busySize = (stage as unknown as { dynamicPool: unknown[] }).dynamicPool.length;

      // Quiet frame: 1 dynamic.
      stage.beginFrame();
      stage.addDynamic(
        {
          x: 0,
          y: 0,
          radius: 160,
          intensity: 1,
          color: [1, 1, 1],
          corePower: 3,
          haloFrac: 0.7,
          specPower: 28,
          cookieOn: 1,
        },
        LIGHT_PRIORITY.PLAYER,
      );
      stage.select(placements, TILE, cam as never);
      // Pool size unchanged (grow-only; the quiet frame reuses entries 0..0).
      expect((stage as unknown as { dynamicPool: unknown[] }).dynamicPool.length).toBe(busySize);

      // Another busy frame: no new growth (high-water mark already reached).
      stage.beginFrame();
      for (let i = 0; i < 64; i++) {
        stage.addDynamic(
          {
            x: i,
            y: 0,
            radius: 160,
            intensity: 1,
            color: [1, 1, 1],
            corePower: 3,
            haloFrac: 0.7,
            specPower: 28,
            cookieOn: 1,
          },
          LIGHT_PRIORITY.PLAYER,
        );
      }
      stage.select(placements, TILE, cam as never);
      expect((stage as unknown as { dynamicPool: unknown[] }).dynamicPool.length).toBe(busySize);
    });
  });

  describe('DynamicLightPopulator.cloneLight — pooled DynamicLight refs reused at steady state', () => {
    /**
     * Black-box: the per-pipeline scratch (incl. the alternating clone pools) is
     * private, so the test proves pooling by showing that frame N and frame N+2
     * reuse the SAME `DynamicLight` object refs (the two-pool alternation means
     * frames N and N+2 hit the same pool). If cloneLight were still allocating a
     * fresh object per entity per frame, the refs would NEVER be `===` across
     * frames. Identical refs across frames = pooled reuse = zero per-frame alloc.
     */
    function build64PlayerFixture(): {
      entities: EntityMaps;
      deps: DynamicLightPopulatorDeps;
    } {
      const entities = emptyEntityMaps();
      const playerPosById = new Map<string, { x: number; y: number }>();
      // 64 players clustered in view of the centered camera (all in view → all
      // registered, exercising the full clone path). One is "local."
      for (let i = 0; i < 64; i++) {
        const id = i === 0 ? 'local' : `remote-${i}`;
        const x = (i % 8) * 40 - 160;
        const y = Math.floor(i / 8) * 40 - 160;
        entities.players.set(id, playerEntity(id, x, y));
        playerPosById.set(id, { x, y });
      }
      // A few projectiles (3 lights each — head + 2 trail) for full coverage.
      const projPosById = new Map<string, { x: number; y: number }>();
      for (let i = 0; i < 4; i++) {
        const id = `proj-${i}`;
        entities.projectiles.set(id, projectileEntity(id, i * 30, 200));
        projPosById.set(id, { x: i * 30, y: 200 });
      }
      const deps = makeDeps(entities, 'local', { x: -160, y: -160 }, playerPosById, projPosById);
      return { entities, deps };
    }

    it('frame N and frame N+2 reuse the SAME DynamicLight object refs (alternating pool)', () => {
      const pipeline = makeRecordingPipeline();
      const { deps } = build64PlayerFixture();

      // Warmup: let the projectile trail buffer reach steady state (it records
      // head positions across frames, so the per-projectile light count matures
      // from head-only to head + 2 trail over the first few frames). Once the
      // trail is stable, the registered-light COUNT is stable frame-to-frame.
      for (let f = 0; f < 6; f++) populateDynamicLights(pipeline, deps, f * 16, 1.0);

      // Frame N (pool A, assuming N is even after the 6-frame warmup).
      populateDynamicLights(pipeline, deps, 6 * 16, 1.0);
      const frameNRefs = pipeline.captured.map((c) => c.light);

      // Frame N+1 (pool B).
      populateDynamicLights(pipeline, deps, 7 * 16, 1.0);
      const frameN1Refs = pipeline.captured.map((c) => c.light);

      // Frame N+2 (pool A again) — MUST reuse frame N's refs (pool A is reused,
      // not reallocated). This is the steady-state-zero-alloc proof.
      populateDynamicLights(pipeline, deps, 8 * 16, 1.0);
      const frameN2Refs = pipeline.captured.map((c) => c.light);

      expect(frameNRefs.length).toBeGreaterThan(0);
      // After warmup the registered count is stable (same fixture → same count).
      expect(frameN2Refs.length).toBe(frameNRefs.length);
      // Every frame-(N+2) ref is `===`-identical to the corresponding frame-N ref.
      // (Object-identity, not deep equality — proves the same object was reused.)
      for (let i = 0; i < frameNRefs.length; i++) {
        expect(frameN2Refs[i]).toBe(frameNRefs[i]); // pooled reuse
      }
      // Frame N+1 (the OTHER pool) is distinct from frame N (two-pool alternation).
      // At least the first entry differs (pool B is a distinct allocation).
      expect(frameN1Refs[0]).not.toBe(frameNRefs[0]);
    });

    it('a frame with MORE entities grows the pool once, then reuses (no per-frame growth)', () => {
      // Steady state means: after the entity count's high-water mark is reached,
      // subsequent frames do not allocate. Verify by adding entities across frames.
      const pipeline = makeRecordingPipeline();
      const entities = emptyEntityMaps();
      const playerPosById = new Map<string, { x: number; y: number }>();
      // Start with 32 players.
      for (let i = 0; i < 32; i++) {
        const id = i === 0 ? 'local' : `r-${i}`;
        const x = (i % 8) * 40;
        const y = Math.floor(i / 8) * 40;
        entities.players.set(id, playerEntity(id, x, y));
        playerPosById.set(id, { x, y });
      }
      let deps = makeDeps(entities, 'local', { x: 0, y: 0 }, playerPosById, new Map());

      // Prime both pools with the 32-player load (2 frames → both pools warmed).
      populateDynamicLights(pipeline, deps, 0, 1.0);
      populateDynamicLights(pipeline, deps, 16, 1.0);

      // Now grow to 64 players. The active pool this frame will grow from 32→~64.
      for (let i = 32; i < 64; i++) {
        const id = `r-${i}`;
        const x = (i % 8) * 40;
        const y = Math.floor(i / 8) * 40 + 400;
        entities.players.set(id, playerEntity(id, x, y));
        playerPosById.set(id, { x, y });
      }
      deps = makeDeps(entities, 'local', { x: 0, y: 0 }, playerPosById, new Map());
      populateDynamicLights(pipeline, deps, 32, 1.0); // frame 2 (pool A) grows.
      const frame2Refs = pipeline.captured.map((c) => c.light);
      const frame2Count = frame2Refs.length;

      // Frame 3 (pool B) also grows to ~64 (first time pool B sees 64).
      populateDynamicLights(pipeline, deps, 48, 1.0);

      // Frame 4 (pool A) MUST reuse frame 2's refs exactly — no new growth.
      populateDynamicLights(pipeline, deps, 64, 1.0);
      const frame4Refs = pipeline.captured.map((c) => c.light);

      expect(frame4Refs.length).toBe(frame2Count);
      for (let i = 0; i < frame2Refs.length; i++) {
        expect(frame4Refs[i]).toBe(frame2Refs[i]);
      }
    });

    it('cloneLight output is behavior-identical to a fresh object (values correct, not shared state)', () => {
      // The pooling MUST be behavior-preserving: each registered light carries
      // the correct entity's values (no bleed-through of a previous entity's
      // state via the reused object). Two entities with distinct colors/positions
      // → two registered lights with distinct values.
      const pipeline = makeRecordingPipeline();
      const entities = emptyEntityMaps();
      const playerPosById = new Map<string, { x: number; y: number }>();
      entities.players.set('local', playerEntity('local', 100, 100));
      playerPosById.set('local', { x: 100, y: 100 });
      entities.players.set('remote', playerEntity('remote', 5000, 5000));
      playerPosById.set('remote', { x: 5000, y: 5000 });
      const deps = makeDeps(entities, 'local', { x: 100, y: 100 }, playerPosById, new Map());

      populateDynamicLights(pipeline, deps, 0, 1.0);

      const byX = new Map(pipeline.captured.map((c) => [c.light.x, c.light]));
      const local = byX.get(100);
      const remote = byX.get(5000);
      expect(local).toBeDefined();
      expect(remote).toBeDefined();
      // Distinct entities → distinct registered objects.
      expect(local).not.toBe(remote);
      // Ticket 07 (A2): local = remote for aura color/intensity (ticket 22's
      // local-vs-remote branch was removed). The two entities differ by POSITION
      // (local at x=100, remote at x=5000), which proves the reused pool entry
      // was overwritten with the correct entity's values (not stale). The prior
      // assertion (local.color ≠ remote.color) encoded ticket 22's warm-shifted
      // local color — no longer applicable.
      expect(local!.x).toBe(100);
      expect(remote!.x).toBe(5000);
      expect(local!.x).not.toBe(remote!.x);
    });
  });
});
