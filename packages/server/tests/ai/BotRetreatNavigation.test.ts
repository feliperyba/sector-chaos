import { describe, it, expect } from 'vitest';
import { TILE_PIXEL_SIZE, InputAction, normalizeAnglePositive } from '@sector-battle/shared';
import { Pathfinder } from '../../src/ai/navigation/Pathfinder.ts';
import { BotContext, BotState, type EnemyInfo } from '../../src/ai/BotContext.ts';
import { executeRetreatState } from '../../src/ai/BotCombatExecutors.ts';
import { refreshRetreatGoal } from '../../src/ai/BotCombatRetreat.ts';
import { recordBotDeath } from '../../src/ai/BotTelemetry.ts';
import { BotSkillTracker } from '../../src/ai/BotSkillTracker.ts';
import { isAngleWalkable } from '../../src/ai/BotNavigationBlend.ts';
import { packGridKey } from '../../src/ai/BotDestructibles.ts';
import type { BotSystem } from '../../src/ai/BotSystem.ts';

/**
 * bot-ai-v2 ticket 06 — NAVIGATED BREAK-LINE RETREAT (DEC-005.4).
 *
 * Pre-fix, executeRetreat moved in a straight line away from the pursuer
 * (raw fleeAngle) — no pathfinding. A low-HP bot fleeing toward a wall line
 * wedged against it and died there. Post-fix the retreat goal is a scored
 * break-line candidate and the movement goes through navigateTo
 * (destructible-aware + the no-wall-angle guarantee), facing the pursuer.
 *
 * Also pins the wall-death telemetry (deaths at low HP adjacent to a wall
 * tile) that measures the fix at the bench gate.
 *
 * Written under the owner's no-run directive: assertions are statically
 * reasoned against the implementation; the orchestrator's sweep runs them.
 */

const TS = TILE_PIXEL_SIZE;

function makeGrid(cols: number, rows: number, walls: Array<[number, number]>): boolean[][] {
  const grid: boolean[][] = [];
  for (let y = 0; y < rows; y++) {
    const row: boolean[] = [];
    for (let x = 0; x < cols; x++) row.push(!walls.some(([wx, wy]) => wx === x && wy === y));
    grid.push(row);
  }
  return grid;
}

function tileCenter(gx: number, gy: number): { x: number; y: number } {
  return { x: gx * TS + TS / 2, y: gy * TS + TS / 2 };
}

function enemyAt(x: number, y: number, ctx: BotContext): EnemyInfo {
  const dx = x - ctx.x;
  const dy = y - ctx.y;
  return {
    id: 'enemy_1',
    x,
    y,
    distance: Math.sqrt(dx * dx + dy * dy),
  } as unknown as EnemyInfo;
}

function retreatSystem(pf: Pathfinder, destructibles?: Map<number, number>): BotSystem {
  return {
    pathfinder: pf,
    destructibleMap: destructibles ?? new Map<number, number>(),
    profiles: new Map(),
    skillTrackers: new Map(),
    reactor: { startleAimPenalty: () => 0 },
  } as unknown as BotSystem;
}

describe('Navigated retreat: a low-HP bot fleeing toward a wall line never stands against it', () => {
  it('emits a wall-validated routing MOVE (around the wall) while facing the pursuer', () => {
    // Pursuer EAST; wall column WEST of the bot with a far gap — the flee
    // direction runs INTO the column. The straight-line flee (pre-fix)
    // wedges; the navigated retreat paths around via the gap and emits a
    // walkable angle with the aim held on the pursuer.
    const walls: Array<[number, number]> = [];
    for (let y = 0; y < 16; y++) if (y !== 12) walls.push([4, y]); // gap at y=12
    const pf = new Pathfinder(makeGrid(16, 16, walls), TS);
    const ctx = new BotContext('bot_retreat_wall');
    ctx.x = tileCenter(5, 8).x; // adjacent-east of the column
    ctx.y = tileCenter(5, 8).y;
    ctx.health = 25;
    ctx.maxHealth = 100;
    ctx.weapons = [];
    ctx.state = BotState.RETREAT;
    ctx.nearestEnemy = enemyAt(ctx.x + 340, ctx.y, ctx);
    const inputs = executeRetreatState(retreatSystem(pf), ctx);
    const move = inputs.find((i) => i.action === InputAction.MOVE);
    expect(move).toBeDefined();
    const data = move!.data as { dx?: number; dy?: number; aimAngle?: number };
    expect(typeof data.dx).toBe('number');
    // The emitted movement never points into the wall (routes around).
    const a = Math.atan2(data.dy!, data.dx!);
    expect(isAngleWalkable(ctx, a, pf)).toBe(true);
    // Fighting withdrawal: the aim faces the pursuer (due EAST, angle 0).
    expect(data.aimAngle).toBeDefined();
    const aimDelta = Math.abs(normalizeAnglePositive(data.aimAngle!) - normalizeAnglePositive(0));
    expect(aimDelta).toBeLessThan(0.01);
  });

  it('breaks through when the wall is destructible and that is the only/shallower path', () => {
    // Adjacent to a FULL destructible column (crates, HP 20) on the flee
    // side: the plain planner cannot route around (no gap), so the tiered
    // planner takes the through-destructibles path and the destructible-
    // waypoint trigger hands off to the demolition executor on tick one.
    const walls: Array<[number, number]> = [];
    for (let y = 0; y < 16; y++) walls.push([8, y]); // full column x=8
    const pf = new Pathfinder(makeGrid(16, 16, walls), TS);
    const destructibles = new Map<number, number>();
    for (let y = 6; y <= 10; y++) destructibles.set(packGridKey(8, y), 20);
    const ctx = new BotContext('bot_retreat_smash');
    ctx.x = tileCenter(7, 8).x; // adjacent-east of the crate column
    ctx.y = tileCenter(7, 8).y;
    ctx.health = 25;
    ctx.maxHealth = 100;
    ctx.weapons = [];
    ctx.state = BotState.RETREAT;
    ctx.nearestEnemy = enemyAt(ctx.x - 340, ctx.y, ctx); // pursuer WEST → flee EAST, through the crates
    executeRetreatState(retreatSystem(pf, destructibles), ctx);
    expect(ctx.demolitionGridX).toBe(8);
    expect(ctx.demolitionGridY).toBe(8);
    expect(ctx.state).toBe(BotState.DEMOLITION);
    expect(ctx.preDemolitionState).toBe(BotState.RETREAT);
  });
});

describe('Navigated retreat: break-line-of-sight preference', () => {
  it('picks a retreat goal the pursuer cannot see when one exists', () => {
    // Wall column WEST of the bot with a single far gap; the pursuer is
    // EAST. West candidates sit behind the column → LOS from the pursuer is
    // blocked → the BREAK_LINE_BONUS dominates the score.
    const walls: Array<[number, number]> = [];
    for (let y = 0; y < 16; y++) if (y !== 12) walls.push([4, y]); // gap at y=12
    const pf = new Pathfinder(makeGrid(16, 16, walls), TS);
    const ctx = new BotContext('bot_retreat_los');
    ctx.x = tileCenter(6, 8).x;
    ctx.y = tileCenter(6, 8).y;
    const enemy = enemyAt(ctx.x + 340, ctx.y, ctx); // EAST pursuer
    ctx.nearestEnemy = enemy;
    refreshRetreatGoal(ctx, enemy, pf);
    const blocked = !pf.hasLineOfSightWorld(
      { x: enemy.x, y: enemy.y },
      { x: ctx.retreatGoalX, y: ctx.retreatGoalY },
    );
    expect(blocked).toBe(true); // the chosen goal cuts line-of-sight
    // The goal is on the far (west) side of the wall column.
    expect(ctx.retreatGoalX).toBeLessThan(4 * TS);
    // Cache: same pursuer position within the window → no re-pick.
    const goalX = ctx.retreatGoalX;
    ctx.tick += 10;
    refreshRetreatGoal(ctx, enemy, pf);
    expect(ctx.retreatGoalX).toBe(goalX);
  });
});

describe('Wall-death telemetry (DEC-005.4 directional gate)', () => {
  function systemWith(pf: Pathfinder): BotSystem {
    return {
      pathfinder: pf,
      skillTrackers: new Map(),
      selectors: new Map(),
    } as unknown as BotSystem;
  }

  it('counts a death at low HP adjacent to a wall tile', () => {
    const pf = new Pathfinder(makeGrid(8, 8, [[4, 4]]), TS);
    const ctx = new BotContext('bot_walldeath');
    ctx.x = tileCenter(4, 3).x; // directly north of the wall tile
    ctx.y = tileCenter(4, 3).y;
    ctx.health = 30;
    ctx.maxHealth = 100;
    const tracker = new BotSkillTracker();
    recordBotDeath(systemWith(pf), ctx, tracker, 100);
    expect(tracker.believability.wallAdjacentLowHpDeaths).toBe(1);
  });

  it('does NOT count open-field deaths or high-HP wall-adjacent deaths', () => {
    const pf = new Pathfinder(makeGrid(8, 8, [[4, 4]]), TS);
    const open = new BotContext('bot_open');
    open.x = tileCenter(2, 2).x;
    open.y = tileCenter(2, 2).y;
    open.health = 30;
    open.maxHealth = 100;
    const t1 = new BotSkillTracker();
    recordBotDeath(systemWith(pf), open, t1, 100);
    expect(t1.believability.wallAdjacentLowHpDeaths).toBe(0);

    const healthy = new BotContext('bot_healthy');
    healthy.x = tileCenter(4, 3).x;
    healthy.y = tileCenter(4, 3).y;
    healthy.health = 90;
    healthy.maxHealth = 100;
    const t2 = new BotSkillTracker();
    recordBotDeath(systemWith(pf), healthy, t2, 100);
    expect(t2.believability.wallAdjacentLowHpDeaths).toBe(0);
  });
});
