import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { MapSiegeService } from '../../../src/domain/services/MapSiegeService.ts';
import { SiegeWallManager } from '../../../src/domain/aggregates/SiegeWallManager.ts';
import { ZONE, TileType } from '@sector-battle/shared';
import type { GameEvent } from '../../../src/domain/events/index.ts';

/**
 * Differential behavior gate for the MapSiegeService active-sector-list
 * optimization (perf ticket 16).
 *
 * The service is pure domain logic: `update()` takes an explicit virtual
 * `currentTime` and scripted zone params, so a fixed schedule is fully
 * deterministic with no clock, room, or RNG involvement. The GOLDEN below was
 * captured by running this exact schedule against the PRE-optimization
 * implementation (`SIEGE_DIFF_CAPTURE=1` prints it). The optimized service
 * (active-sector list + idle short-circuit + in-place ring compaction) must
 * reproduce it byte-identically — same events, same per-tick event-array
 * boundaries (they become per-tick network batches), same intra-tick event
 * ORDER (row-major sector iteration), same final grid and wall bitmap.
 *
 * Schedule shape (8×8 tile grid, 2×2-tile sectors → 4×4 sector grid; 80ms
 * steps = one cascade tile per tick; 0.4s ring interval):
 *  - step 1: all sector centers inside the circle → NO sector ever active +
 *    unchanged params → exercises the full short-circuit (old code: sweep
 *    found nothing, provably no-op).
 *  - step 2: radius shrink → 12 sectors activate on the FIRST tick of the
 *    step → proves activation is caught at exactly the tick the old per-tick
 *    full sweep would have caught it.
 *  - step 3: unchanged params mid-siege → active-list iteration only.
 *  - step 4: further shrink → the 4 central sectors activate later.
 *  - step 5: zone center jump + partial radius grow → exercises the ring
 *    re-snapshot gate AND flips several already-active sectors back INSIDE
 *    the circle (the old sweep skipped those sectors' updates while inside;
 *    the liveness filter must reproduce that skip).
 *  - steps 6-7: overtime flip → every remaining sector activates; run to
 *    full completion (all 64 tiles walled) + idle ticks at completion.
 */

const GRID_N = 8;
const TILE = 64;
const SECTOR = 2; // → 4×4 sectors of 2×2 tiles
const STEP_MS = ZONE.SIEGE_CASCADE_TILE_DELAY * 1000; // 80ms — 1 cascade tile/tick
const INTERVAL = 0.4; // ring cadence (seconds) — 5 ticks between rings
const T0 = 1_000_000; // explicit virtual clock — never Date.now()

interface ScriptedStep {
  center: { x: number; y: number };
  radius: number;
  overtime: boolean;
  ticks: number;
}

const SCHEDULE: ScriptedStep[] = [
  { center: { x: 256, y: 256 }, radius: 400, overtime: false, ticks: 10 },
  { center: { x: 256, y: 256 }, radius: 200, overtime: false, ticks: 30 },
  { center: { x: 256, y: 256 }, radius: 200, overtime: false, ticks: 20 },
  { center: { x: 256, y: 256 }, radius: 80, overtime: false, ticks: 30 },
  { center: { x: 320, y: 448 }, radius: 150, overtime: false, ticks: 30 },
  { center: { x: 320, y: 448 }, radius: 150, overtime: true, ticks: 40 },
  { center: { x: 320, y: 448 }, radius: 150, overtime: true, ticks: 40 },
];

function makeGrid(): TileType[][] {
  const grid: TileType[][] = [];
  for (let r = 0; r < GRID_N; r++) {
    const row: TileType[] = [];
    for (let c = 0; c < GRID_N; c++) row.push(TileType.EMPTY);
    grid.push(row);
  }
  return grid;
}

function serializeEvent(e: GameEvent): number[] {
  switch (e.type) {
    case 'SiegeWallWarning':
      return [0, e.timestamp, e.gridX, e.gridY, e.solidifyAt];
    case 'SiegeWallDropped':
      return [
        1,
        e.timestamp,
        e.gridX,
        e.gridY,
        e.sectorRow,
        e.sectorCol,
        e.ring,
        e.tileIndex,
        e.audible ? 1 : 0,
      ];
    default:
      return [2, e.timestamp, e.gridX ?? -1, e.gridY ?? -1];
  }
}

interface ScheduleResult {
  /** One entry per scripted tick: the serialized events of that update(). */
  perTick: number[][][];
  /** Final wall bitmap, row-major, '0'/'1' per tile. */
  walls: string;
  /** Final tile grid. */
  grid: number[][];
}

function runSchedule(): ScheduleResult {
  const wallManager = new SiegeWallManager(GRID_N, GRID_N);
  const service = new MapSiegeService(wallManager, GRID_N, GRID_N, TILE, SECTOR);
  const grid = makeGrid();

  const perTick: number[][][] = [];
  let t = T0;
  for (const step of SCHEDULE) {
    for (let i = 0; i < step.ticks; i++) {
      // Fresh center object per call — mirrors the orchestrator passing the
      // zone service's per-tick object (value-equal, not identity-equal).
      const events = service.update(
        t,
        INTERVAL,
        grid,
        { x: step.center.x, y: step.center.y },
        step.radius,
        step.overtime,
      );
      perTick.push(events.map(serializeEvent));
      t += STEP_MS;
    }
  }

  let walls = '';
  for (let y = 0; y < GRID_N; y++) {
    for (let x = 0; x < GRID_N; x++) {
      walls += wallManager.hasSiegeWall(x, y) ? '1' : '0';
    }
  }
  return { perTick, walls, grid: grid.map((row) => row.map((tile) => tile as number)) };
}

const GOLDEN = '{"perTick":[[],[],[],[],[],[],[],[],[],[],[[0,1000800,0,0,1001200],[0,1000800,2,0,1001200],[0,1000800,3,0,1001200],[0,1000800,4,0,1001200],[0,1000800,5,0,1001200],[0,1000800,7,0,1001200],[0,1000800,0,2,1001200],[0,1000800,0,3,1001200],[0,1000800,7,2,1001200],[0,1000800,7,3,1001200],[0,1000800,0,4,1001200],[0,1000800,0,5,1001200],[0,1000800,7,4,1001200],[0,1000800,7,5,1001200],[0,1000800,0,7,1001200],[0,1000800,2,7,1001200],[0,1000800,3,7,1001200],[0,1000800,4,7,1001200],[0,1000800,5,7,1001200],[0,1000800,7,7,1001200]],[],[],[],[],[[1,1001200,0,0,0,0,0,0,1],[1,1001200,2,0,0,1,0,0,1],[1,1001200,4,0,0,2,0,0,1],[1,1001200,7,0,0,3,0,0,1],[1,1001200,0,2,1,0,0,0,1],[1,1001200,7,2,1,3,0,0,1],[1,1001200,0,4,2,0,0,0,1],[1,1001200,7,4,2,3,0,0,1],[1,1001200,0,7,3,0,0,0,1],[1,1001200,2,7,3,1,0,0,1],[1,1001200,4,7,3,2,0,0,1],[1,1001200,7,7,3,3,0,0,1]],[[1,1001280,3,0,0,1,0,1,1],[1,1001280,5,0,0,2,0,1,1],[1,1001280,0,3,1,0,0,1,1],[1,1001280,7,3,1,3,0,1,1],[1,1001280,0,5,2,0,0,1,1],[1,1001280,7,5,2,3,0,1,1],[1,1001280,3,7,3,1,0,1,1],[1,1001280,5,7,3,2,0,1,1]],[[0,1001360,1,0,1001680],[0,1001360,0,1,1001680],[0,1001360,1,1,1001680],[0,1001360,2,1,1001680],[0,1001360,3,1,1001680],[0,1001360,4,1,1001680],[0,1001360,5,1,1001680],[0,1001360,6,0,1001680],[0,1001360,6,1,1001680],[0,1001360,7,1,1001680],[0,1001360,1,2,1001680],[0,1001360,1,3,1001680],[0,1001360,6,2,1001680],[0,1001360,6,3,1001680],[0,1001360,1,4,1001680],[0,1001360,1,5,1001680],[0,1001360,6,4,1001680],[0,1001360,6,5,1001680],[0,1001360,0,6,1001680],[0,1001360,1,6,1001680],[0,1001360,1,7,1001680],[0,1001360,2,6,1001680],[0,1001360,3,6,1001680],[0,1001360,4,6,1001680],[0,1001360,5,6,1001680],[0,1001360,6,6,1001680],[0,1001360,7,6,1001680],[0,1001360,6,7,1001680]],[],[],[],[[1,1001680,1,0,0,0,1,0,1],[1,1001680,2,1,0,1,1,0,1],[1,1001680,4,1,0,2,1,0,1],[1,1001680,6,0,0,3,1,0,1],[1,1001680,1,2,1,0,1,0,1],[1,1001680,6,2,1,3,1,0,1],[1,1001680,1,4,2,0,1,0,1],[1,1001680,6,4,2,3,1,0,1],[1,1001680,0,6,3,0,1,0,1],[1,1001680,2,6,3,1,1,0,1],[1,1001680,4,6,3,2,1,0,1],[1,1001680,6,6,3,3,1,0,1]],[[1,1001760,0,1,0,0,1,1,0],[1,1001760,3,1,0,1,1,1,1],[1,1001760,5,1,0,2,1,1,1],[1,1001760,6,1,0,3,1,1,0],[1,1001760,1,3,1,0,1,1,1],[1,1001760,6,3,1,3,1,1,1],[1,1001760,1,5,2,0,1,1,1],[1,1001760,6,5,2,3,1,1,1],[1,1001760,1,6,3,0,1,1,0],[1,1001760,3,6,3,1,1,1,1],[1,1001760,5,6,3,2,1,1,1],[1,1001760,7,6,3,3,1,1,0]],[[1,1001840,1,1,0,0,1,2,1],[1,1001840,7,1,0,3,1,2,1],[1,1001840,1,7,3,0,1,2,1],[1,1001840,6,7,3,3,1,2,1]],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[[0,1004800,2,2,1005200],[0,1004800,3,2,1005200],[0,1004800,2,3,1005200],[0,1004800,4,2,1005200],[0,1004800,5,2,1005200],[0,1004800,5,3,1005200],[0,1004800,2,4,1005200],[0,1004800,2,5,1005200],[0,1004800,3,5,1005200],[0,1004800,5,4,1005200],[0,1004800,4,5,1005200],[0,1004800,5,5,1005200]],[],[],[],[],[[1,1005200,2,2,1,1,0,0,1],[1,1005200,4,2,1,2,0,0,1],[1,1005200,2,4,2,1,0,0,1],[1,1005200,5,4,2,2,0,0,1]],[[1,1005280,3,2,1,1,0,1,0],[1,1005280,5,2,1,2,0,1,0],[1,1005280,2,5,2,1,0,1,0],[1,1005280,4,5,2,2,0,1,0]],[[1,1005360,2,3,1,1,0,2,1],[1,1005360,5,3,1,2,0,2,1],[1,1005360,3,5,2,1,0,2,1],[1,1005360,5,5,2,2,0,2,1]],[[0,1005440,3,3,1005760],[0,1005440,4,3,1005760],[0,1005440,3,4,1005760],[0,1005440,4,4,1005760]],[],[],[],[[1,1005760,3,3,1,1,1,0,1],[1,1005760,4,3,1,2,1,0,1],[1,1005760,3,4,2,1,1,0,1],[1,1005760,4,4,2,2,1,0,1]],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[]],"walls":"1111111111111111111111111111111111111111111111111111111111111111","grid":[[1,1,1,1,1,1,1,1],[1,1,1,1,1,1,1,1],[1,1,1,1,1,1,1,1],[1,1,1,1,1,1,1,1],[1,1,1,1,1,1,1,1],[1,1,1,1,1,1,1,1],[1,1,1,1,1,1,1,1],[1,1,1,1,1,1,1,1]]}';

describe('MapSiegeService differential (active-sector-list optimization)', () => {
  it('reproduces the pre-optimization event stream byte-identically', () => {
    const actual = runSchedule();
    const json = JSON.stringify(actual);

    if (process.env.SIEGE_DIFF_CAPTURE === '1') {
      // Capture mode: write the golden for embedding (run against the
      // pre-optimization implementation only).
      if (process.env.SIEGE_DIFF_OUT) {
        writeFileSync(process.env.SIEGE_DIFF_OUT, json);
        console.log(`SIEGE_DIFF_GOLDEN written to ${process.env.SIEGE_DIFF_OUT} (${json.length} bytes)`);
      } else {
        console.log(`SIEGE_DIFF_GOLDEN ${json}`);
      }
      return;
    }

    expect(GOLDEN).not.toBe('PENDING_CAPTURE');
    expect(json).toBe(GOLDEN);
  });

  it('step 1 idle ticks are event-free (short-circuit equals the old no-op sweep)', () => {
    const { perTick } = runSchedule();
    // Ticks 0..9: init tick + 9 idle ticks. No sector has ever activated and
    // zone params are unchanged — the old full sweep visited only
    // inside-the-circle sectors, executed `continue` per sector, performed no
    // state writes, and drained an empty collector. The short-circuit must
    // return exactly the same nothing.
    for (let tick = 0; tick < 10; tick++) {
      expect(perTick[tick]).toEqual([]);
    }
  });

  it('detects sector activation on the exact tick the old sweep would have', () => {
    const { perTick } = runSchedule();
    // Tick 10 is the first tick of step 2 (radius 400→200). The activation
    // predicate flips for 12 sectors at this tick; with a 0.4s ring interval
    // and 0.5s warning window the warning window is already open at creation
    // (warningStartMs = 400-500 = -100), so the old sweep emitted warnings on
    // this very tick. Zero events here would mean the activation was caught
    // late (or never).
    const tick10 = perTick[10]!;
    expect(tick10.length).toBeGreaterThan(0);
    expect(tick10.every((tuple) => tuple[0] === 0)).toBe(true); // all warnings
    // 12 sectors × up to 4 tiles each warn on this tick.
    expect(tick10.length).toBeGreaterThan(12);
    // And the preceding tick had nothing (activation strictly at tick 10).
    expect(perTick[9]).toEqual([]);
  });

  it('completes the whole scripted map (all 64 tiles walled)', () => {
    const { perTick, walls, grid } = runSchedule();
    let drops = 0;
    for (const tick of perTick) {
      for (const tuple of tick) if (tuple[0] === 1) drops++;
    }
    expect(drops).toBe(GRID_N * GRID_N);
    expect(walls).toBe('1'.repeat(GRID_N * GRID_N));
    expect(grid.every((row) => row.every((tile) => tile === TileType.INDESTRUCTIBLE_WALL))).toBe(
      true,
    );
  });
});
