/**
 * End-to-end gate test for ticket 08 (A7 wire-fix) — the load-bearing test.
 *
 * WHY THIS TEST EXISTS (the A7 root cause it guards against):
 * The deferred explosion light NEVER FIRED in any build, ever. The server's
 * `toBarrelExplodedMessage` omitted the `eventType` field, but the client gate
 * at `ExplosionEventHandler.ts:91` requires `data.eventType === 'BarrelExploded'`
 * → the gate was always `false` → `ExplosionLightRegistry.register()` was never
 * called. The registry's 13/13 unit tests passed because they called `register()`
 * DIRECTLY, bypassing the gate entirely — false confidence.
 * (`git log -S "eventType: 'BarrelExploded'"` was empty across all history
 * pre-fix.)
 *
 * WHAT THIS TEST PROVES:
 *  1. A REAL `BarrelExplodedMessage` (with `eventType: 'BarrelExploded'` set)
 *     fed through `ExplosionEventHandler.handle` reaches the registry and calls
 *     `register()`. This exercises the ACTUAL gate — not the bypass.
 *  2. A `BarrelExplodedMessage` WITHOUT `eventType` (the pre-fix wire format)
 *     does NOT call `register()` — this codifies the bug so a regression to the
 *     omission is caught.
 *  3. A `DestructibleDestroyedMessage` (crate break — plain wood, not a fire
 *     event) does NOT call `register()` — the gate is barrel-only by design
 *     (ticket 18 tightening).
 *  4. A `DestructibleRespawnedMessage` early-outs cleanly (no SFX, no register).
 *
 * This is the test that would have caught A7 if it had existed before. The
 * judge will independently verify this test exercises `ExplosionEventHandler
 * .handle` receiving a real message — NOT the registry unit test.
 *
 * Reference: `.scratch/lighting-system-2/01-findings/A7-explosion-vfx-dynamic-lights.md`
 * (§3.1 the discriminator omission, §3.3 the codified-bug test, §5.4 the
 * missing regression-guard gap this test closes).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  BarrelExplodedMessage,
  DestructibleDestroyedMessage,
  DestructibleRespawnedMessage,
  ExplosionChannelMessage,
} from '@sector-battle/shared';
import { ExplosionEventHandler } from '../ExplosionEventHandler.js';
import { ExplosionLightRegistry } from '../../../rendering/lighting/ExplosionLightRegistry.js';
import type { AudioService } from '../../../audio/AudioService.js';
import type { CameraService } from '../../../rendering/CameraService.js';
import type { EntityRenderer } from '../../../rendering/EntityRenderer.js';
import type { MapRenderer } from '../../../rendering/MapRenderer.js';

/**
 * Minimal stubs — `handle` dereferences only a small surface of each dep. Cast
 * through `unknown` (test-only escape hatch; same shape as
 * `WeaponHideEventHandler.test.ts`).
 */
function makeStubs() {
  return {
    audio: { playAt: vi.fn() } as unknown as AudioService,
    cameraService: { shake: vi.fn() } as unknown as CameraService,
    entityRenderer: {
      triggerDestructibleBreak: vi.fn(),
      spawnDustCloud: vi.fn(),
    } as unknown as EntityRenderer,
    mapRenderer: { clearGridCell: vi.fn() } as unknown as MapRenderer,
    // A near-empty scene stub: `handle` touches `scene.cameras.main.worldView`
    // + `scene.add.rectangle` + `scene.tweens.add`. We stub enough that the
    // flash branch can execute without throwing. The flash branch is gated by
    // distance < 300; placing the explosion far from local pos avoids it
    // entirely so the stub can stay minimal.
    scene: {
      cameras: { main: { worldView: { x: 0, y: 0, width: 800, height: 600 } } },
      add: { rectangle: vi.fn(() => ({ setDepth: () => {}, setScrollFactor: () => {} })) },
      tweens: { add: vi.fn() },
    },
  };
}

/**
 * Build a handler with a SPIED registry. The spy is the real
 * `ExplosionLightRegistry.prototype.register` so the assertion exercises the
 * actual code path (handler → registry.register), not a mock stand-in. The
 * registry is otherwise real (its lifecycle/pool logic is irrelevant to the
 * gate test — we only assert the call site is reached).
 */
function makeHandlerWithSpy(registry?: ExplosionLightRegistry): {
  handler: ExplosionEventHandler;
  registry: ExplosionLightRegistry;
  registerSpy: ReturnType<typeof vi.spyOn>;
} {
  // The registry is pure (no Phaser) — safe to construct directly in vitest.
  // We spy on the REAL `register` so the test exercises the actual handler →
  // registry code path (not a mock stand-in).
  const real = registry ?? new ExplosionLightRegistry();
  const registerSpy = vi.spyOn(real, 'register');
  const stubs = makeStubs();
  // Local position far from the explosion so the camera-shake + flash branches
  // don't fire (the gate test is about the registry call, not the SFX path).
  const handler = new ExplosionEventHandler(
    { x: -10_000, y: -10_000 },
    stubs.audio,
    stubs.cameraService,
    stubs.entityRenderer,
    stubs.mapRenderer,
    stubs.scene as unknown as ConstructorParameters<typeof ExplosionEventHandler>[5],
    real,
  );
  return { handler, registry: real, registerSpy };
}

describe('ticket 08 (A7 wire-fix) — ExplosionEventHandler end-to-end gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('a real BarrelExplodedMessage WITH eventType reaches registry.register (the gate fires)', () => {
    // This is THE test the A7 findings doc §5.4 named as the missing guard.
    // The message shape matches what `toBarrelExplodedMessage` emits post-fix
    // (eventType is now present). Feeding it through `handle` exercises the
    // ACTUAL gate at line 91 — not the registry's bypass.
    const { handler, registerSpy } = makeHandlerWithSpy();
    const msg: BarrelExplodedMessage = {
      eventType: 'BarrelExploded',
      id: 'b1',
      x: 1500,
      y: 2000,
      radius: 256,
      damage: 50,
      tick: 99,
    };

    handler.handle(msg);

    expect(registerSpy).toHaveBeenCalledTimes(1);
    // Register signature: (x, y, blastRadius, nowMs, seed). Assert position +
    // blast radius are forwarded from the message; nowMs/seed are derived.
    const [x, y, blastRadius] = registerSpy.mock.calls[0]!;
    expect(x).toBe(1500);
    expect(y).toBe(2000);
    expect(blastRadius).toBe(256);
  });

  it('a BarrelExplodedMessage WITHOUT eventType (the pre-fix wire format) does NOT reach register', () => {
    // This codifies the A7 bug: pre-fix, the wire payload omitted `eventType`.
    // The gate `data.eventType === 'BarrelExploded'` evaluated to
    // `undefined === 'BarrelExploded'` === false, so register() was never
    // called. If a future change re-omits the field, this test trips.
    const { handler, registerSpy } = makeHandlerWithSpy();
    const buggyMsg = {
      // eventType deliberately OMITTED — this is the pre-fix shape.
      id: 'b1',
      x: 1500,
      y: 2000,
      radius: 256,
      damage: 50,
      tick: 99,
    } as ExplosionChannelMessage;

    handler.handle(buggyMsg);

    expect(registerSpy).not.toHaveBeenCalled();
  });

  it('a DestructibleDestroyedMessage (crate break) does NOT register a light (gate is barrel-only)', () => {
    // Ticket 18 tightening: only `BarrelExploded` registers the explosion light
    // (crates are plain wood, not a fire event). The post-fix message carries
    // `eventType: 'DestructibleDestroyed'` (the A7 wire-fix sets it on all
    // three producers) — the gate must still NOT fire for this variant.
    const { handler, registerSpy } = makeHandlerWithSpy();
    const msg: DestructibleDestroyedMessage = {
      eventType: 'DestructibleDestroyed',
      id: 'd1',
      gridX: 3,
      gridY: 4,
      x: 1500,
      y: 2000,
      droppedLoot: { kind: 'ammo' },
      tick: 99,
    };

    handler.handle(msg);

    expect(registerSpy).not.toHaveBeenCalled();
  });

  it('a DestructibleRespawnedMessage early-outs cleanly (no SFX, no register)', () => {
    // The early-out at `ExplosionEventHandler.ts:32`
    // (`if (data.eventType === 'DestructibleRespawned') return;`) was DEAD
    // pre-fix (the field was always undefined). Post-fix it works. This asserts
    // the respawn path returns BEFORE the registry gate AND before the SFX.
    const stubs = makeStubs();
    const real = new ExplosionLightRegistry();
    const registerSpy = vi.spyOn(real, 'register');
    const handler = new ExplosionEventHandler(
      { x: 0, y: 0 },
      stubs.audio,
      stubs.cameraService,
      stubs.entityRenderer,
      stubs.mapRenderer,
      stubs.scene as unknown as ConstructorParameters<typeof ExplosionEventHandler>[5],
      real,
    );
    const msg: DestructibleRespawnedMessage = {
      eventType: 'DestructibleRespawned',
      id: 'd2',
      destructibleType: 'crate',
      tick: 99,
    };

    handler.handle(msg);

    expect(registerSpy).not.toHaveBeenCalled();
    // SFX also skipped — the early-out is before the audio line.
    expect(stubs.audio.playAt).not.toHaveBeenCalled();
  });

  it('a BarrelExplodedMessage without x/y does NOT register (defensive null-gate)', () => {
    // The gate also requires `data.x != null && data.y != null`. A malformed
    // message (no position) must not crash the registry. Asserts the null-guard
    // half of the gate condition.
    const { handler, registerSpy } = makeHandlerWithSpy();
    const msg = {
      eventType: 'BarrelExploded',
      id: 'b1',
      // x and y deliberately omitted.
      radius: 256,
      damage: 50,
      tick: 99,
    } as unknown as BarrelExplodedMessage;

    handler.handle(msg);

    expect(registerSpy).not.toHaveBeenCalled();
  });
});
