import { describe, it, expect, beforeEach } from 'vitest';
import { PlayerStatus, WeaponType } from '@sector-battle/shared';
import type { DynamicLight } from '../LightPacker.js';
import { populateDynamicLights, computeAuraBreathingMul } from '../DynamicLightPopulator.js';
import { LIGHT_PRIORITY } from '../LightBudget.js';
import { HERO_LIGHT_OVERRIDES, resolveLightKind } from '../LightPalette.js';
import { cookieKeyToIndex } from '../LightPacker.js';
import { getProjectileLight, resolveAttackTypeForProjectile } from '../ProjectileLightTuning.js';
import type {
  ChestState,
  DestructibleState,
  PlayerState,
  ProjectileState,
  TrapState,
} from '../../../types.js';
import type { EntityMaps } from '../../../network/StateSync.js';
import type { DynamicLightPopulatorDeps } from '../DynamicLightPopulator.js';
import type { ExplosionLightRegistry } from '../ExplosionLightRegistry.js';
import type { LightingPipeline } from '../LightingPipeline.js';
import type { GameState } from '../../../controllers/GameState.js';
import type { StateSync } from '../../../network/StateSync.js';
import type { EntityInterpolator } from '../../../prediction/EntityInterpolator.js';
import type { PredictionService } from '../../../prediction/PredictionService.js';

/**
 * Ticket 18 — light-attribution Seam A.
 *
 * The populator's attribution is deterministic given the live entity fixture,
 * so we assert the three ticket-18 wiring facts:
 *   1. A static BARREL entity emits NO fire light (the steady-static-barrel
 *      loop was removed — only explosions create fire light).
 *   2. An UNOPENED chest emits a small warm steady glint (the motivated-loot
 *      wayfinding hint); an OPENED/looted chest emits nothing.
 *   3. A fire trap emits a fire-palette light ONLY while `fireAreaActive` is
 *      true; inactive → nothing.
 *
 * The populator is a pure transform of entity state → dynamic-light list (no
 * Phaser, no GPU), so this is a deterministic logic test. Cosmetic-only: the
 * glint is a readability hint, not a vision gate (GDD `docs/GDD.md:210`).
 */

/** A captured registered light + its priority tag. */
interface Captured {
  light: DynamicLight;
  priority: number;
}

/** Minimal fake pipeline that records every registered dynamic light. */
function makeFakePipeline(): LightingPipeline & { captured: Captured[] } {
  const captured: Captured[] = [];
  const fake = {
    beginDynamicLights() {
      captured.length = 0;
    },
    addDynamicLight(light: DynamicLight, priority: number) {
      captured.push({ light, priority });
    },
    captured,
  };
  return fake as unknown as LightingPipeline & { captured: Captured[] };
}

/** Empty EntityMaps (each test seeds only the collections it cares about). */
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

/** Build deps with the given entity maps + empty player/projectile/explosion paths. */
function makeDeps(entities: EntityMaps): DynamicLightPopulatorDeps {
  const stateSync = { getEntities: () => entities } as unknown as StateSync;
  const state = { myId: '__no_player__' } as unknown as GameState;
  // Interpolators/prediction never get queried because the fixture has no
  // players/projectiles — stub them to assert that if they WERE queried.
  const interpolator = {
    getInterpolatedPosition: () => {
      throw new Error('no players in fixture — interpolator must not be called');
    },
  } as unknown as EntityInterpolator;
  const projectileInterpolator = {
    getInterpolatedPosition: () => {
      throw new Error('no projectiles in fixture — interpolator must not be called');
    },
  } as unknown as EntityInterpolator;
  const predictionService = {
    getVisualPosition: () => {
      throw new Error('no local player in fixture — prediction must not be called');
    },
  } as unknown as PredictionService;
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

/**
 * Build deps whose projectile interpolator returns a controllable position for
 * the given projectile id (and reports it has a snapshot). Used by the
 * ticket-20 projectile tests. Player + prediction paths still throw (no players
 * in the projectile fixture).
 */
function makeDepsWithProjectiles(
  entities: EntityMaps,
  interpPosById: ReadonlyMap<string, { x: number; y: number }>,
): DynamicLightPopulatorDeps {
  const stateSync = { getEntities: () => entities } as unknown as StateSync;
  const state = { myId: '__no_player__' } as unknown as GameState;
  const interpolator = {
    getInterpolatedPosition: () => {
      throw new Error('no players in projectile fixture — interpolator must not be called');
    },
  } as unknown as EntityInterpolator;
  const projectileInterpolator = {
    getInterpolatedPosition: (id: string, out: { x: number; y: number }): boolean => {
      const pos = interpPosById.get(id);
      if (!pos) return false;
      out.x = pos.x;
      out.y = pos.y;
      return true;
    },
  } as unknown as EntityInterpolator;
  const predictionService = {
    getVisualPosition: () => {
      throw new Error('no local player in projectile fixture — prediction must not be called');
    },
  } as unknown as PredictionService;
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

/**
 * Build deps for the player-aura tests (ticket 22). The local player (id ===
 * myId) resolves its position via the prediction visual-position stub; remotes
 * resolve via the interpolator stub keyed by id. Projectile/explosion paths
 * stay inert (no projectiles/explosions in the player fixture).
 */
function makeDepsWithPlayers(
  entities: EntityMaps,
  myId: string,
  visualPos: { x: number; y: number },
  interpPosById: ReadonlyMap<string, { x: number; y: number }>,
): DynamicLightPopulatorDeps {
  const stateSync = { getEntities: () => entities } as unknown as StateSync;
  const state = { myId } as unknown as GameState;
  const interpolator = {
    getInterpolatedPosition: (id: string, out: { x: number; y: number }): boolean => {
      const pos = interpPosById.get(id);
      if (!pos) return false;
      out.x = pos.x;
      out.y = pos.y;
      return true;
    },
  } as unknown as EntityInterpolator;
  const projectileInterpolator = {
    getInterpolatedPosition: () => {
      throw new Error(
        'no projectiles in player fixture — projectile interpolator must not be called',
      );
    },
  } as unknown as EntityInterpolator;
  const predictionService = {
    getVisualPosition: () => visualPos,
  } as unknown as PredictionService;
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

/** A minimal ALIVE player at the given id/position (status defaults to ALIVE). */
function playerEntity(
  id: string,
  x: number,
  y: number,
  status: number = PlayerStatus.ALIVE,
): PlayerState {
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
    status,
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

/** A projectile with the given id/position/weaponType (bounces defaults to 0). */
function projectileEntity(
  id: string,
  x: number,
  y: number,
  weaponType: number,
  bounces = 0,
): ProjectileState {
  return {
    id,
    ownerId: 'owner',
    x,
    y,
    velocityX: 100,
    velocityY: 0,
    damage: 10,
    bounces,
    weaponType,
    tier: 0,
  };
}

/** A barrel-shaped destructible (type 1 = barrel per StateMapper typeMap). */
function barrelEntity(x: number, y: number, isDestroyed = false): DestructibleState {
  return {
    id: 'barrel-1',
    type: 1, // barrel
    hp: 50,
    maxHp: 50,
    x,
    y,
    isDestroyed,
    primed: false,
    fuseExpiresAtTick: 0,
    textureKey: 'barrel',
    rotation: 0,
    flipH: false,
    flipV: false,
  };
}

/** A crate-shaped destructible (type 0 = crate per StateMapper typeMap). */
function crateEntity(x: number, y: number): DestructibleState {
  return { ...barrelEntity(x, y), id: 'crate-1', type: 0 };
}

/** A chest with the given wire `state` (0=closed, 1=opening, 2=open). */
function chestEntity(x: number, y: number, state: number): ChestState {
  return {
    id: 'chest-1',
    tier: 0,
    x,
    y,
    state,
    openingPlayerId: '',
    openingProgress: 0,
    textureKey: 'chest',
    rotation: 0,
    flipH: false,
    flipV: false,
  };
}

/** A fire trap (type 1) with the given fireAreaActive flag. */
function fireTrapEntity(x: number, y: number, fireAreaActive: boolean): TrapState {
  return {
    id: 'trap-1',
    type: 1, // fire trap (EntityRendererTraps gates fire-area drawing on type === 1)
    x,
    y,
    isRevealed: true,
    cooldownRemaining: 0,
    textureKey: 'trap_fire',
    rotation: 0,
    flipH: false,
    flipV: false,
    fireAreaActive,
    fireAreaRemainingMs: 0,
  };
}

/** Convenience: find captured lights whose color matches the fire palette. */
const FIRE_COLOR = resolveLightKind('fire').color;
function fireLights(captured: Captured[]): Captured[] {
  return captured.filter(
    (c) =>
      c.light.color[0] === FIRE_COLOR[0] &&
      c.light.color[1] === FIRE_COLOR[1] &&
      c.light.color[2] === FIRE_COLOR[2],
  );
}

describe('DynamicLightPopulator — light attribution (ticket 18)', () => {
  let pipeline: LightingPipeline & { captured: Captured[] };

  beforeEach(() => {
    pipeline = makeFakePipeline();
  });

  describe('static barrels are INERT (the barrel-fire loop was removed)', () => {
    it('emits NO fire light for an alive barrel destructible', () => {
      const entities = emptyEntityMaps();
      entities.destructibles.set('barrel-1', barrelEntity(1000, 1000));
      populateDynamicLights(pipeline, makeDeps(entities), 0, 1.0);

      // No registered light at all on a barrel — the steady-static-barrel loop
      // is gone (the barrel EXPLOSION flash is a separate path via
      // ExplosionLightRegistry, not the populator).
      expect(pipeline.captured).toHaveLength(0);
    });

    it('emits NO fire light for a destroyed barrel either', () => {
      const entities = emptyEntityMaps();
      entities.destructibles.set('barrel-1', barrelEntity(1000, 1000, true));
      populateDynamicLights(pipeline, makeDeps(entities), 0, 1.0);
      expect(pipeline.captured).toHaveLength(0);
    });

    it('emits NO fire light for a crate destructible', () => {
      const entities = emptyEntityMaps();
      entities.destructibles.set('crate-1', crateEntity(1000, 1000));
      populateDynamicLights(pipeline, makeDeps(entities), 0, 1.0);
      expect(pipeline.captured).toHaveLength(0);
    });

    it('does not iterate destructibles for ANY steady light (a barrel among chests still glints only the chest)', () => {
      // One barrel + one chest: only the chest glints. The barrel contributes
      // nothing (proves the destructibles collection is no longer a light
      // source in the populator).
      const entities = emptyEntityMaps();
      entities.destructibles.set('barrel-1', barrelEntity(1000, 1000));
      entities.chests.set('chest-1', chestEntity(1100, 1100, 0));
      populateDynamicLights(pipeline, makeDeps(entities), 0, 1.0);
      expect(pipeline.captured).toHaveLength(1);
      expect(pipeline.captured[0]!.light.x).toBe(1100);
    });
  });

  describe('chest glint — small warm steady light on UNOPENED chests', () => {
    it('emits exactly one glint for a closed chest (state=0)', () => {
      const entities = emptyEntityMaps();
      entities.chests.set('chest-1', chestEntity(1500, 2000, 0));
      populateDynamicLights(pipeline, makeDeps(entities), 0, 1.0);

      expect(pipeline.captured).toHaveLength(1);
      const { light, priority } = pipeline.captured[0]!;
      expect(light.x).toBe(1500);
      expect(light.y).toBe(2000);
      // Steady (no flicker) — a treasure glint is not a flame.
      expect(light.flickerMul).toBe(1.0);
      // Warm gold tint (the inline CHEST_GLINT_COLOR).
      expect(light.color[0]).toBeGreaterThan(light.color[2]); // R > B (warm)
      expect(light.color[1]).toBeGreaterThan(light.color[2]); // G > B (gold)
      // Tagged STATIC priority (chests are static world loot, same tier as torches).
      expect(priority).toBe(LIGHT_PRIORITY.STATIC);
    });

    it('keeps the glint while a chest is OPENING (state=1) — loot still inside', () => {
      const entities = emptyEntityMaps();
      entities.chests.set('chest-1', chestEntity(0, 0, 1));
      populateDynamicLights(pipeline, makeDeps(entities), 0, 1.0);
      expect(pipeline.captured).toHaveLength(1);
    });

    it('skips the glint once a chest is OPEN/looted (state=2) — natural unregister', () => {
      const entities = emptyEntityMaps();
      entities.chests.set('chest-1', chestEntity(0, 0, 2));
      populateDynamicLights(pipeline, makeDeps(entities), 0, 1.0);
      expect(pipeline.captured).toHaveLength(0);
    });

    it('is deterministic — same chest fixture → same light values every frame', () => {
      const entities = emptyEntityMaps();
      entities.chests.set('chest-1', chestEntity(300, 400, 0));
      populateDynamicLights(pipeline, makeDeps(entities), 1000, 1.0);
      const first = { ...pipeline.captured[0]!.light };
      // Second frame at a different time — glint is steady, so values match.
      pipeline.captured.length = 0;
      populateDynamicLights(pipeline, makeDeps(entities), 5000, 1.0);
      const second = pipeline.captured[0]!.light;
      expect(second.x).toBe(first.x);
      expect(second.y).toBe(first.y);
      expect(second.radius).toBe(first.radius);
      expect(second.intensity).toBe(first.intensity);
      expect(second.color).toEqual(first.color);
      expect(second.flickerMul).toBe(first.flickerMul); // steady (1.0) both frames
    });
  });

  describe('fire-trap light — gated on fireAreaActive', () => {
    it('emits a fire-palette light when fireAreaActive is true', () => {
      const entities = emptyEntityMaps();
      entities.traps.set('trap-1', fireTrapEntity(800, 900, true));
      populateDynamicLights(pipeline, makeDeps(entities), 0, 1.0);

      expect(pipeline.captured).toHaveLength(1);
      const { light, priority } = pipeline.captured[0]!;
      expect(light.x).toBe(800);
      expect(light.y).toBe(900);
      // Fire palette color (hot red).
      expect(light.color[0]).toBe(FIRE_COLOR[0]);
      expect(light.color[1]).toBe(FIRE_COLOR[1]);
      expect(light.color[2]).toBe(FIRE_COLOR[2]);
      // Fire cookie (light_01).
      expect(light.cookieOn).toBe(cookieKeyToIndex('light_01'));
      // Flicker ON for an active fire (flickerMul < 1 at most phases).
      // Deterministic per-position seed, so just assert it's a real flame light
      // by checking the cookie + palette; flicker is exercised in TorchFlicker tests.
      expect(priority).toBe(LIGHT_PRIORITY.STATIC);
      // Sized to cover the full 3×3-tile fire area. The geometric patch radius
      // is 192 px (1.5 tiles); bumped ×1.6 → 307 px (2.4 tiles) so the falloff
      // reaches past the patch corners (181px out) — the whole 3×3 reads as
      // lit. Prior: ×1.2 (230px) left the corners dim.
      expect(light.radius).toBe(307);
    });

    it('emits NOTHING when fireAreaActive is false', () => {
      const entities = emptyEntityMaps();
      entities.traps.set('trap-1', fireTrapEntity(800, 900, false));
      populateDynamicLights(pipeline, makeDeps(entities), 0, 1.0);
      expect(pipeline.captured).toHaveLength(0);
    });

    it('toggles cleanly — emits on active frame, drops on the next inactive frame', () => {
      // Frame 1: active → one fire light.
      const activeEntities = emptyEntityMaps();
      activeEntities.traps.set('trap-1', fireTrapEntity(800, 900, true));
      populateDynamicLights(pipeline, makeDeps(activeEntities), 0, 1.0);
      expect(pipeline.captured).toHaveLength(1);
      expect(fireLights(pipeline.captured)).toHaveLength(1);

      // Frame 2: same trap goes inactive → zero lights (natural unregister).
      const inactiveEntities = emptyEntityMaps();
      inactiveEntities.traps.set('trap-1', fireTrapEntity(800, 900, false));
      populateDynamicLights(pipeline, makeDeps(inactiveEntities), 16, 1.0);
      expect(pipeline.captured).toHaveLength(0);
    });
  });

  describe('composition — all three rules hold in one populated fixture', () => {
    it('barrels dark + unopened chest glints + active fire trap lights + inactive trap dark', () => {
      const entities = emptyEntityMaps();
      // An alive barrel (must NOT emit).
      entities.destructibles.set('barrel-dark', barrelEntity(100, 100));
      // A looted chest (must NOT emit).
      entities.chests.set('chest-looted', chestEntity(200, 200, 2));
      // An unopened chest (MUST emit a glint).
      entities.chests.set('chest-loot', chestEntity(300, 300, 0));
      // An active fire trap (MUST emit fire light).
      entities.traps.set('trap-fire', fireTrapEntity(400, 400, true));
      // An inactive fire trap (must NOT emit).
      entities.traps.set('trap-cold', fireTrapEntity(500, 500, false));

      populateDynamicLights(pipeline, makeDeps(entities), 0, 1.0);

      // Exactly two lights: one chest glint + one fire-trap light.
      expect(pipeline.captured).toHaveLength(2);

      // No light at the barrel's position (100,100) or the looted chest (200,200)
      // or the inactive trap (500,500).
      const positions = pipeline.captured.map((c) => `${c.light.x},${c.light.y}`).sort();
      expect(positions).toEqual(['300,300', '400,400']);

      // Exactly one fire-palette light (the active trap) + one warm-gold glint.
      expect(fireLights(pipeline.captured)).toHaveLength(1);
    });
  });

  describe('projectile lights — per-AttackType character + streak trail (ticket 20)', () => {
    /**
     * Ticket 24: the trail buffer is now per-pipeline (WeakMap-keyed scratch
     * inside the populator, no longer a module-singleton). Each test gets a
     * fresh fake pipeline, so the trail starts empty per test. We still give
     * every projectile a UNIQUE id (defensive — preserves the historical
     * isolation discipline) + assert on the first frame's behavior (head + the
     * single just-recorded trail position). The pure ring-buffer semantics
     * (multi-frame streak, roll-off, prune) are covered exhaustively in
     * ProjectileLightTuning.test.ts.
     */

    it('a RANGED bolt (crossbow) emits the tiny hot near-white head light', () => {
      const entities = emptyEntityMaps();
      entities.projectiles.set(
        'proj-ranged',
        projectileEntity('proj-ranged', 1000, 1000, WeaponType.CROSSBOW, -1),
      );
      const interp = new Map([['proj-ranged', { x: 1000, y: 1000 }]]);
      populateDynamicLights(pipeline, makeDepsWithProjectiles(entities, interp), 0, 1.0);

      // First frame: head + 1 trail position (the just-recorded head). The
      // trail is established over frames; here we assert the head's character.
      expect(pipeline.captured.length).toBeGreaterThanOrEqual(1);
      const head = pipeline.captured[0]!.light;
      const expected = getProjectileLight(resolveAttackTypeForProjectile(WeaponType.CROSSBOW))!;
      expect(head.color).toEqual(expected.color);
      expect(head.radius).toBe(expected.radius);
      expect(head.intensity).toBe(expected.intensity);
      expect(head.cookieOn).toBe(expected.cookieOn);
      expect(head.flickerMul).toBe(1.0); // no flicker on projectiles.
      expect(head.x).toBe(1000);
      expect(head.y).toBe(1000);
      // Tagged PROJECTILE priority.
      expect(pipeline.captured[0]!.priority).toBe(LIGHT_PRIORITY.PROJECTILE);
    });

    it('a THROWN axe emits NO traveling light (ticket 09 — physical throws are inert)', () => {
      // Ticket 09 / A3 ruling: only RANGED (arrows) cast a traveling light.
      // Physical throws (THROWING_AXE → AttackType.THROWN) emit no head light AND
      // no trail — the populator's `tuning === null` check skips the whole block.
      const entities = emptyEntityMaps();
      entities.projectiles.set(
        'proj-thrown',
        projectileEntity('proj-thrown', 1000, 1000, WeaponType.THROWING_AXE, 2),
      );
      const interp = new Map([['proj-thrown', { x: 1000, y: 1000 }]]);
      populateDynamicLights(pipeline, makeDepsWithProjectiles(entities, interp), 0, 1.0);

      // THROWN now resolves to null — no projectile light emitted at all.
      expect(
        getProjectileLight(resolveAttackTypeForProjectile(WeaponType.THROWING_AXE)),
      ).toBeNull();
      expect(pipeline.captured).toHaveLength(0);
    });

    it('a LINE spear emits NO traveling light (ticket 09 — physical throws are inert)', () => {
      // A3 §3: SPEAR/POLEARM/STAFF are LINE AttackType, all physical throws.
      // Pre-ticket-09 LINE had a pale-gold entry; ticket 09 removed it.
      const entities = emptyEntityMaps();
      entities.projectiles.set(
        'proj-line',
        projectileEntity('proj-line', 1000, 1000, WeaponType.SPEAR),
      );
      const interp = new Map([['proj-line', { x: 1000, y: 1000 }]]);
      populateDynamicLights(pipeline, makeDepsWithProjectiles(entities, interp), 0, 1.0);

      expect(getProjectileLight(resolveAttackTypeForProjectile(WeaponType.SPEAR))).toBeNull();
      expect(pipeline.captured).toHaveLength(0);
    });

    it('trail AUTO-GATES to RANGED-only (no trail on a physical throw)', () => {
      // Ticket 09 acceptance: the trail is emitted inside the same
      // `tuning === null` block as the head, so a physical throw skips BOTH.
      // Asserted explicitly here because the trail auto-gate is a load-bearing
      // acceptance criterion ("the RANGED-only narrowing must auto-gate the
      // trail"). Two frames of a THROWING_AXE → zero lights both frames.
      const entities = emptyEntityMaps();
      entities.projectiles.set(
        'proj-thrown-trail',
        projectileEntity('proj-thrown-trail', 1000, 1000, WeaponType.THROWING_AXE, 2),
      );
      const interp1 = new Map([['proj-thrown-trail', { x: 1000, y: 1000 }]]);
      populateDynamicLights(pipeline, makeDepsWithProjectiles(entities, interp1), 0, 1.0);
      expect(pipeline.captured).toHaveLength(0);
      // Frame 2: head moves — a trail WOULD appear for a RANGED bolt, but a
      // physical throw skips the whole block (no head, no trail).
      const interp2 = new Map([['proj-thrown-trail', { x: 1100, y: 1000 }]]);
      populateDynamicLights(pipeline, makeDepsWithProjectiles(entities, interp2), 16, 1.0);
      expect(pipeline.captured).toHaveLength(0);
    });

    it('a SHIELD projectile emits NO traveling light (melee pulse, not a disk)', () => {
      // SHIELD bashes do not spawn a projectile server-side, but if a
      // SHIELD-affinity projectile somehow appeared it must skip the light.
      const entities = emptyEntityMaps();
      entities.projectiles.set(
        'proj-shield',
        projectileEntity('proj-shield', 1000, 1000, WeaponType.SMALL_SHIELD),
      );
      const interp = new Map([['proj-shield', { x: 1000, y: 1000 }]]);
      populateDynamicLights(pipeline, makeDepsWithProjectiles(entities, interp), 0, 1.0);

      expect(pipeline.captured).toHaveLength(0);
    });

    it('emits a streak trail — a second light at the past position, dimmer than the head', () => {
      // Two frames: frame 1 records the head position; frame 2 records a new
      // head position, so the trail now holds the frame-1 position. The frame-2
      // output is head (frame-2 pos) + trail (frame-1 pos, dimmed).
      const entities = emptyEntityMaps();
      const projectile = projectileEntity('proj-trail', 1000, 1000, WeaponType.CROSSBOW, -1);
      entities.projectiles.set('proj-trail', projectile);

      // Frame 1: head at (1000,1000).
      const interp1 = new Map([['proj-trail', { x: 1000, y: 1000 }]]);
      populateDynamicLights(pipeline, makeDepsWithProjectiles(entities, interp1), 0, 1.0);
      const frame1Count = pipeline.captured.length;
      expect(frame1Count).toBeGreaterThanOrEqual(1); // at least the head.

      // Frame 2: head moves to (1100,1000). Trail now holds the frame-1 pos.
      const interp2 = new Map([['proj-trail', { x: 1100, y: 1000 }]]);
      populateDynamicLights(pipeline, makeDepsWithProjectiles(entities, interp2), 16, 1.0);

      // Head at the new position + a trail light at the old position.
      const atNew = pipeline.captured.filter((c) => c.light.x === 1100);
      const atOld = pipeline.captured.filter((c) => c.light.x === 1000);
      expect(atNew.length).toBeGreaterThanOrEqual(1); // the head.
      expect(atOld.length).toBeGreaterThanOrEqual(1); // the trail light.

      // The trail light is dimmer than the head (same tuning, lower intensity).
      const headLight = atNew[0]!.light;
      const trailLight = atOld[0]!.light;
      const tuning = getProjectileLight(resolveAttackTypeForProjectile(WeaponType.CROSSBOW))!;
      expect(headLight.intensity).toBe(tuning.intensity); // full intensity.
      expect(trailLight.intensity).toBeLessThan(tuning.intensity); // dimmed.
      // Same color/cookie as the head (a streak, not a different light).
      expect(trailLight.color).toEqual(tuning.color);
      expect(trailLight.cookieOn).toBe(tuning.cookieOn);
      // Trail tagged PROJECTILE priority too.
      expect(atOld[0]!.priority).toBe(LIGHT_PRIORITY.PROJECTILE);
    });

    it('does NOT flicker (steady glow + trail — matches the existing spec)', () => {
      // Ticket 09: use a RANGED bolt so the projectile actually emits a light
      // (THROWING_AXE is inert under the RANGED-only ruling; the loop would be
      // vacuous). A crossbow bolt is the surviving traveling-light case.
      const entities = emptyEntityMaps();
      entities.projectiles.set(
        'proj-noflicker',
        projectileEntity('proj-noflicker', 1000, 1000, WeaponType.CROSSBOW, -1),
      );
      const interp = new Map([['proj-noflicker', { x: 1000, y: 1000 }]]);
      populateDynamicLights(pipeline, makeDepsWithProjectiles(entities, interp), 0, 1.0);
      expect(pipeline.captured.length).toBeGreaterThanOrEqual(1);
      for (const c of pipeline.captured) {
        expect(c.light.flickerMul).toBe(1.0);
      }
    });

    it('falls back to the wire position when the interpolator has no snapshot', () => {
      // First frame after spawn: interpolator returns false (no snapshot yet).
      // The populator falls back to p.x/p.y so the projectile glows at spawn
      // rather than being dropped.
      const entities = emptyEntityMaps();
      entities.projectiles.set(
        'proj-spawn',
        projectileEntity('proj-spawn', 7777, 8888, WeaponType.CROSSBOW, -1),
      );
      const interp = new Map(); // no snapshot for 'proj-spawn' → returns false.
      populateDynamicLights(pipeline, makeDepsWithProjectiles(entities, interp), 0, 1.0);
      const head = pipeline.captured[0]!.light;
      expect(head.x).toBe(7777);
      expect(head.y).toBe(8888);
    });

    it('the bounces<0 arrow heuristic is RETIRED — discrimination is by AttackType', () => {
      // Pre-ticket-20: bounces<0 → ARROW_LIGHT, else THROWN_LIGHT. Now the
      // AttackType is resolved from weaponType. A CROSSBOW bolt (bounces -1)
      // and a THROWING_AXE (bounces 2) are discriminated by weaponType, NOT by
      // the bounces sign. Prove the heuristic no longer drives tuning: give the
      // crossbow bolt bounces=5 (heuristic would call it "thrown") and it STILL
      // resolves to RANGED (crossbow) tuning. Ticket 09: THROWING_AXE now emits
      // no light at all (RANGED-only), but the crossbow still glows regardless
      // of bounces sign.
      const entities = emptyEntityMaps();
      entities.projectiles.set(
        'proj-bounces-positive-crossbow',
        projectileEntity('proj-bounces-positive-crossbow', 1000, 1000, WeaponType.CROSSBOW, 5),
      );
      const interp = new Map([['proj-bounces-positive-crossbow', { x: 1000, y: 1000 }]]);
      populateDynamicLights(pipeline, makeDepsWithProjectiles(entities, interp), 0, 1.0);
      expect(pipeline.captured.length).toBeGreaterThanOrEqual(1);
      const head = pipeline.captured[0]!.light;
      const rangedTuning = getProjectileLight(resolveAttackTypeForProjectile(WeaponType.CROSSBOW))!;
      expect(head.color).toEqual(rangedTuning.color); // RANGED, not THROWN.
      expect(head.radius).toBe(rangedTuning.radius);
    });

    it('unknown weaponType emits NO light (ticket 09 — fallback THROWN is now inert)', () => {
      // Pre-ticket-09: unknown weaponType fell back to THROWN, which glowed warm.
      // Ticket 09: THROWN is null under the RANGED-only ruling, so an unknown
      // weaponType resolves to null — no surprise glow on a mystery weapon.
      const entities = emptyEntityMaps();
      entities.projectiles.set('proj-unknown', projectileEntity('proj-unknown', 1000, 1000, 99999));
      const interp = new Map([['proj-unknown', { x: 1000, y: 1000 }]]);
      populateDynamicLights(pipeline, makeDepsWithProjectiles(entities, interp), 0, 1.0);
      // Fallback AttackType (THROWN) → null light → skip (no head, no trail).
      expect(getProjectileLight(resolveAttackTypeForProjectile(99999))).toBeNull();
      expect(pipeline.captured).toHaveLength(0);
    });
  });

  describe('player aura — LOCAL = REMOTE (ticket 07 removed ticket 22 local branch)', () => {
    /**
     * Ticket 07 (A2): LOCAL = REMOTE (identical). Ticket 22's local-vs-remote
     * aura branch (×1.2 intensity + 35% warm blend toward amber) was REMOVED
     * per user ruling ("local = remote"). Both players now resolve to the same
     * AURA_HERO values + the same AURA_PALETTE.
     *
     * C2 (lighting-system-3, user ruling 2026-08-07) — tone + radius retune on
     * top of ticket 07:
     *   - color: cool [0.40,0.68,1.0] → soft warm-white [1.0,0.95,0.88]
     *   - cookieKey: light_02 (cool) → light_01 (warm)
     *   - radius: 256 → 512 (user ruling "2x bigger")
     *   - intensity: 1.2 — UNCHANGED (user said the OLD aura was too bright)
     *   - corePower 2.5 / haloFrac 0.85 — UNCHANGED (C2 fixes tone + size, not diffuseness)
     * See LightPalette.test.ts for the focused C2 regression guard.
     *
     * A/B BASELINE (ticket 22's removed values — recorded per REVIEW item B1,
     * do not silently reverse prior ACCEPTED work):
     *   - AURA_LOCAL_INTENSITY_MUL = 1.2  (local 1.9 → ~2.28; remote 1.9)
     *   - AURA_LOCAL_COLOR = cool aura 35% toward [0.62,0.55,0.42] = [0.479,0.6395,0.879]
     *   - radius/corePower/haloFrac/specPower/cookie WERE identical (kept identical)
     * Ticket 07 also retuned the shared values (radius 160→256, intensity 1.9→1.2,
     * corePower 3.5→2.5, haloFrac 0.7→0.85) — see LightPalette.ts.
     */
    const AURA_HERO = HERO_LIGHT_OVERRIDES.aura!;
    const AURA_PALETTE = resolveLightKind('aura');

    it('emits one aura per alive player, tagged PLAYER priority', () => {
      const entities = emptyEntityMaps();
      entities.players.set('local', playerEntity('local', 1000, 1000));
      entities.players.set('remote-1', playerEntity('remote-1', 1300, 1000));
      entities.players.set('remote-2', playerEntity('remote-2', 1600, 1000));
      const interp = new Map([
        ['remote-1', { x: 1300, y: 1000 }],
        ['remote-2', { x: 1600, y: 1000 }],
      ]);
      populateDynamicLights(
        pipeline,
        makeDepsWithPlayers(entities, 'local', { x: 1000, y: 1000 }, interp),
        0,
        1.0,
      );

      expect(pipeline.captured).toHaveLength(3);
      for (const c of pipeline.captured) {
        expect(c.priority).toBe(LIGHT_PRIORITY.PLAYER);
        // C2: radius 512 (was 256 ticket-07 / 160 verbatim), cookie light_01
        // (was light_02 — flipped to warm to match the new tone) —
        // IDENTICAL for local + remote (the local-vs-remote branch is gone).
        expect(c.light.radius).toBe(AURA_HERO.radius); // 640 (D2fix: +25% on C2's 512)
        expect(c.light.cookieOn).toBe(cookieKeyToIndex('light_01')); // 1 (C2: was light_02/2)
        // C7 (lighting-system-3): the aura now BREATHES — flickerMul is a slow
        // ±6% pulse, no longer the constant 1.0. The populator computes it via
        // computeAuraBreathingMul(nowMs/1000, id); at nowMs=0 the value is
        // 1 + 0.06*sin(hashPlayerIdPhase(id)) (per-player phase → distinct per
        // player). Assert each aura matches its deterministic breathing value
        // + stays within the ±6% band (subtle, never a strobe). The dedicated
        // breathing-regression suite is C7AuraBreathingFlicker.test.ts.
        const idByX = new Map([
          [1000, 'local'],
          [1300, 'remote-1'],
          [1600, 'remote-2'],
        ]);
        const id = idByX.get(c.light.x)!;
        expect(c.light.flickerMul).toBeCloseTo(computeAuraBreathingMul(0, id), 10);
        expect(c.light.flickerMul).toBeGreaterThanOrEqual(0.94);
        expect(c.light.flickerMul).toBeLessThanOrEqual(1.06);
      }
    });

    it('LOCAL aura is IDENTICAL to REMOTE (ticket 22 local-boost removed)', () => {
      // The load-bearing ticket-07 assertion: local = remote. Same intensity,
      // same color, same radius — no ×1.2 boost, no warm blend.
      const entities = emptyEntityMaps();
      entities.players.set('local', playerEntity('local', 1000, 1000));
      entities.players.set('remote', playerEntity('remote', 2000, 1000));
      const interp = new Map([['remote', { x: 2000, y: 1000 }]]);
      populateDynamicLights(
        pipeline,
        makeDepsWithPlayers(entities, 'local', { x: 1000, y: 1000 }, interp),
        0,
        1.0,
      );

      const byX = new Map(pipeline.captured.map((c) => [c.light.x, c.light]));
      const local = byX.get(1000)!;
      const remote = byX.get(2000)!;

      // IDENTICAL intensity (ticket 07: 1.2, was local ~2.28 / remote 1.9).
      expect(local.intensity).toBeCloseTo(AURA_HERO.intensity, 5); // 1.2
      expect(remote.intensity).toBeCloseTo(AURA_HERO.intensity, 5); // 1.2
      expect(local.intensity).toBe(remote.intensity); // local = remote

      // IDENTICAL color (the soft warm-white aura palette — no blend on local).
      expect(local.color).toEqual(remote.color);
      expect(local.color).toEqual([...AURA_PALETTE.color]);
    });

    it('the aura uses the C2 widened + ticket-07 softened values (512px / 1.2 / corePower 2.5 / haloFrac 0.85 / warm-white)', () => {
      // Pins C2 (lighting-system-3) on top of the ticket-07 retune:
      //   C2: color [0.4,0.68,1.0] (cool) → [1.0,0.95,0.88] (soft warm-white)
      //   C2: radius 256 → 512 (user ruling "2x bigger")
      //   C2: cookieKey light_02 → light_01 (warm cookie matches the new tone)
      //   ticket-07 (unchanged by C2): intensity 1.9→1.2, corePower 3.5→2.5,
      //   haloFrac 0.7→0.85 (the diffuseness character was correct — C2 fixes
      //   tone + size, NOT diffuseness).
      const entities = emptyEntityMaps();
      entities.players.set('remote', playerEntity('remote', 500, 500));
      const interp = new Map([['remote', { x: 500, y: 500 }]]);
      populateDynamicLights(
        pipeline,
        makeDepsWithPlayers(entities, '__not_the_remote__', { x: 0, y: 0 }, interp),
        0,
        1.0,
      );
      expect(pipeline.captured).toHaveLength(1);
      const aura = pipeline.captured[0]!.light;
      expect(aura.intensity).toBeCloseTo(0.6, 5); // D2fix 1.2→0.7; lighting-mood 0.7→0.6 (tone-down a bit)
      expect(aura.radius).toBe(640); // D2fix: +25% on C2's 512 (was 256 ticket-07, 160 verbatim)
      expect(aura.color).toEqual([1.0, 0.95, 0.88]); // C2: was [0.4, 0.68, 1.0] (cool)
      expect(aura.corePower).toBe(2.0); // D2fix: was 2.5 — flatter core (user: center too bright)
      expect(aura.haloFrac).toBe(0.85); // was 0.7 — UNCHANGED by C2
    });

    it('skips dead/dying/spectating players (no aura on a corpse) — local + remote', () => {
      const entities = emptyEntityMaps();
      entities.players.set('local-dead', playerEntity('local', 1000, 1000, PlayerStatus.DEAD));
      entities.players.set('r-dying', playerEntity('r-dying', 1100, 1000, PlayerStatus.DYING));
      entities.players.set('r-spec', playerEntity('r-spec', 1200, 1000, PlayerStatus.SPECTATING));
      entities.players.set('r-alive', playerEntity('r-alive', 1300, 1000, PlayerStatus.ALIVE));
      const interp = new Map([
        ['r-dying', { x: 1100, y: 1000 }],
        ['r-spec', { x: 1200, y: 1000 }],
        ['r-alive', { x: 1300, y: 1000 }],
      ]);
      populateDynamicLights(
        pipeline,
        makeDepsWithPlayers(entities, 'local-dead', { x: 1000, y: 1000 }, interp),
        0,
        1.0,
      );
      // Only the one alive remote gets an aura; the dead/dying/spectating
      // players (including the local corpse) are skipped.
      expect(pipeline.captured).toHaveLength(1);
      expect(pipeline.captured[0]!.light.x).toBe(1300);
    });
  });

  describe('zero-allocation hot path (B4 H5)', () => {
    it('reuses the same color array reference for the cloned light across frames (pool reuse)', () => {
      // B4 perf regression H5: the scratch light's color field was previously
      // reassigned a fresh `[a,b,c]` literal on every emit (4 sites), allocating
      // a transient tuple ~64+ times/frame at 64 players that immediately became
      // garbage when cloneLight copied it into the pooled entry. The fix writes
      // the color channels in place. The observable zero-alloc contract is that
      // the POOLED clone's color array keeps the same reference across frames
      // using the same pool (the two pools alternate every frame, so frames N
      // and N+2 share pool A). If the pool were bypassed or the scratch leaked,
      // this reference-equality would break.
      const entities = emptyEntityMaps();
      entities.chests.set('chest-1', chestEntity(1500, 2000, 0));

      // Frame 0 — pool A active (clonePoolFlip starts false → first call flips
      // to true, so pool A is used on the first populate).
      populateDynamicLights(pipeline, makeDeps(entities), 0, 1.0);
      expect(pipeline.captured).toHaveLength(1);
      const colorRefFrame0 = pipeline.captured[0]!.light.color;

      // Frame 1 — pool B active (flip toggled). Different ref expected.
      populateDynamicLights(pipeline, makeDeps(entities), 16, 1.0);
      expect(pipeline.captured[0]!.light.color).not.toBe(colorRefFrame0);

      // Frame 2 — pool A active again. SAME ref as frame 0 (pool reuse).
      populateDynamicLights(pipeline, makeDeps(entities), 32, 1.0);
      expect(pipeline.captured[0]!.light.color).toBe(colorRefFrame0);
    });
  });
});
