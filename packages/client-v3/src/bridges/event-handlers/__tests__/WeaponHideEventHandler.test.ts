/**
 * Regression test for ticket 03 (B1) — weapon throw/break event-driven hide.
 *
 * WHY THE EVENT-HANDLER SEAM (not the per-frame pipeline):
 * `PlayerRendererUpdate.test.ts:6-19` documents that driving the per-frame
 * `updateAllPlayerFrames` pipeline end-to-end requires a deep Phaser Sprite
 * stub the repo does not have (Phaser has no lightweight headless mode in
 * vitest). The authoritative fix for B1 is EVENT-DRIVEN: the throw and break
 * event handlers call `PlayerRenderer.hideWeapon(playerId)`, which sets the
 * persistent `weaponHidden` flag the per-frame block respects. So the
 * load-bearing regression assertion is at the EVENT-HANDLER layer — does the
 * hide mechanism get invoked when the throw/break event fires?
 *
 * WHAT THIS PROVES:
 *  1. `onThrow` invokes `playerRenderer.hideWeapon(playerId)` — the weapon has
 *     left the hand, the sprite must detach immediately (not wait for the slot
 *     to clear via the next state patch).
 *  2. `WeaponBroken` invokes `playerRenderer.hideWeapon(playerId)` AFTER reading
 *     `getWeaponWorldState` — the shatter VFX must capture the weapon's pose
 *     first (it returns null once the sprite is hidden), THEN the source sprite
 *     hides.
 *  3. Non-break damage events do NOT invoke the hide (only throw + break do).
 *
 * WHAT THIS DOES NOT PROVE (covered by tsc + the per-frame pipeline in prod):
 *  - The per-frame `else if (equippedWeaponType >= 0 && !weaponHidden)` guard
 *    respects the flag. That's a one-line conditional; the typecheck + the
 *    existing 195+ client tests gate it.
 *  - Visual correctness in a real Phaser scene (browser verification).
 *
 * Reference: `.scratch/lighting-system-2/01-findings/B1-weapon-throw-break-render.md`
 * (§3.2 smoking gun, §3.3 SFX-only event handlers, §6 scope of fix).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { WeaponThrownMessage, DamageChannelMessage } from '@sector-battle/shared';
import { DamageType } from '@sector-battle/shared';
import { createEventBridge } from '../index.js';
import type { EventBridgeDeps } from '../index.js';
import { DamageEventHandler } from '../DamageEventHandler.js';
import type { PlayerRenderer } from '../../../rendering/PlayerRenderer.js';

/**
 * PlayerRenderer stub. `hideWeapon` and `getWeaponWorldState` are the spies the
 * throw/break assertions check; the other methods (`triggerHitFlash`,
 * `applyHitFlinch`, `triggerBlockClash`, `triggerMeleeHitReaction`,
 * `updatePosition`) are no-op stubs so the PlayerDamaged / ShieldBlocked paths
 * can execute end-to-end and prove they reach the end of `handle` WITHOUT
 * calling hideWeapon. Cast through `unknown` (test-only escape hatch, same
 * shape as `buildEmptyContext` in PlayerRendererUpdate.test.ts).
 */
interface PlayerRendererStub extends PlayerRenderer {
  hideWeapon: ReturnType<typeof vi.fn>;
  getWeaponWorldState: ReturnType<typeof vi.fn>;
}

function makePlayerRendererStub(): PlayerRendererStub {
  return {
    hideWeapon: vi.fn(),
    // Return a fixed pose so the shatter-VFX branch exercises the read BEFORE
    // hide. Tests assert call ORDER (getWeaponWorldState before hideWeapon).
    getWeaponWorldState: vi.fn(() => ({
      x: 100,
      y: 200,
      rotation: 1.5,
      tint: 0xff8800,
      scale: 0.7,
    })),
    // No-op stubs for methods the non-break damage paths dereference. They are
    // never the assertion target; they just let `handle` run to completion.
    triggerHitFlash: vi.fn(),
    applyHitFlinch: vi.fn(),
    triggerBlockClash: vi.fn(),
    triggerMeleeHitReaction: vi.fn(),
    updatePosition: vi.fn(),
  } as unknown as PlayerRendererStub;
}

/** Minimal audio stub — both handlers only call `playAt`. */
function makeAudioStub() {
  return { playAt: vi.fn() };
}

/**
 * Minimal EventBridgeDeps stub for the onThrow test. `createEventBridge`
 * constructs all 7 handlers, but the `onThrow` callback only touches `deps.audio`
 * + `deps.playerRenderer` directly — the other handler constructors just store
 * their refs and never dereference them on the throw path.
 */
function makeBridgeDeps(playerRenderer: PlayerRendererStub): EventBridgeDeps {
  return {
    myId: { value: 'me' },
    localPos: { x: 0, y: 0 },
    playerRenderer,
    statusEffects: {},
    entityRenderer: {},
    damageNumbers: {},
    mapRenderer: {},
    cameraService: {},
    audio: makeAudioStub(),
    hud: {},
    stateSync: {},
    scene: {},
    playerNames: new Map(),
    resultsScreen: { value: null },
    spectator: {},
    freezeUntil: { value: 0 },
    returnToMenu: () => {},
  } as unknown as EventBridgeDeps;
}

/**
 * Builds a DamageEventHandler with stub deps. The WeaponBroken path only
 * dereferences: audio.playAt, stateSync.getPlayer, entityRenderer
 *   .triggerDestructibleBreak + .triggerWeaponBreak, playerRenderer
 *   .getWeaponWorldState + .hideWeapon. The PlayerDamaged path also touches
 *   playerRenderer.triggerHitFlash + .applyHitFlinch + .updatePosition +
 *   .triggerMeleeHitReaction, cameraService.shake + .punch + .zoomPunch,
 *   damageNumbers.spawn + .spawnLabel, entityRenderer.spawn*Particles,
 *   stateSync.getEntities. We stub all of them so the handler can be driven
 *   across both event types from one fixture.
 */
function makeDamageHandler(opts: {
  playerRenderer: PlayerRendererStub;
  brokenPlayer?: { x: number; y: number; facingAngle: number } | undefined;
}): { handler: DamageEventHandler; audio: ReturnType<typeof makeAudioStub> } {
  const audio = makeAudioStub();
  const entityRenderer = {
    triggerDestructibleBreak: vi.fn(),
    triggerWeaponBreak: vi.fn(),
    spawnBloodParticles: vi.fn(),
    spawnFireParticles: vi.fn(),
    spawnShieldBlockParticles: vi.fn(),
  };
  const cameraService = { shake: vi.fn(), punch: vi.fn(), zoomPunch: vi.fn() };
  const damageNumbers = { spawn: vi.fn(), spawnLabel: vi.fn() };
  const stateSync = {
    getPlayer: vi.fn(() => opts.brokenPlayer),
    getEntities: vi.fn(() => ({ players: new Map() })),
  };
  // Cast through unknown: the stubs satisfy the structural shape each handler
  // path dereferences, without mocking the full Phaser-bound class surface.
  const handler = new DamageEventHandler(
    { value: 'me' },
    { x: 0, y: 0 },
    audio as unknown as ConstructorParameters<typeof DamageEventHandler>[2],
    cameraService as unknown as ConstructorParameters<typeof DamageEventHandler>[3],
    damageNumbers as unknown as ConstructorParameters<typeof DamageEventHandler>[4],
    entityRenderer as unknown as ConstructorParameters<typeof DamageEventHandler>[5],
    opts.playerRenderer,
    stateSync as unknown as ConstructorParameters<typeof DamageEventHandler>[7],
  );
  return { handler, audio };
}

const BROKEN_PLAYER = { x: 100, y: 200, facingAngle: 1.5 };
const BROKEN_PLAYER_ID = 'p-broken';

describe('ticket 03 (B1) — weapon throw/break event-driven hide', () => {
  describe('onThrow hides the held weapon sprite', () => {
    it('calls playerRenderer.hideWeapon(playerId) when a weapon is thrown', () => {
      const playerRenderer = makePlayerRendererStub();
      const bridge = createEventBridge(makeBridgeDeps(playerRenderer));

      const msg: WeaponThrownMessage = {
        eventType: 'WeaponThrown',
        playerId: 'p7',
        weaponType: 12,
        weaponSlot: 1,
        x: 500,
        y: 600,
        tick: 9999,
      };

      bridge.onThrow(msg);

      expect(playerRenderer.hideWeapon).toHaveBeenCalledTimes(1);
      expect(playerRenderer.hideWeapon).toHaveBeenCalledWith('p7');
    });

    it('preserves the existing throw SFX (hide is added on top, not a replacement)', () => {
      const playerRenderer = makePlayerRendererStub();
      const deps = makeBridgeDeps(playerRenderer);
      const bridge = createEventBridge(deps);

      bridge.onThrow({
        eventType: 'WeaponThrown',
        playerId: 'p1',
        weaponType: 5,
        weaponSlot: 0,
        x: 10,
        y: 20,
        tick: 1,
      });

      // SFX are positional — both sounds fire at the throw site.
      expect(deps.audio.playAt).toHaveBeenCalledWith('hit_melee', 10, 20);
      expect(deps.audio.playAt).toHaveBeenCalledWith('weapon_drop', 10, 20);
      expect(playerRenderer.hideWeapon).toHaveBeenCalledWith('p1');
    });
  });

  describe('WeaponBroken hides the held weapon sprite AFTER reading its pose', () => {
    let playerRenderer: PlayerRendererStub;
    let handler: DamageEventHandler;
    let audio: ReturnType<typeof makeAudioStub>;

    beforeEach(() => {
      playerRenderer = makePlayerRendererStub();
      ({ handler, audio } = makeDamageHandler({
        playerRenderer,
        brokenPlayer: BROKEN_PLAYER,
      }));
    });

    const weaponBrokenMsg: DamageChannelMessage = {
      eventType: 'WeaponBroken',
      playerId: BROKEN_PLAYER_ID,
      weaponType: 7,
      slotIndex: 0,
      x: BROKEN_PLAYER.x,
      y: BROKEN_PLAYER.y,
      tick: 42,
    };

    it('calls playerRenderer.hideWeapon(playerId) when a weapon breaks', () => {
      handler.handle(weaponBrokenMsg);

      expect(playerRenderer.hideWeapon).toHaveBeenCalledTimes(1);
      expect(playerRenderer.hideWeapon).toHaveBeenCalledWith(BROKEN_PLAYER_ID);
    });

    it('reads getWeaponWorldState BEFORE hideWeapon (shatter VFX needs the pre-hide pose)', () => {
      // getWeaponWorldState returns null once the sprite is invisible, so the
      // shatter VFX must capture the pose first. This pins the call ORDER —
      // reversing it would lose the weapon's real rotation/tint/scale.
      handler.handle(weaponBrokenMsg);

      const wsOrder = playerRenderer.getWeaponWorldState.mock.invocationCallOrder[0];
      const hideOrder = playerRenderer.hideWeapon.mock.invocationCallOrder[0];
      expect(wsOrder).toBeDefined();
      expect(hideOrder).toBeDefined();
      // `toBeDefined()` doesn't narrow the array index type, so assert with `!`.
      expect(wsOrder!).toBeLessThan(hideOrder!);
    });

    it('preserves the break SFX (hide added on top)', () => {
      handler.handle(weaponBrokenMsg);
      expect(audio.playAt).toHaveBeenCalledWith('weapon_break', BROKEN_PLAYER.x, BROKEN_PLAYER.y);
    });
  });

  describe('non-break damage events do NOT invoke the hide', () => {
    it('PlayerDamaged does not call hideWeapon (only WeaponBroken does)', () => {
      const playerRenderer = makePlayerRendererStub();
      // brokenPlayer undefined → the `if (brokenPlayer)` body (which has the
      // hide) is skipped on the WeaponBroken path; for PlayerDamaged the hide
      // is never reached regardless.
      const { handler } = makeDamageHandler({ playerRenderer, brokenPlayer: undefined });

      handler.handle({
        eventType: 'PlayerDamaged',
        playerId: 'p-victim',
        damage: 25,
        sourceId: 'p-attacker',
        sourceType: 1,
        damageType: DamageType.MELEE_HIT,
        knockbackX: 10,
        knockbackY: 0,
        killed: false,
        tick: 1,
        x: 50,
        y: 60,
      });

      expect(playerRenderer.hideWeapon).not.toHaveBeenCalled();
    });

    it('ShieldBlocked does not call hideWeapon', () => {
      const playerRenderer = makePlayerRendererStub();
      const { handler } = makeDamageHandler({ playerRenderer, brokenPlayer: undefined });

      handler.handle({
        eventType: 'ShieldBlocked',
        playerId: 'p-defender',
        damageType: DamageType.MELEE_HIT,
        sourceId: 'p-attacker',
        x: 50,
        y: 60,
        tick: 1,
      });

      expect(playerRenderer.hideWeapon).not.toHaveBeenCalled();
    });
  });
});
