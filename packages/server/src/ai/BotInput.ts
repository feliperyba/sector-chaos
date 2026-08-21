import { InputAction, normalizeAnglePositive } from '@sector-battle/shared';
import type { QueuedInput } from '../application/simulation/InputQueue.ts';
import type { Vec2 } from './BotContext.ts';

/**
 * Reason-tag side channel for believability telemetry (DEC-013, ticket 01).
 *
 * Dash/throw/switch factory call sites pass an optional `reason` string that
 * the benchmark tally attributes the action to. Tags are LABELS ONLY: the
 * input object itself is byte-identical with and without a reason (nothing in
 * the input-processing pipeline reads it, and no decision anywhere consumes
 * it) — the tag travels via a WeakMap keyed on the returned input object so
 * the QueuedInput shape (a shared contract) stays untouched. Entries die with
 * their inputs; untagged calls cost nothing.
 */
const inputReasonTags = new WeakMap<QueuedInput, string>();

function tagReason(input: QueuedInput, reason?: string): QueuedInput {
  if (reason !== undefined) inputReasonTags.set(input, reason);
  return input;
}

/** Read the reason tag a factory call site attached to this input (undefined
 *  for untagged inputs and for inputs whose object has been GC'd — the
 *  tally treats that as 'untagged'). */
export function readInputReason(input: QueuedInput): string | undefined {
  return inputReasonTags.get(input);
}

export function makeMoveInput(
  playerId: string,
  moveAngle: number,
  aimAngle: number,
  tick: number,
): QueuedInput {
  const norm = normalizeAnglePositive(moveAngle);
  const aim = normalizeAnglePositive(aimAngle);
  return {
    playerId,
    action: InputAction.MOVE,
    data: { dx: Math.cos(norm), dy: Math.sin(norm), aimAngle: aim, tick },
    clientTick: tick,
    serverTick: tick,
    receivedAt: Date.now(),
  };
}

export function makeAttackInput(playerId: string, aimAngle: number, tick: number): QueuedInput {
  return {
    playerId,
    action: InputAction.ATTACK,
    data: { aimAngle: normalizeAnglePositive(aimAngle), tick },
    clientTick: tick,
    serverTick: tick,
    receivedAt: Date.now(),
  };
}

/**
 * A HOLD-POSITION move input: MOVE with a zero direction. The server's
 * MoveCommand applies pure deceleration for a zero-direction input (the
 * player still counts as "moved" for the momentum pass, so no double
 * integration) — the input-layer expression of a stop. Used by the movement
 * signature (bot-ai-v2 ticket 08): anchor loiters (SCAVENGER at loot,
 * TRAPPER near features) and the 1-tick speed-variance micro-pauses. The aim
 * stays live (the bot faces its anchor/enemy while holding — a deliberate
 * pause, never an AFK freeze).
 */
export function makeStopInput(playerId: string, aimAngle: number, tick: number): QueuedInput {
  return {
    playerId,
    action: InputAction.MOVE,
    data: { dx: 0, dy: 0, aimAngle: normalizeAnglePositive(aimAngle), tick },
    clientTick: tick,
    serverTick: tick,
    receivedAt: Date.now(),
  };
}

export function makeDashInput(
  playerId: string,
  angle: number,
  tick: number,
  reason?: string,
): QueuedInput {
  const norm = normalizeAnglePositive(angle);
  return tagReason(
    {
      playerId,
      action: InputAction.DASH,
      data: { dx: Math.cos(norm), dy: Math.sin(norm) },
      clientTick: tick,
      serverTick: tick,
      receivedAt: Date.now(),
    },
    reason,
  );
}

/** Throw the active weapon as a projectile toward aimAngle. Used tactically:
 *  a fleeing bot throws to deny chase, or a bot with a low-tier spare throws
 *  it to poke an out-of-range enemy. Consumes the active weapon. */
export function makeThrowInput(
  playerId: string,
  aimAngle: number,
  tick: number,
  reason?: string,
): QueuedInput {
  return tagReason(
    {
      playerId,
      action: InputAction.THROW,
      data: { aimAngle: normalizeAnglePositive(aimAngle) },
      clientTick: tick,
      serverTick: tick,
      receivedAt: Date.now(),
    },
    reason,
  );
}

export function makePickupInput(playerId: string, targetId: string, tick: number): QueuedInput {
  return {
    playerId,
    action: InputAction.PICKUP,
    data: { powerUpId: targetId, targetId, tick },
    clientTick: tick,
    serverTick: tick,
    receivedAt: Date.now(),
  };
}

export function makeSwitchSlotInput(
  playerId: string,
  slot: number,
  tick: number,
  reason?: string,
): QueuedInput {
  return tagReason(
    {
      playerId,
      action: InputAction.SWITCH_SLOT,
      data: { slot },
      clientTick: tick,
      serverTick: tick,
      receivedAt: Date.now(),
    },
    reason,
  );
}

export function clampToWalkable(
  pf: {
    worldToGrid(p: Vec2): { x: number; y: number };
    isWalkable(x: number, y: number): boolean;
    gridToWorld(p: { x: number; y: number }): Vec2;
    getTileSize(): number;
  },
  x: number,
  y: number,
): Vec2 {
  const grid = pf.worldToGrid({ x, y });
  if (pf.isWalkable(grid.x, grid.y)) return { x, y };
  for (let r = 1; r <= 3; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (pf.isWalkable(grid.x + dx, grid.y + dy)) {
          return pf.gridToWorld({ x: grid.x + dx, y: grid.y + dy });
        }
      }
    }
  }
  return { x, y };
}
