import { describe, it, expect } from 'vitest';
import {
  MapGenerator,
  TileType,
  MapValidator,
  SectorLootTier,
  WeaponTier,
  auditSpawnEquity,
  repairSpawnEquity,
  SPAWN_EQUITY_MAX_DEVIATION,
  SPAWN_DESTRUCTIBLE_CLEARANCE,
  SECTOR_GRID_SIZE,
  SECTOR_TILE_SIZE,
  TILE_PIXEL_SIZE,
  MIN_SPAWN_DIST,
  type MapData,
  type SpawnEquityInput,
} from '@sector-battle/shared';

/**
 * Map-redesign ticket 10 (DEC-009) — the per-spawn value-vector equity gate:
 * hand-built violation fixtures proving a loot-starved spawn triggers
 * repair/rejection, plus the generation wiring (repair-before-validate,
 * audit telemetry, determinism). All assertions are data-layer per the
 * orchestrator mandate — no browser, no simulation.
 */

const BOUND = 1 + SPAWN_EQUITY_MAX_DEVIATION;

function baseMap(): MapData {
  return new MapGenerator().generate(42);
}

/** Euclidean distance from (x, y) to the nearest of the given points. */
function nearestDist(x: number, y: number, pts: Array<{ x: number; y: number }>): number {
  let best = Infinity;
  for (const p of pts) best = Math.min(best, Math.hypot(x - p.x, y - p.y));
  return best;
}

/**
 * Starve a spawn: move it to the eligible tile of its OWN sector that is
 * farthest from any ground weapon (spacing deliberately ignored — the fixture
 * isolates the equity signal). Returns the starved distance for assertions.
 */
function starveToFarthestTile(map: MapData, spawnIndex: number): number {
  const weapons = map.lootPlacements
    .filter((l) => l.type === 'WEAPON_SPAWN')
    .map((l) => l.position);
  const target = map.spawnPoints[spawnIndex]!;
  const sector = map.sectors[target.sectorCoord.row]![target.sectorCoord.col]!;
  let best = { r: 1, c: 1, d: -1 };
  for (let r = 1; r < SECTOR_TILE_SIZE - 1; r++) {
    for (let c = 1; c < SECTOR_TILE_SIZE - 1; c++) {
      if (sector.tiles[r]![c]! !== TileType.EMPTY) continue;
      const x = sector.bounds.x + c * TILE_PIXEL_SIZE + TILE_PIXEL_SIZE / 2;
      const y = sector.bounds.y + r * TILE_PIXEL_SIZE + TILE_PIXEL_SIZE / 2;
      const d = nearestDist(x, y, weapons);
      if (d > best.d) best = { r, c, d };
    }
  }
  target.x = sector.bounds.x + best.c * TILE_PIXEL_SIZE + TILE_PIXEL_SIZE / 2;
  target.y = sector.bounds.y + best.r * TILE_PIXEL_SIZE + TILE_PIXEL_SIZE / 2;
  return best.d;
}

describe('spawn-equity gate — hand-built violation fixtures (ticket 10 / DEC-009)', () => {
  it('a generated map is gate-clean and carries its fairness audit', () => {
    const gen = new MapGenerator();
    const map = gen.generate(42);
    const audit = auditSpawnEquity(map);
    expect(audit.violations).toHaveLength(0);
    for (const component of ['weapon', 'chest', 'clump', 'hot'] as const) {
      expect(audit.maxRatio[component]).toBeLessThanOrEqual(BOUND + 1e-9);
    }

    const report = gen.getLastGenerationAudit();
    expect(report).not.toBeNull();
    expect(report!.generationAttempts).toBe(1);
    expect(report!.spawnRepairs).toBeGreaterThanOrEqual(0);
    expect(report!.spawnRepairs).toBeLessThan(map.spawnPoints.length);
    expect(report!.equity.violations).toHaveLength(0);
  });

  it('a loot-starved spawn (moved to its sector’s farthest tile) trips the audit', () => {
    const map = baseMap();
    const weapons = map.lootPlacements
      .filter((l) => l.type === 'WEAPON_SPAWN')
      .map((l) => l.position);

    const target = map.spawnPoints[0]!;
    const before = nearestDist(target.x, target.y, weapons);
    const starvedDist = starveToFarthestTile(map, 0);
    // Sanity: the starved tile must actually be worse than the spawn's
    // original position, or the fixture proves nothing.
    expect(starvedDist).toBeGreaterThan(before);

    const audit = auditSpawnEquity(map);
    expect(audit.violations.length).toBeGreaterThan(0);
    const mine = audit.violations.filter((v) => v.spawnIndex === 0);
    expect(mine.length).toBeGreaterThan(0);
    for (const v of mine) {
      expect(v.ratio).toBeGreaterThan(BOUND);
    }
    // The un-repaired fixture fails validation (the rejection side of
    // repair/rejection): the equity gate error names the spawn + component.
    const result = new MapValidator().validate(map);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.startsWith('Spawn equity:'))).toBe(true);
  });

  it('repair re-picks the starved spawn from its sector pool — count, sector, spacing, bound', () => {
    const map = baseMap();
    const weapons = map.lootPlacements
      .filter((l) => l.type === 'WEAPON_SPAWN')
      .map((l) => l.position);

    starveToFarthestTile(map, 0);
    expect(auditSpawnEquity(map).violations.length).toBeGreaterThan(0);

    const before = map.spawnPoints.map((sp) => ({ ...sp }));
    const { repairs, audit } = repairSpawnEquity(map);

    // The starved spawn was re-picked (bounded local repair).
    expect(repairs).toBeGreaterThanOrEqual(1);
    expect(map.spawnPoints).toHaveLength(before.length);
    const moved = map.spawnPoints[0]!;
    expect(moved.x).not.toBe(before[0]!.x);
    expect(moved.sectorCoord).toEqual(before[0]!.sectorCoord); // same sector pool only
    // Never invents positions: the new tile is an EMPTY interior tile of the
    // same sector (the eligible pool definition).
    const sector = map.sectors[moved.sectorCoord.row]![moved.sectorCoord.col]!;
    const localCol = Math.floor((moved.x - sector.bounds.x) / TILE_PIXEL_SIZE);
    const localRow = Math.floor((moved.y - sector.bounds.y) / TILE_PIXEL_SIZE);
    expect(sector.tiles[localRow]![localCol]!).toBe(TileType.EMPTY);
    // Post-repair: the starved spawn no longer violates on any component.
    const residualForSpawn = audit.violations.filter((v) => v.spawnIndex === 0);
    expect(residualForSpawn).toHaveLength(0);
    // Spacing preserved vs every other spawn (the repair candidate filter).
    for (let j = 1; j < map.spawnPoints.length; j++) {
      const o = map.spawnPoints[j]!;
      expect(Math.hypot(moved.x - o.x, moved.y - o.y)).toBeGreaterThanOrEqual(
        MIN_SPAWN_DIST - 1e-6,
      );
    }
  });

  it('an unrepairable starved spawn survives repair and fails the gate (rejection)', () => {
    // Hand-built minimal input: sector [0,0]'s eligible pool is exactly 3
    // loot-adjacent "good" tiles (all occupied by spacing-valid spawns) + 1
    // far corner tile. The corner spawn violates the bound, and repair has
    // NO in-bound candidate (the good tiles are blocked by the 3 spawns), so
    // the violation stands — the validator gate rejects and the generation
    // retry loop takes over. The other 15 sectors are open filler (no spawns
    // there — the context builder visits every sector, so the grid must be
    // complete).
    const T = SECTOR_TILE_SIZE;
    const px = (r: number, c: number): { x: number; y: number } => ({
      x: c * TILE_PIXEL_SIZE + TILE_PIXEL_SIZE / 2,
      y: r * TILE_PIXEL_SIZE + TILE_PIXEL_SIZE / 2,
    });
    const GOOD = [
      { r: 9, c: 9 },
      { r: 9, c: 11 },
      { r: 11, c: 9 },
    ];
    // Loot one tile off each good tile (distance 128px there). The three good
    // spawns sit within MIN_SPAWN_DIST of every good tile, so the far spawn
    // has NO in-bound spacing-valid candidate — unrepairable by construction.
    const LOOT = [
      { r: 8, c: 9 },
      { r: 8, c: 11 },
      { r: 12, c: 9 },
    ];
    const FAR = { r: 17, c: 17 };

    const sectors = [] as unknown as SpawnEquityInput['sectors'];
    for (let sRow = 0; sRow < SECTOR_GRID_SIZE; sRow++) {
      sectors[sRow] = [];
      for (let sCol = 0; sCol < SECTOR_GRID_SIZE; sCol++) {
        const tiles: Uint8Array[] = [];
        for (let r = 0; r < T; r++) {
          const row = new Uint8Array(T).fill(1); // wall everywhere by default
          tiles.push(row);
        }
        if (sRow === 0 && sCol === 0) {
          // Pool = exactly the 4 authored tiles.
          for (const p of [...GOOD, FAR]) tiles[p.r]![p.c] = 0;
        } else {
          // Filler: open interior + wall border ring.
          for (let r = 1; r < T - 1; r++) {
            for (let c = 1; c < T - 1; c++) tiles[r]![c] = TileType.EMPTY;
          }
        }
        sectors[sRow]![sCol] = {
          tiles,
          bounds: {
            x: sCol * T * TILE_PIXEL_SIZE,
            y: sRow * T * TILE_PIXEL_SIZE,
            width: T * TILE_PIXEL_SIZE,
            height: T * TILE_PIXEL_SIZE,
          },
        } as unknown as SpawnEquityInput['sectors'][number][number];
      }
    }

    const spawnPoints = [...GOOD.map((p) => px(p.r, p.c)), px(FAR.r, FAR.c)].map((pos, i) => ({
      ...pos,
      sectorCoord: { row: 0, col: 0 },
      priority: 4 - i,
    }));
    // Loot sits one tile off the good tiles (distance ~128px there; the far
    // tile is ~13 path tiles away — far beyond 1.3x the pool median, which
    // is a good tile's distance).
    const lootPlacements = LOOT.map((p) => ({
      type: 'WEAPON_SPAWN' as const,
      tier: WeaponTier.COMMON,
      position: px(p.r, p.c),
      sectorCoord: { row: 0, col: 0 },
    }));
    const sectorTiers = Array.from({ length: SECTOR_GRID_SIZE }, (_, r) =>
      Array.from({ length: SECTOR_GRID_SIZE }, (_, c) =>
        r === 0 && c === 0 ? SectorLootTier.HOT : SectorLootTier.WARM,
      ),
    );
    const input: SpawnEquityInput = {
      sectors,
      spawnPoints,
      lootPlacements,
      sectorTiers,
      hotSector: { row: 0, col: 0 }, // the sector itself is HOT — hot distance 0
      entityPlacements: [],
    };

    const pre = auditSpawnEquity(input);
    expect(pre.violations.some((v) => v.spawnIndex === 3 && v.ratio > BOUND)).toBe(true);

    const { repairs, audit } = repairSpawnEquity(input);
    // Repair could not fix spawn 3 (no in-bound, spacing-valid candidate).
    const residual = audit.violations.filter((v) => v.spawnIndex === 3);
    expect(residual.length).toBeGreaterThan(0);
    // Count unchanged; the far spawn never moved onto a good tile (blocked).
    expect(input.spawnPoints).toHaveLength(4);
    expect(input.spawnPoints[3]!.sectorCoord).toEqual({ row: 0, col: 0 });
    expect(repairs).toBe(0);
  });

  it('repair is deterministic — same input, same result', () => {
    const a = baseMap();
    const b = baseMap();
    // Starve the same spawn on both copies.
    for (const map of [a, b]) starveToFarthestTile(map, 7);
    const ra = repairSpawnEquity(a);
    const rb = repairSpawnEquity(b);
    expect(rb.repairs).toBe(ra.repairs);
    expect(JSON.stringify(b.spawnPoints)).toBe(JSON.stringify(a.spawnPoints));
  });

  it('same-seed generation is byte-stable through the fairness pass', () => {
    const gen = new MapGenerator();
    const first = gen.generate(777);
    const auditFirst = gen.getLastGenerationAudit()!;
    const second = gen.generate(777);
    const auditSecond = gen.getLastGenerationAudit()!;
    expect(JSON.stringify(second.spawnPoints)).toBe(JSON.stringify(first.spawnPoints));
    expect(auditSecond.spawnRepairs).toBe(auditFirst.spawnRepairs);
    expect(auditSecond.equity.maxRatio).toEqual(auditFirst.equity.maxRatio);
  });

  it('every generated map keeps exactly 64 spawns, 4 per sector (GDD §5 preserved)', () => {
    for (const seed of [1, 42, 999]) {
      const map = new MapGenerator().generate(seed);
      expect(map.spawnPoints.length).toBe(64);
      const perSector = new Map<string, number>();
      for (const sp of map.spawnPoints) {
        const key = `${sp.sectorCoord.row},${sp.sectorCoord.col}`;
        perSector.set(key, (perSector.get(key) ?? 0) + 1);
      }
      expect(perSector.size).toBe(SECTOR_GRID_SIZE * SECTOR_GRID_SIZE);
      for (const count of perSector.values()) expect(count).toBe(4);
    }
  });

  it('no repaired spawn sits on a server-rejected destructible-clearance tile (bot-spawn-distribution regression)', () => {
    // Regression (found by tests/integration/bot-spawn-distribution.test.ts):
    // the repair used to re-pick spawns onto tiles within Manhattan ≤1 of a
    // CRATE/BARREL placement. The server SpawnService rejects those spawn
    // points (isSpawnPointValid destructible clearance), shrinking the valid
    // pool below 64 and forcing spawn REUSE + jitter — producing spawn pairs
    // closer than 256px. The eligible pool now excludes the blocked tiles, so
    // every generated spawn (repaired or not, when a bounded candidate
    // exists) is server-valid and the 64-spawn pool never shrinks.
    for (const seed of [1, 42, 999, 12345]) {
      const map = new MapGenerator().generate(seed);
      const destructibles = map.entityPlacements.filter(
        (e) => e.entityType === 'CRATE' || e.entityType === 'BARREL',
      );
      for (const sp of map.spawnPoints) {
        const gx = Math.floor(sp.x / TILE_PIXEL_SIZE);
        const gy = Math.floor(sp.y / TILE_PIXEL_SIZE);
        for (const d of destructibles) {
          const dgx = Math.floor(d.position.x / TILE_PIXEL_SIZE);
          const dgy = Math.floor(d.position.y / TILE_PIXEL_SIZE);
          expect(
            Math.abs(dgx - gx) + Math.abs(dgy - gy),
            `seed ${seed}: spawn (${sp.x},${sp.y}) within destructible clearance of ${d.entityType} (${d.position.x},${d.position.y})`,
          ).toBeGreaterThan(SPAWN_DESTRUCTIBLE_CLEARANCE);
        }
      }
    }
  });

  it('a spawn on a destructible-clearance tile is repair-worthy even when its ratios are in-bound', () => {
    // Hand-built minimal input: one open sector with a BARREL one tile off a
    // spawn. The spawn's value ratios are perfect (loot + hot at distance 0),
    // but the tile is server-rejected — repair must re-pick it onto a clear
    // eligible tile of the same sector.
    const T = SECTOR_TILE_SIZE;
    const px = (r: number, c: number): { x: number; y: number } => ({
      x: c * TILE_PIXEL_SIZE + TILE_PIXEL_SIZE / 2,
      y: r * TILE_PIXEL_SIZE + TILE_PIXEL_SIZE / 2,
    });
    const sectors = [] as unknown as SpawnEquityInput['sectors'];
    for (let sRow = 0; sRow < SECTOR_GRID_SIZE; sRow++) {
      sectors[sRow] = [];
      for (let sCol = 0; sCol < SECTOR_GRID_SIZE; sCol++) {
        const tiles: Uint8Array[] = [];
        for (let r = 0; r < T; r++) tiles.push(new Uint8Array(T).fill(1));
        if (sRow === 0 && sCol === 0) {
          for (let r = 1; r < T - 1; r++) {
            for (let c = 1; c < T - 1; c++) tiles[r]![c] = TileType.EMPTY;
          }
        }
        sectors[sRow]![sCol] = {
          tiles,
          bounds: {
            x: sCol * T * TILE_PIXEL_SIZE,
            y: sRow * T * TILE_PIXEL_SIZE,
            width: T * TILE_PIXEL_SIZE,
            height: T * TILE_PIXEL_SIZE,
          },
        } as unknown as SpawnEquityInput['sectors'][number][number];
      }
    }
    // Spawn at local (5,5); BARREL at local (6,5) — Manhattan 1 → blocked.
    const spawn = { ...px(5, 5), sectorCoord: { row: 0, col: 0 }, priority: 1 };
    const barrel = px(6, 5);
    const loot = [px(5, 4), px(4, 5)].map((position) => ({
      type: 'WEAPON_SPAWN' as const,
      tier: WeaponTier.COMMON,
      position,
      sectorCoord: { row: 0, col: 0 },
    }));
    const sectorTiers = Array.from({ length: SECTOR_GRID_SIZE }, () =>
      Array.from({ length: SECTOR_GRID_SIZE }, () => SectorLootTier.WARM),
    );
    const input: SpawnEquityInput = {
      sectors,
      spawnPoints: [spawn],
      lootPlacements: loot,
      sectorTiers,
      hotSector: { row: 0, col: 0 },
      entityPlacements: [
        { entityType: 'BARREL', position: barrel, sectorCoord: { row: 0, col: 0 } },
      ],
    };

    // Ratio-clean audit (the value-bound side sees nothing wrong)…
    expect(auditSpawnEquity(input).violations).toHaveLength(0);
    // …but repair still re-picks the blocked spawn (server-validity side).
    const { repairs } = repairSpawnEquity(input);
    expect(repairs).toBe(1);
    const moved = input.spawnPoints[0]!;
    expect(moved.sectorCoord).toEqual({ row: 0, col: 0 });
    const mgx = Math.floor(barrel.x / TILE_PIXEL_SIZE);
    const mgy = Math.floor(barrel.y / TILE_PIXEL_SIZE);
    const sgx = Math.floor(moved.x / TILE_PIXEL_SIZE);
    const sgy = Math.floor(moved.y / TILE_PIXEL_SIZE);
    expect(Math.abs(mgx - sgx) + Math.abs(mgy - sgy)).toBeGreaterThan(SPAWN_DESTRUCTIBLE_CLEARANCE);
  });
});
