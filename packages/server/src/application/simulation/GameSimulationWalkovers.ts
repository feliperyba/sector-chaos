import { PLAYER, SIM_TICK_DT } from '@sector-battle/shared';
import type { GameMatch } from '../../domain/aggregates/GameMatch.ts';
import type { IMovementService } from '../../domain/services/index.ts';
import type { PickupPowerUpCommand } from '../commands/index.ts';
import type { TriggerTrapCommand } from '../commands/index.ts';
import type { Player } from '../../domain/entities/Player.ts';

/**
 * Walk-over detection (traps + powerups) and movement resolution for
 * GameSimulation.
 *
 * Convention (unified 2026-07-21, refactor #12): these helpers take a pure
 * data bundle (`WalkoverContext`) — no closures, no reach-through into the
 * GameSimulation god-object. The bundle is built once in the GameSimulation
 * constructor and reused for the lifetime of the match.
 */

export const TRAP_CELL_SIZE = 256;
export const TRAP_CELL_INV = 1 / 256;

/**
 * Pure-data dependency bundle for the walk-over helpers. Deliberately holds no
 * closures: callers invoke `ctx.triggerTrapCommand.execute(...)` directly.
 */
export interface WalkoverContext {
  match: GameMatch;
  trapCells: Map<number, string[]>;
  trapCellPool: string[][];
  /** Spatial grid for powerups, rebuilt each tick (powerups change on pickup). */
  powerUpCells: Map<number, string[]>;
  powerUpCellPool: string[][];
  triggerTrapCommand: TriggerTrapCommand;
  pickupCommand: PickupPowerUpCommand;
  /**
   * server-alive-scratch-hoist: the per-tick alive array built once at the top
   * of GameSimulation.step() (players-Map insertion order). Valid only while
   * that step() is on the stack — see GameSimulation._alivePlayers for the
   * within-tick aliveness invariant.
   */
  alivePlayers: Player[];
}

export function rebuildTrapGridSim(ctx: WalkoverContext): void {
  ctx.trapCells.forEach((bucket) => {
    bucket.length = 0;
    ctx.trapCellPool.push(bucket);
  });
  ctx.trapCells.clear();

  const inv = TRAP_CELL_INV;
  ctx.match.getState().traps.forEach((trap, trapId) => {
    const cx = Math.floor(trap.position.x * inv);
    const cy = Math.floor(trap.position.y * inv);
    const key = cy * 100000 + cx;
    let bucket = ctx.trapCells.get(key);
    if (!bucket) {
      bucket = ctx.trapCellPool.pop() ?? [];
      ctx.trapCells.set(key, bucket);
    }
    bucket.push(trapId);
  });
}

export function checkTrapWalkOverSim(ctx: WalkoverContext, playerId: string): void {
  const player = ctx.match.getPlayer(playerId);
  if (!player || !player.isActive) return;
  const px = player.movement.position.x;
  const py = player.movement.position.y;
  const tick = ctx.match.currentTick;
  const traps = ctx.match.getState().traps;
  const inv = TRAP_CELL_INV;
  const ccx = Math.floor(px * inv);
  const ccy = Math.floor(py * inv);
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const key = (ccy + dy) * 100000 + (ccx + dx);
      const bucket = ctx.trapCells.get(key);
      if (!bucket) continue;
      for (let i = 0; i < bucket.length; i++) {
        const trapId = bucket[i]!;
        const trap = traps.get(trapId);
        if (!trap || !trap.canTrigger(tick)) continue;
        const tdx = px - trap.position.x;
        const tdy = py - trap.position.y;
        const radius = trap.getTriggerRadius();
        if (tdx * tdx + tdy * tdy <= radius * radius) {
          ctx.triggerTrapCommand.execute({ playerId, trapId, tick });
        }
      }
    }
  }
}

export function checkPowerUpWalkOverSim(ctx: WalkoverContext, playerId: string): void {
  const player = ctx.match.getPlayer(playerId);
  if (!player || !player.isActive) return;
  const px = player.movement.position.x;
  const py = player.movement.position.y;
  const PICKUP_RADIUS_SQ = PLAYER.PICKUP_RADIUS * PLAYER.PICKUP_RADIUS;
  const tick = ctx.match.currentTick;
  const powerUps = ctx.match.getState().powerUps;
  const inv = TRAP_CELL_INV;
  const ccx = Math.floor(px * inv);
  const ccy = Math.floor(py * inv);
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const bucket = ctx.powerUpCells.get((ccy + dy) * 100000 + (ccx + dx));
      if (!bucket) continue;
      for (let i = 0; i < bucket.length; i++) {
        const puId = bucket[i]!;
        const pu = powerUps.get(puId);
        // Defensive: a powerup picked up earlier this tick is removed from the
        // match but still listed in the grid rebuilt at pass start — skip it.
        if (!pu || !pu.isActive) continue;
        const dpx = px - pu.position.x;
        const dpy = py - pu.position.y;
        if (dpx * dpx + dpy * dpy <= PICKUP_RADIUS_SQ) {
          ctx.pickupCommand.execute({ playerId, powerUpId: pu.id, tick });
          return;
        }
      }
    }
  }
}

/**
 * Rebuild the powerup spatial grid. Powerups are removed on pickup (during the
 * same pass), so this is rebuilt once per tick before the per-player check; the
 * check re-validates each candidate against the live powerup map.
 */
export function rebuildPowerUpGridSim(ctx: WalkoverContext): void {
  ctx.powerUpCells.forEach((bucket) => {
    bucket.length = 0;
    ctx.powerUpCellPool.push(bucket);
  });
  ctx.powerUpCells.clear();

  const inv = TRAP_CELL_INV;
  ctx.match.getState().powerUps.forEach((pu, puId) => {
    if (!pu.isActive) return;
    const cx = Math.floor(pu.position.x * inv);
    const cy = Math.floor(pu.position.y * inv);
    const key = cy * 100000 + cx;
    let bucket = ctx.powerUpCells.get(key);
    if (!bucket) {
      bucket = ctx.powerUpCellPool.pop() ?? [];
      ctx.powerUpCells.set(key, bucket);
    }
    bucket.push(puId);
  });
}

export function step2_ResolveMovementSim(
  ctx: WalkoverContext,
  movementService: IMovementService,
  _tick: number,
): void {
  const grid = ctx.match.getGrid();
  const collisionService = ctx.match.getCollisionService();
  // server-alive-scratch-hoist: the shared per-tick alive array, built ONCE at
  // the top of GameSimulation.step() (before step1). The alive set is stable
  // within a tick — damage only reduces HP; the ALIVE status bit flips in
  // step9 (DeathResolutionService) and outside step() entirely — so iterating
  // it here is equivalent to the former fresh forEachAlivePlayer walk (same
  // members, same players-Map insertion order), without re-walking the full
  // players Map for each of the 2-3 alive-player passes below. The former
  // module-level aliveScratch (built per step2) folded into this shared array.
  const alive = ctx.alivePlayers;
  const aliveCount = alive.length;
  const forEachAliveCached = (cb: (p: Player) => void) => {
    for (let i = 0; i < aliveCount; i++) cb(alive[i]!);
  };

  for (let i = 0; i < aliveCount; i++) {
    const player = alive[i]!;
    const hadKnockback = player.isKnockedBack();
    player.updateKnockback(SIM_TICK_DT, grid, collisionService);
    if (hadKnockback) {
      const resolved = movementService.resolvePlayerCollision(
        player,
        forEachAliveCached,
        player.movement.position,
        ctx.match.currentTick,
      );
      ctx.match.movePlayer(player.id, resolved);
    }
    checkTrapWalkOverSim(ctx, player.id);
  }

  // Rebuild the powerup grid once, then run the per-player spatial query.
  rebuildPowerUpGridSim(ctx);
  for (let i = 0; i < aliveCount; i++) {
    checkPowerUpWalkOverSim(ctx, alive[i]!.id);
  }
}

// type re-exports for any consumer that imports these via this module
export type { GameMatch, PickupPowerUpCommand, TriggerTrapCommand };
