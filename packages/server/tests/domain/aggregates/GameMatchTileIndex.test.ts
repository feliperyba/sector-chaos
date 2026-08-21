import { describe, it, expect } from 'vitest';
import {
  TileType,
  WeaponTier,
  WeaponType,
  ChestRarity,
  TrapType,
  SeededRNG,
  type GameConfig,
  type SpawnPoint,
} from '@sector-battle/shared';
import { GameMatch } from '../../../src/domain/aggregates/GameMatch.ts';
import { WeaponEntity } from '../../../src/domain/entities/Weapon.ts';
import { Destructible } from '../../../src/domain/entities/Destructible.ts';
import { Chest } from '../../../src/domain/entities/Chest.ts';
import { Trap } from '../../../src/domain/entities/Trap.ts';
import { PowerUp } from '../../../src/domain/entities/PowerUp.ts';
import { Position } from '../../../src/domain/value-objects/Position.ts';
import {
  createMatchServices,
  createMatchPools,
} from '../../../src/domain/aggregates/createMatchServices.ts';

/**
 * siege-tile-index (perf-arc-neo ticket 09) — order-preservation proof for
 * the tile-keyed entity index backing find*AtTile.
 *
 * ADD/REMOVE SITE ENUMERATION (the paths under test — see also the header of
 * src/domain/aggregates/GameMatchTileIndex.ts):
 *   indexed adds    — EntityOps addWeaponPickup / addPowerUp / addTrap /
 *                     addChest / addDestructible (via match.add*) and
 *                     hydrateMatchEntities' direct sets (via match.hydrateEntities)
 *   indexed removes — EntityOps removeWeaponPickup(+ById) / removePowerUpById /
 *                     removeTrapById / removeChest(+ById) (via match.remove*)
 *   hooked removes  — destroyDestructibleAction (match.destroyDestructible)
 *                     and the BarrelExplosionManager chain delete
 *                     (match.triggerBarrelExplosion)
 *   defense-in-depth — an UNHOOKED direct map delete must also stay safe
 *                     (lookup-side validation skips the stale bucket entry)
 *
 * The oracle below is the OLD implementation verbatim (full-map linear scan,
 * first match in Map iteration order, same isDestroyed/isActive skips). The
 * indexed lookups must agree with it after every operation.
 */

const TILE = 64; // matches createTestConfig below
const TILE_KEY_STRIDE = 100000; // mirrors GameMatchTileIndex.TILE_KEY_STRIDE

function createTestConfig(): GameConfig {
  return {
    player: {
      baseSpeed: 200,
      dashSpeedMultiplier: 2.0,
      dashDuration: 0.5,
      dashCooldown: 3.0,
      baseHealth: 100,
      maxHealth: 100,
      inventorySize: 4,
      hitboxWidth: 96,
      hitboxHeight: 96,
    },
    weapons: [],
    zone: {
      totalDuration: 36000,
      transitionDuration: 1800,
      tickInterval: 30,
      warningTime: 1800,
      phases: [],
    },
    match: {
      targetDuration: 36000,
      maxPlayers: 16,
      minPlayers: 2,
      countdownDuration: 300,
      overtimeStart: 36000,
    },
    map: {
      tileWidth: TILE,
      tileHeight: TILE,
      arenaWidth: 640,
      arenaHeight: 640,
      sectorSize: 320,
      corridorWidth: 2,
      destructibleDensity: 0.3,
      chestDensity: 0.1,
      exitCount: 1,
    },
    combat: {
      knockbackForce: 200,
      knockbackDecay: 0.9,
      throwRange: 300,
      bounceFactor: 0.5,
      maxBounces: 3,
      projectileSpeed: 400,
      friendlyFire: true,
    },
    network: {
      tickRate: 60,
      patchRate: 50,
      maxLatency: 200,
      inputBufferSize: 120,
      snapshotInterval: 0,
    },
  };
}

function makeGrid(rows: number, cols: number, fill: TileType): TileType[][] {
  return Array.from({ length: rows }, () => Array.from({ length: cols }, () => fill));
}

function createMatch(): GameMatch {
  const grid = makeGrid(10, 10, TileType.EMPTY);
  const spawnPoints: SpawnPoint[] = [
    { x: 64, y: 64, sectorCoord: { row: 0, col: 0 }, priority: 0 },
  ];
  const config = createTestConfig();
  return new GameMatch(
    'tile-index-test',
    config,
    grid,
    spawnPoints,
    createMatchServices(config),
    createMatchPools(),
    new SeededRNG(12345),
  );
}

function tileCenter(gx: number, gy: number): Position {
  return new Position(gx * TILE + TILE / 2, gy * TILE + TILE / 2);
}

function dagger(id: string): WeaponEntity {
  return new WeaponEntity(id, WeaponType.DAGGER, WeaponTier.COMMON, 10, 10, 30);
}

// ─── Oracle: the OLD linear scans, verbatim semantics ───────────────────────

function oracleDestructible(match: GameMatch, gx: number, gy: number): string | null {
  for (const [id, d] of match.destructibles) {
    if (d.isDestroyed) continue;
    if (Math.floor(d.position.x / TILE) === gx && Math.floor(d.position.y / TILE) === gy) return id;
  }
  return null;
}

function oracleChest(match: GameMatch, gx: number, gy: number): string | null {
  for (const [id, c] of match.chests) {
    if (Math.floor(c.position.x / TILE) === gx && Math.floor(c.position.y / TILE) === gy) return id;
  }
  return null;
}

function oracleWeaponPickup(match: GameMatch, gx: number, gy: number): string | null {
  for (const [id, wp] of match.weaponPickups) {
    if (!wp.isActive) continue;
    if (Math.floor(wp.position.x / TILE) === gx && Math.floor(wp.position.y / TILE) === gy) {
      return id;
    }
  }
  return null;
}

function oraclePowerUp(match: GameMatch, gx: number, gy: number): string | null {
  for (const [id, pu] of match.powerUps) {
    if (!pu.isActive) continue;
    if (Math.floor(pu.position.x / TILE) === gx && Math.floor(pu.position.y / TILE) === gy) {
      return id;
    }
  }
  return null;
}

function oracleTrap(match: GameMatch, gx: number, gy: number): string | null {
  for (const [id, t] of match.traps) {
    if (Math.floor(t.position.x / TILE) === gx && Math.floor(t.position.y / TILE) === gy) return id;
  }
  return null;
}

function assertParity(match: GameMatch, ctx: string): void {
  for (let gy = 0; gy <= 4; gy++) {
    for (let gx = 0; gx <= 4; gx++) {
      expect(match.findDestructibleAtTile(gx, gy), `${ctx} destructible (${gx},${gy})`).toBe(
        oracleDestructible(match, gx, gy),
      );
      expect(match.findChestAtTile(gx, gy), `${ctx} chest (${gx},${gy})`).toBe(
        oracleChest(match, gx, gy),
      );
      expect(match.findWeaponPickupAtTile(gx, gy), `${ctx} weaponPickup (${gx},${gy})`).toBe(
        oracleWeaponPickup(match, gx, gy),
      );
      expect(match.findPowerUpAtTile(gx, gy), `${ctx} powerUp (${gx},${gy})`).toBe(
        oraclePowerUp(match, gx, gy),
      );
      expect(match.findTrapAtTile(gx, gy), `${ctx} trap (${gx},${gy})`).toBe(
        oracleTrap(match, gx, gy),
      );
    }
  }
}

// ─── Deterministic storm RNG (LCG — reproducible op sequence) ────────────────

const STORM_SEED = 0x1234abcd;
function makeRng(): () => number {
  let s = STORM_SEED;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function pick<T>(rng: () => number, items: T[]): T | undefined {
  return items.length > 0 ? items[Math.floor(rng() * items.length)] : undefined;
}

describe('GameMatchTileIndex (siege-tile-index order preservation)', () => {
  it('find*AtTile matches the linear-scan oracle after every op of a seeded add/remove/deactivate/destroy storm', () => {
    const match = createMatch();
    const rng = makeRng();
    const counters = { d: 0, c: 0, wp: 0, pu: 0, t: 0 };
    // Tiles 1..3 on both axes — a tight cluster forces multi-occupant tiles,
    // exercising the insertion-order tie-break.
    const tile = () => 1 + Math.floor(rng() * 3);

    for (let op = 0; op < 800; op++) {
      const roll = rng();
      if (roll < 0.42) {
        // Adds through every indexed add site.
        const kind = Math.floor(rng() * 5);
        if (kind === 0) {
          match.addDestructible(
            Destructible.create(
              `d-${counters.d++}`,
              rng() < 0.3 ? 'wall' : 'crate',
              tileCenter(tile(), tile()),
            ),
          );
        } else if (kind === 1) {
          match.addChest(
            Chest.create(`c-${counters.c++}`, ChestRarity.COMMON, tileCenter(tile(), tile())),
          );
        } else if (kind === 2) {
          const id = `wp-${counters.wp++}`;
          match.addWeaponPickup(id, dagger(id), tileCenter(tile(), tile()));
        } else if (kind === 3) {
          match.addPowerUp(
            PowerUp.create(`pu-${counters.pu++}`, 'health_pack', tileCenter(tile(), tile()), 0),
          );
        } else {
          match.addTrap(
            Trap.create(`t-${counters.t++}`, TrapType.SPIKE, tileCenter(tile(), tile())),
          );
        }
      } else if (roll < 0.72) {
        // Removes — alternate the twin chest/weaponPickup function variants.
        const kind = Math.floor(rng() * 5);
        if (kind === 0) {
          const id = pick(rng, Array.from(match.destructibles.keys()));
          if (id) match.destroyDestructible(id);
        } else if (kind === 1) {
          const id = pick(rng, Array.from(match.chests.keys()));
          if (id) {
            if (rng() < 0.5) match.removeChestById(id);
            else match.removeChest(id);
          }
        } else if (kind === 2) {
          const id = pick(rng, Array.from(match.weaponPickups.keys()));
          if (id) {
            if (rng() < 0.5) match.removeWeaponPickup(id);
            else match.removeWeaponPickupById(id);
          }
        } else if (kind === 3) {
          const id = pick(rng, Array.from(match.powerUps.keys()));
          if (id) match.removePowerUpById(id);
        } else {
          const id = pick(rng, Array.from(match.traps.keys()));
          if (id) match.removeTrapById(id);
        }
      } else if (roll < 0.82) {
        // Deactivate (flag flip, entity stays in the map) — both paths skip.
        if (rng() < 0.5) {
          const live = Array.from(match.weaponPickups.values()).filter((wp) => wp.isActive);
          pick(rng, live)?.deactivate();
        } else {
          const live = Array.from(match.powerUps.values()).filter((pu) => pu.isActive);
          pick(rng, live)?.deactivate();
        }
      } else if (roll < 0.92) {
        // isDestroyed WITHOUT map delete (chain-source-barrel mirror) — the
        // entity stays in the map and the bucket; both paths must skip it.
        const live = Array.from(match.destructibles.values()).filter((d) => !d.isDestroyed);
        pick(rng, live)?.takeDamage({ source: 'melee', rawDamage: 99, currentTick: op });
      } else {
        // UNHOOKED direct map delete — defense-in-depth: the stale bucket
        // entry must be skipped by lookup-side validation (no production site
        // does this anymore; this proves the safety net anyway).
        const id = pick(rng, Array.from(match.destructibles.keys()));
        if (id) match.destructibles.delete(id);
      }
      assertParity(match, `op ${op}`);
    }

    // No false misses for the fully-indexed kinds: every live member is still
    // in its tile bucket (parity above already proves correct selection).
    for (const [id, t] of match.traps) {
      const g = match.worldToGrid(t.position.x, t.position.y);
      const bucket = match.tileIndex.traps.get(g.gridY * TILE_KEY_STRIDE + g.gridX);
      expect(bucket, `live trap ${id} bucketed`).toContain(id);
    }
  });

  it('insertion-order tie-break: first-added wins, removal promotes, re-add moves to the end (Map semantics)', () => {
    const match = createMatch();
    const pos = tileCenter(2, 2);

    match.addChest(Chest.create('c1', ChestRarity.COMMON, pos));
    match.addChest(Chest.create('c2', ChestRarity.COMMON, pos));
    match.addChest(Chest.create('c3', ChestRarity.COMMON, pos));
    expect(match.findChestAtTile(2, 2)).toBe('c1');
    match.removeChestById('c1');
    expect(match.findChestAtTile(2, 2)).toBe('c2');
    match.addChest(Chest.create('c1', ChestRarity.COMMON, pos)); // Map re-insert → order end
    expect(match.findChestAtTile(2, 2)).toBe('c2');

    match.addWeaponPickup('wp1', dagger('w1'), pos);
    match.addWeaponPickup('wp2', dagger('w2'), pos);
    expect(match.findWeaponPickupAtTile(2, 2)).toBe('wp1');
    match.weaponPickups.get('wp1')!.deactivate(); // flag flip, no removal
    expect(match.findWeaponPickupAtTile(2, 2)).toBe('wp2');

    match.addDestructible(Destructible.create('d1', 'crate', pos));
    match.addDestructible(Destructible.create('d2', 'crate', pos));
    match.destructibles.get('d1')!.takeDamage({ source: 'melee', rawDamage: 99, currentTick: 1 });
    expect(match.destructibles.get('d1')!.isDestroyed).toBe(true); // still in map
    expect(match.findDestructibleAtTile(2, 2)).toBe('d2');
  });

  it('match.destroyDestructible eagerly removes the id from its tile bucket (hooked direct-delete site)', () => {
    const match = createMatch();
    const pos = tileCenter(2, 2);
    match.addDestructible(Destructible.create('d1', 'crate', pos));
    match.addDestructible(Destructible.create('d2', 'crate', pos));

    match.destroyDestructible('d1');
    expect(match.destructibles.has('d1')).toBe(false);
    expect(match.findDestructibleAtTile(2, 2)).toBe('d2');
    expect(match.tileIndex.destructibles.get(2 * TILE_KEY_STRIDE + 2)).toEqual(['d2']);
  });

  it('barrel-chain delete removes the id from its tile bucket (BarrelExplosionManager hooked site)', () => {
    const match = createMatch();
    // Crate one tile east of the blast origin — the +X ray reaches it on
    // step 1, one-shotting it through the explosion-damage path that
    // performs the direct `destructibles.delete`.
    match.addDestructible(Destructible.create('crate-1', 'crate', tileCenter(4, 5)));
    match.triggerBarrelExplosion(3, 5, 0, 0, 'test', 1);

    expect(match.destructibles.has('crate-1')).toBe(false);
    expect(match.findDestructibleAtTile(4, 5)).toBeNull();
    expect(match.tileIndex.destructibles.get(5 * TILE_KEY_STRIDE + 4)).toBeUndefined();
  });

  it('hydrateEntities populates the index (direct-set hydration add site)', () => {
    const match = createMatch();
    match.hydrateEntities({
      grid: makeGrid(10, 10, TileType.EMPTY),
      seed: 7,
      spawnPoints: [],
      chestPlacements: [{ gridX: 2, gridY: 2, tier: ChestRarity.COMMON }],
      trapPlacements: [{ gridX: 3, gridY: 3, trapType: TrapType.SPIKE }],
      weaponSpawnPlacements: [{ gridX: 2, gridY: 3, tier: WeaponTier.COMMON }],
    });

    // Oracle-compare rather than hardcoding ids (the hydrator owns id and
    // weapon-roll generation — both deterministic, neither load-bearing here).
    assertParity(match, 'hydration');
    expect(match.findChestAtTile(2, 2)).not.toBeNull();
    expect(match.findTrapAtTile(3, 3)).not.toBeNull();
    expect(match.findWeaponPickupAtTile(2, 3)).not.toBeNull();
  });
});
