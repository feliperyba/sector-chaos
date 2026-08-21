/**
 * End-to-end gate tests for ticket 09 / A3 (combat impact lighting).
 *
 * WHY THIS TEST EXISTS (the load-bearing test, mirroring
 * `ExplosionEventHandler.test.ts`):
 * The ImpactLightRegistry's 23 unit tests pass by calling `register()` DIRECTLY
 * — bypassing the event-handler gates entirely. That gives false confidence
 * (same false confidence the A7 explosion-light investigation caught: the
 * registry unit tests passed while the handler gate was dead). THIS test
 * exercises the ACTUAL handler → registry path for each of the 4 combat events:
 *
 *   1. `PlayerDamaged` with a weapon-hit damage type (melee_hit/thrown_hit/
 *      ranged_hit/projectile_hit) → `register('melee', ...)` at the contact
 *      point.
 *   2. `PlayerDamaged` with a NON-weapon damage type (barrel_explosion /
 *      zone_damage / sudden_death / siege_crush / trap_damage) → does NOT
 *      register (gated).
 *   3. `ShieldBlocked` → `register('block', ...)` at the clash point (prefers
 *      `contactX/contactY`, falls back to `x/y`).
 *   4. `WeaponBroken` → `register('break', ...)` at the weapon's world position.
 *   5. `ProjectileDestroyed` for a RANGED bolt → `register('projectile', ...)`
 *      at the impact point.
 *   6. `ProjectileDestroyed` for a physical throw (THROWN/LINE/ARC) → does NOT
 *      register (RANGED-only ruling).
 *
 * PAYLOAD-SHAPE TRACE (REVIEW item C — each event has a DIFFERENT shape):
 *   - PlayerDamaged (`damage-messages.ts:30-43`): `x`, `y`, `damageType`, `tick`.
 *   - ShieldBlocked (`damage-messages.ts:61-79`): `x`, `y` + OPTIONAL
 *     `contactX`/`contactY` + `tick`.
 *   - WeaponBroken (`damage-messages.ts:45-59`): `x`, `y`, `weaponType`, `tick`.
 *     The handler reads the weapon's WORLD pose via `getWeaponWorldState` (the
 *     shatter VFX's pre-hide pose) + falls back to the broken player's position.
 *   - ProjectileDestroyed (`attack-messages.ts:39-54`): `x`, `y`, `projectileId`,
 *     `tick`. NO `weaponType`/`attackType` on the wire — the handler looks the
 *     projectile entity up in `stateSync` to read its `weaponType` + resolve the
 *     AttackType (RANGED-only gate).
 *
 * Reference: `.scratch/lighting-system-2/01-findings/A3-projectiles-arrows-
 * elemental-only.md` (§2 the table, §3 the AttackType mapping, §4 the elemental
 * proof).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  AttackChannelMessage,
  DamageChannelMessage,
  ProjectileDestroyedMessage,
} from '@sector-battle/shared';
import { AttackType, DamageType, WeaponType } from '@sector-battle/shared';
import { DamageEventHandler } from '../DamageEventHandler.js';
import { AttackEventHandler } from '../AttackEventHandler.js';
import { ImpactLightRegistry } from '../../../rendering/lighting/ImpactLightRegistry.js';
import type { ImpactLightKind } from '../../../rendering/lighting/ImpactLightRegistry.js';
import type { AudioService } from '../../../audio/AudioService.js';
import type { CameraService } from '../../../rendering/CameraService.js';
import type { DamageNumberRenderer } from '../../../rendering/DamageNumberRenderer.js';
import type { EntityRenderer } from '../../../rendering/EntityRenderer.js';
import type { MapRenderer } from '../../../rendering/MapRenderer.js';
import type { PlayerRenderer } from '../../../rendering/PlayerRenderer.js';
import type { StateSync } from '../../../network/StateSync.js';

/**
 * Minimal stubs. Each handler dereferences only a small surface of each dep.
 * Cast through `unknown` (test-only escape hatch; same shape as
 * `WeaponHideEventHandler.test.ts`).
 */
function makeCommonStubs() {
  return {
    audio: { playAt: vi.fn() } as unknown as AudioService,
    cameraService: {
      shake: vi.fn(),
      punch: vi.fn(),
      zoomPunch: vi.fn(),
    } as unknown as CameraService,
    damageNumbers: { spawn: vi.fn(), spawnLabel: vi.fn() } as unknown as DamageNumberRenderer,
    entityRenderer: {
      triggerDestructibleBreak: vi.fn(),
      triggerWeaponBreak: vi.fn(),
      spawnBloodParticles: vi.fn(),
      spawnFireParticles: vi.fn(),
      spawnShieldBlockParticles: vi.fn(),
      triggerProjectileBounce: vi.fn(),
    } as unknown as EntityRenderer,
    mapRenderer: { clearGridCell: vi.fn() } as unknown as MapRenderer,
    playerRenderer: {
      hideWeapon: vi.fn(),
      getWeaponWorldState: vi.fn(() => null),
      triggerHitFlash: vi.fn(),
      applyHitFlinch: vi.fn(),
      triggerBlockClash: vi.fn(),
      triggerMeleeHitReaction: vi.fn(),
      triggerWallHit: vi.fn(),
      updatePosition: vi.fn(),
      getPlayerPosition: vi.fn(() => null),
      addAttack: vi.fn(),
      addHitStop: vi.fn(),
    } as unknown as PlayerRenderer,
  };
}

/**
 * Build a DamageEventHandler with a SPIED registry. The spy is the real
 * `ImpactLightRegistry.prototype.register` so the assertion exercises the actual
 * code path (handler → registry.register), not a mock stand-in. Mirrors
 * `makeHandlerWithSpy` in ExplosionEventHandler.test.ts.
 */
function makeDamageHandlerWithSpy(opts: {
  brokenPlayer?: { x: number; y: number; facingAngle: number } | undefined;
  weaponWorldState?: { x: number; y: number; rotation: number; tint: number; scale: number } | null;
}): {
  handler: DamageEventHandler;
  registry: ImpactLightRegistry;
  registerSpy: ReturnType<typeof vi.spyOn>;
} {
  const real = new ImpactLightRegistry();
  const registerSpy = vi.spyOn(real, 'register');
  const stubs = makeCommonStubs();
  // Override getWeaponWorldState for the WeaponBroken path (returns the captured
  // pose BEFORE hide; defaults to a fixed pose so the break flash has a position
  // to read). Cast through unknown (test-only escape hatch — the stub satisfies
  // the structural shape the handler path dereferences).
  (stubs.playerRenderer as unknown as {
    getWeaponWorldState: ReturnType<typeof vi.fn>;
  }).getWeaponWorldState = vi.fn(() => opts.weaponWorldState);
  const stateSync = {
    getPlayer: vi.fn(() => opts.brokenPlayer),
    getEntities: vi.fn(() => ({ players: new Map(), projectiles: new Map() })),
  } as unknown as StateSync;
  const handler = new DamageEventHandler(
    { value: 'me' },
    { x: 0, y: 0 },
    stubs.audio,
    stubs.cameraService,
    stubs.damageNumbers,
    stubs.entityRenderer,
    stubs.playerRenderer,
    stateSync,
    real,
  );
  return { handler, registry: real, registerSpy };
}

/**
 * Build an AttackEventHandler with a SPIED registry. The projectile-impact path
 * looks the projectile entity up in `stateSync.getEntities().projectiles` — the
 * `projectiles` map is seeded with the test's projectile so the handler can read
 * its `weaponType` + resolve the AttackType (RANGED-only gate).
 */
function makeAttackHandlerWithSpy(opts: {
  projectile?: { id: string; weaponType: number; x: number; y: number } | undefined;
}): {
  handler: AttackEventHandler;
  registry: ImpactLightRegistry;
  registerSpy: ReturnType<typeof vi.spyOn>;
} {
  const real = new ImpactLightRegistry();
  const registerSpy = vi.spyOn(real, 'register');
  const stubs = makeCommonStubs();
  const projectiles = new Map<string, { id: string; weaponType: number; x: number; y: number }>();
  if (opts.projectile) projectiles.set(opts.projectile.id, opts.projectile);
  const stateSync = {
    getEntities: vi.fn(() => ({ players: new Map(), projectiles })),
  } as unknown as StateSync;
  const handler = new AttackEventHandler(
    { value: 'me' },
    { x: 0, y: 0 },
    stubs.audio,
    stubs.entityRenderer,
    stubs.mapRenderer,
    stubs.playerRenderer,
    stubs.cameraService,
    stateSync,
    real,
  );
  return { handler, registry: real, registerSpy };
}

describe('ticket 09 / A3 — combat impact lighting end-to-end gates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('PlayerDamaged — melee-hit spark (the weapon-on-player hit)', () => {
    it('a melee_hit damage event registers a "melee" flash at the contact point', () => {
      const { handler, registerSpy } = makeDamageHandlerWithSpy({ brokenPlayer: undefined });
      const msg: DamageChannelMessage = {
        eventType: 'PlayerDamaged',
        playerId: 'p-victim',
        damage: 25,
        sourceId: 'p-attacker',
        sourceType: 1,
        damageType: DamageType.MELEE_HIT,
        knockbackX: 10,
        knockbackY: 0,
        killed: false,
        tick: 42,
        x: 500,
        y: 600,
      };

      handler.handle(msg);

      expect(registerSpy).toHaveBeenCalledTimes(1);
      const [x, y, kind] = registerSpy.mock.calls[0]!;
      expect(x).toBe(500); // contact point forwarded from the message.
      expect(y).toBe(600);
      expect(kind).toBe('melee');
    });

    it('registers for each weapon-hit damage type (melee/thrown/ranged/projectile)', () => {
      // The ticket scope: "Melee hit spark (ARC/LINE/THROWN connects on a
      // player)". The damage-type taxonomy gates this to the 4 weapon-hit types.
      for (const damageType of [
        DamageType.MELEE_HIT,
        DamageType.THROWN_HIT,
        DamageType.RANGED_HIT,
        DamageType.PROJECTILE_HIT,
      ]) {
        const { handler, registerSpy } = makeDamageHandlerWithSpy({ brokenPlayer: undefined });
        handler.handle({
          eventType: 'PlayerDamaged',
          playerId: 'p-victim',
          damage: 10,
          sourceId: 'p-attacker',
          sourceType: 1,
          damageType,
          knockbackX: 0,
          knockbackY: 0,
          killed: false,
          tick: 1,
          x: 10,
          y: 20,
        });
        expect(registerSpy, `damageType ${damageType}`).toHaveBeenCalledTimes(1);
        expect(registerSpy.mock.calls[0]![2]).toBe('melee');
      }
    });

    it('does NOT register for barrel_explosion (ExplosionLightRegistry covers blasts)', () => {
      const { handler, registerSpy } = makeDamageHandlerWithSpy({ brokenPlayer: undefined });
      handler.handle({
        eventType: 'PlayerDamaged',
        playerId: 'p-victim',
        damage: 50,
        sourceId: 'barrel',
        sourceType: 2, // EntityType.EXPLOSION
        damageType: DamageType.BARREL_EXPLOSION,
        knockbackX: 0,
        knockbackY: 0,
        killed: false,
        tick: 1,
        x: 10,
        y: 20,
      });
      expect(registerSpy).not.toHaveBeenCalled();
    });

    it('does NOT register for environmental/passive damage types (zone/sudden_death/siege/trap)', () => {
      // These damage types have no meaningful contact point / are not weapon
      // swings — gated out per the ticket's "ARC/LINE/THROWN connects on a
      // player" scope.
      for (const damageType of [
        DamageType.ZONE_DAMAGE,
        DamageType.SUDDEN_DEATH,
        DamageType.SIEGE_CRUSH,
        DamageType.TRAP_DAMAGE,
      ]) {
        const { handler, registerSpy } = makeDamageHandlerWithSpy({ brokenPlayer: undefined });
        handler.handle({
          eventType: 'PlayerDamaged',
          playerId: 'p-victim',
          damage: 10,
          sourceId: 'zone',
          sourceType: 0,
          damageType,
          knockbackX: 0,
          knockbackY: 0,
          killed: false,
          tick: 1,
          x: 10,
          y: 20,
        });
        expect(registerSpy, `damageType ${damageType}`).not.toHaveBeenCalled();
      }
    });

    it('does NOT register when impactLights is absent (older constructors keep working)', () => {
      // The registry is optional on the handler — non-lighting callers must not
      // break. Mirror of the explosion-light registry's optional discipline.
      const stubs = makeCommonStubs();
      const stateSync = {
        getPlayer: vi.fn(() => undefined),
        getEntities: vi.fn(() => ({ players: new Map(), projectiles: new Map() })),
      } as unknown as StateSync;
      const handler = new DamageEventHandler(
        { value: 'me' },
        { x: 0, y: 0 },
        stubs.audio,
        stubs.cameraService,
        stubs.damageNumbers,
        stubs.entityRenderer,
        stubs.playerRenderer,
        stateSync,
        // impactLights deliberately OMITTED.
      );
      expect(() =>
        handler.handle({
          eventType: 'PlayerDamaged',
          playerId: 'p-victim',
          damage: 10,
          sourceId: 'p-attacker',
          sourceType: 1,
          damageType: DamageType.MELEE_HIT,
          knockbackX: 0,
          knockbackY: 0,
          killed: false,
          tick: 1,
          x: 10,
          y: 20,
        }),
      ).not.toThrow();
    });
  });

  describe('ShieldBlocked — spark-white-blue flash at the clash point', () => {
    it('registers a "block" flash, preferring contactX/contactY (the swept-melee clash point)', () => {
      const { handler, registerSpy } = makeDamageHandlerWithSpy({ brokenPlayer: undefined });
      handler.handle({
        eventType: 'ShieldBlocked',
        playerId: 'p-defender',
        damageType: DamageType.MELEE_HIT,
        sourceId: 'p-attacker',
        x: 500, // defender position
        y: 600,
        contactX: 700, // the clash point (where the blade met the guard)
        contactY: 650,
        attackerWeaponType: WeaponType.LONG_SWORD,
        tick: 42,
      });

      expect(registerSpy).toHaveBeenCalledTimes(1);
      const [x, y, kind] = registerSpy.mock.calls[0]!;
      expect(kind).toBe('block');
      // Prefers the clash point, not the defender position.
      expect(x).toBe(700);
      expect(y).toBe(650);
    });

    it('falls back to defender x/y when contactX/contactY are absent', () => {
      const { handler, registerSpy } = makeDamageHandlerWithSpy({ brokenPlayer: undefined });
      handler.handle({
        eventType: 'ShieldBlocked',
        playerId: 'p-defender',
        damageType: DamageType.MELEE_HIT,
        sourceId: 'p-attacker',
        x: 500,
        y: 600,
        // contactX/contactY deliberately omitted.
        tick: 42,
      });

      expect(registerSpy).toHaveBeenCalledTimes(1);
      const [x, y, kind] = registerSpy.mock.calls[0]!;
      expect(kind).toBe('block');
      expect(x).toBe(500); // defender position fallback.
      expect(y).toBe(600);
    });
  });

  describe('WeaponBroken — warm-orange shatter flash at the weapon world pose', () => {
    it('registers a "break" flash at the captured weapon world pose', () => {
      // The break flash uses the SAME pre-hide weapon pose the shatter VFX uses
      // (getWeaponWorldState), so the light + particles coincide — matches the
      // user's "spark a light together with the particles" ruling.
      const weaponPose = { x: 333, y: 444, rotation: 1.5, tint: 0xff8800, scale: 0.7 };
      const { handler, registerSpy } = makeDamageHandlerWithSpy({
        brokenPlayer: { x: 100, y: 200, facingAngle: 0 },
        weaponWorldState: weaponPose,
      });
      handler.handle({
        eventType: 'WeaponBroken',
        playerId: 'p-broken',
        weaponType: WeaponType.LONG_SWORD,
        slotIndex: 0,
        x: 100, // message x/y (the broken player pos)
        y: 200,
        tick: 42,
      });

      expect(registerSpy).toHaveBeenCalledTimes(1);
      const [x, y, kind] = registerSpy.mock.calls[0]!;
      expect(kind).toBe('break');
      // Uses the weapon WORLD pose (333, 444), not the message x/y (100, 200).
      expect(x).toBe(333);
      expect(y).toBe(444);
    });

    it('falls back to the broken player position when getWeaponWorldState returns null', () => {
      // getWeaponWorldState returns null once the sprite is hidden; if the break
      // event arrives after the sprite is already hidden, the flash falls back
      // to the broken player's position (still a sensible contact point).
      const { handler, registerSpy } = makeDamageHandlerWithSpy({
        brokenPlayer: { x: 100, y: 200, facingAngle: 0 },
        weaponWorldState: null,
      });
      handler.handle({
        eventType: 'WeaponBroken',
        playerId: 'p-broken',
        weaponType: WeaponType.LONG_SWORD,
        slotIndex: 0,
        x: 100,
        y: 200,
        tick: 42,
      });

      expect(registerSpy).toHaveBeenCalledTimes(1);
      const [x, y, kind] = registerSpy.mock.calls[0]!;
      expect(kind).toBe('break');
      expect(x).toBe(100); // broken player position fallback.
      expect(y).toBe(200);
    });
  });

  describe('ProjectileDestroyed — arrow-impact flash (RANGED-only)', () => {
    it('a RANGED bolt (crossbow) impact registers a "projectile" flash', () => {
      // The wire ProjectileDestroyedMessage has NO weaponType/attackType — the
      // handler looks the projectile up in stateSync to read its weaponType +
      // resolves the AttackType. A crossbow bolt is RANGED → flash.
      const { handler, registerSpy } = makeAttackHandlerWithSpy({
        projectile: { id: 'proj-1', weaponType: WeaponType.CROSSBOW, x: 0, y: 0 },
      });
      const msg: ProjectileDestroyedMessage = {
        eventType: 'ProjectileDestroyed',
        projectileId: 'proj-1',
        x: 1500,
        y: 2000,
        hitTile: true,
        gridX: 3,
        gridY: 4,
        tick: 99,
      };

      handler.handle(msg as AttackChannelMessage);

      expect(registerSpy).toHaveBeenCalledTimes(1);
      const [x, y, kind] = registerSpy.mock.calls[0]!;
      expect(x).toBe(1500); // impact point forwarded from the message.
      expect(y).toBe(2000);
      expect(kind).toBe('projectile');
    });

    it('a short-bow arrow impact (also RANGED) registers a "projectile" flash', () => {
      // A3 §3: SHORT_BOW + CROSSBOW are the two RANGED weapons. Both glow.
      const { handler, registerSpy } = makeAttackHandlerWithSpy({
        projectile: { id: 'proj-bow', weaponType: WeaponType.SHORT_BOW, x: 0, y: 0 },
      });
      handler.handle({
        eventType: 'ProjectileDestroyed',
        projectileId: 'proj-bow',
        x: 100,
        y: 200,
        hitTile: false,
        gridX: 0,
        gridY: 0,
        tick: 1,
      } as AttackChannelMessage);

      expect(registerSpy).toHaveBeenCalledTimes(1);
      expect(registerSpy.mock.calls[0]![2]).toBe('projectile');
    });

    it('a THROWN axe impact emits NO flash (RANGED-only ruling)', () => {
      // A3 ruling: physical throws (THROWN/LINE/ARC) emit no traveling light AND
      // no impact flash — a stray spark disconnected from any streak would read
      // wrong. THROWING_AXE → AttackType.THROWN → gated out.
      const { handler, registerSpy } = makeAttackHandlerWithSpy({
        projectile: { id: 'proj-axe', weaponType: WeaponType.THROWING_AXE, x: 0, y: 0 },
      });
      handler.handle({
        eventType: 'ProjectileDestroyed',
        projectileId: 'proj-axe',
        x: 100,
        y: 200,
        hitTile: true,
        gridX: 0,
        gridY: 0,
        tick: 1,
      } as AttackChannelMessage);

      expect(registerSpy).not.toHaveBeenCalled();
    });

    it('a LINE spear impact emits NO flash (physical throw)', () => {
      // A3 §3: SPEAR/POLEARM/STAFF are LINE — physical throws, no flash.
      const { handler, registerSpy } = makeAttackHandlerWithSpy({
        projectile: { id: 'proj-spear', weaponType: WeaponType.SPEAR, x: 0, y: 0 },
      });
      handler.handle({
        eventType: 'ProjectileDestroyed',
        projectileId: 'proj-spear',
        x: 100,
        y: 200,
        hitTile: true,
        gridX: 0,
        gridY: 0,
        tick: 1,
      } as AttackChannelMessage);

      expect(registerSpy).not.toHaveBeenCalled();
    });

    it('an ARC dagger impact emits NO flash (physical throw)', () => {
      // A3 §3: DAGGER→DOUBLE_AXE are ARC — physical throws, no flash.
      const { handler, registerSpy } = makeAttackHandlerWithSpy({
        projectile: { id: 'proj-dagger', weaponType: WeaponType.DAGGER, x: 0, y: 0 },
      });
      handler.handle({
        eventType: 'ProjectileDestroyed',
        projectileId: 'proj-dagger',
        x: 100,
        y: 200,
        hitTile: true,
        gridX: 0,
        gridY: 0,
        tick: 1,
      } as AttackChannelMessage);

      expect(registerSpy).not.toHaveBeenCalled();
    });

    it('a despawned projectile (not in stateSync) emits NO flash (defensive)', () => {
      // The state patch + the event are separate channels; the projectile may
      // already be despawned by the time the message arrives. Better no flash
      // than a wrong-type flash — fall back to no registration.
      const { handler, registerSpy } = makeAttackHandlerWithSpy({ projectile: undefined });
      handler.handle({
        eventType: 'ProjectileDestroyed',
        projectileId: 'proj-gone',
        x: 100,
        y: 200,
        hitTile: true,
        gridX: 0,
        gridY: 0,
        tick: 1,
      } as AttackChannelMessage);

      expect(registerSpy).not.toHaveBeenCalled();
    });

    it('does NOT register when impactLights is absent (older constructors keep working)', () => {
      const stubs = makeCommonStubs();
      const stateSync = {
        getEntities: vi.fn(() => ({ players: new Map(), projectiles: new Map() })),
      } as unknown as StateSync;
      const handler = new AttackEventHandler(
        { value: 'me' },
        { x: 0, y: 0 },
        stubs.audio,
        stubs.entityRenderer,
        stubs.mapRenderer,
        stubs.playerRenderer,
        stubs.cameraService,
        stateSync,
        // impactLights deliberately OMITTED.
      );
      expect(() =>
        handler.handle({
          eventType: 'ProjectileDestroyed',
          projectileId: 'proj-1',
          x: 100,
          y: 200,
          hitTile: true,
          gridX: 0,
          gridY: 0,
          tick: 1,
        } as AttackChannelMessage),
      ).not.toThrow();
    });
  });

  describe('the four kinds are mutually exclusive (per-event-kind tinting)', () => {
    // The load-bearing fact: each event type registers a DISTINCT kind, so the
    // registry's per-kind tinting produces a distinct color per event. This is
    // the end-to-end proof of the AAA per-element principle applied to impact
    // color-coding.
    it('each event type registers its own distinct kind', () => {
      const kinds = new Set<ImpactLightKind>();

      // PlayerDamaged → melee
      const dmg = makeDamageHandlerWithSpy({ brokenPlayer: undefined });
      dmg.handler.handle({
        eventType: 'PlayerDamaged',
        playerId: 'p',
        damage: 10,
        sourceId: 'a',
        sourceType: 1,
        damageType: DamageType.MELEE_HIT,
        knockbackX: 0,
        knockbackY: 0,
        killed: false,
        tick: 1,
        x: 10,
        y: 20,
      });
      kinds.add(dmg.registerSpy.mock.calls[0]![2] as ImpactLightKind);

      // ShieldBlocked → block
      const block = makeDamageHandlerWithSpy({ brokenPlayer: undefined });
      block.handler.handle({
        eventType: 'ShieldBlocked',
        playerId: 'p',
        damageType: DamageType.MELEE_HIT,
        sourceId: 'a',
        x: 10,
        y: 20,
        tick: 1,
      });
      kinds.add(block.registerSpy.mock.calls[0]![2] as ImpactLightKind);

      // WeaponBroken → break
      const brk = makeDamageHandlerWithSpy({
        brokenPlayer: { x: 10, y: 20, facingAngle: 0 },
        weaponWorldState: null,
      });
      brk.handler.handle({
        eventType: 'WeaponBroken',
        playerId: 'p',
        weaponType: WeaponType.LONG_SWORD,
        slotIndex: 0,
        x: 10,
        y: 20,
        tick: 1,
      });
      kinds.add(brk.registerSpy.mock.calls[0]![2] as ImpactLightKind);

      // ProjectileDestroyed (RANGED) → projectile
      const proj = makeAttackHandlerWithSpy({
        projectile: { id: 'p1', weaponType: WeaponType.CROSSBOW, x: 0, y: 0 },
      });
      proj.handler.handle({
        eventType: 'ProjectileDestroyed',
        projectileId: 'p1',
        x: 10,
        y: 20,
        hitTile: true,
        gridX: 0,
        gridY: 0,
        tick: 1,
      } as AttackChannelMessage);
      kinds.add(proj.registerSpy.mock.calls[0]![2] as ImpactLightKind);

      // Four distinct kinds — one per event type.
      expect(kinds.size).toBe(4);
      expect([...kinds].sort()).toEqual(['block', 'break', 'melee', 'projectile']);
    });
  });
});
