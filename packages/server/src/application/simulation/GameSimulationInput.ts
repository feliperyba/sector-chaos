import {
  InputAction,
  weaponRegistry,
  AttackType,
  type MoveInputData,
  type AttackInputData,
  type ThrowInputData,
  type PickupInputData,
  type SwitchSlotInputData,
  type DashInputData,
} from '@sector-battle/shared';
import { normalizeAnglePositive } from '@sector-battle/shared/math';
// Debug logging removed — pickup pipeline validated
import type { GameMatch } from '../../domain/aggregates/GameMatch.ts';
import type { MatchFlowService } from '../../domain/services/index.ts';
import {
  MovePlayerCommand,
  AttackCommand,
  PickupWeaponCommand,
  OpenChestCommand,
  TriggerTrapCommand,
  DashCommand,
} from '../commands/index.ts';
import type { InputQueue } from './InputQueue.ts';
import type { ShieldHandler } from '../../domain/handlers/ShieldHandler.ts';
import type { RateLimiter } from '../../validation/RateLimiter.ts';
import type { InMatchReconnectionManager } from '../../domain/services/ReconnectionManager.ts';
import type { Player } from '../../domain/entities/Player.ts';

export interface ActiveDash {
  startTick: number;
  multiplier: number;
  directionX: number;
  directionY: number;
}

export interface InputProcessContext {
  matchFlow: MatchFlowService | null;
  inputQueue: InputQueue;
  match: GameMatch;
  reconnectionManager: InMatchReconnectionManager | null;
  moveCommand: MovePlayerCommand;
  attackCommand: AttackCommand;
  pickupWeaponCommand: PickupWeaponCommand;
  openChestCommand: OpenChestCommand;
  triggerTrapCommand: TriggerTrapCommand;
  dashCommand: DashCommand;
  shieldHandler: ShieldHandler;
  attackRateLimiter: RateLimiter;
  activeDashes: Map<string, ActiveDash>;
  /**
   * server-alive-scratch-hoist: the per-tick alive array built once at the top
   * of GameSimulation.step() (players-Map insertion order). Equivalent to a
   * fresh forEachAlivePlayer scan here — aliveness cannot change between the
   * build and this pass (deaths flip status only in step9).
   */
  alivePlayers: Player[];
  updateLastProcessedInput: (clientTick: number) => void;
  checkTrapWalkOver: (playerId: string) => void;
  checkPowerUpWalkOver: (playerId: string) => void;
}

export function step1_ProcessInputs(ctx: InputProcessContext, tick: number): void {
  // ALWAYS drain the current tick's input bucket — even when the match phase
  // doesn't allow input processing (WAITING / COUNTDOWN). Previously this
  // returned early WITHOUT dequeuing, so every MOVE input a human client sent
  // during countdown accumulated as a per-tick bucket that step1 never
  // drained. Those stuck buckets were never replayed when ACTIVE began
  // (dequeueTick only returns the current tick), so the inputs were silently
  // lost — the client's unacked input buffer saturated and its continuously
  // running prediction raced ahead of a server that had never seen the
  // inputs, producing the "ghost/floaty movement" symptom through the
  // countdown→ACTIVE transition.
  //
  // During a non-input phase we still must NOT apply movement/attacks (game
  // rule: players are frozen during countdown), but we DO drain the queue and
  // advance lastProcessedInput so the client learns its inputs were consumed
  // and stops holding them in its reconciliation buffer. Bots are unaffected
  // (BotSystem only emits inputs while the match is ACTIVE).
  const inputs = ctx.inputQueue.dequeueTick(tick);
  if (ctx.matchFlow && !ctx.matchFlow.isInputAllowed()) {
    for (const input of inputs) {
      const inputPlayer = ctx.match.getPlayer(input.playerId);
      if (!inputPlayer) continue;
      if (input.clientTick > inputPlayer.lastProcessedInput) {
        inputPlayer.lastProcessedInput = input.clientTick;
      }
      ctx.updateLastProcessedInput(input.clientTick);
    }
    return;
  }
  inputs.sort((a, b) => a.playerId.localeCompare(b.playerId));
  // Track which players received a MOVE input THIS tick. Players who didn't
  // still need their physics integrated (momentum/deceleration) so the server
  // advances position every tick — matching the client's fixed-timestep
  // prediction loop. Without this, a player sending inputs at ~50fps on a 60Hz
  // server freezes ~10 ticks/sec → server position lags client prediction →
  // reconciliation yanks the player back → "sluggish" feel (the root cause of
  // the post-warmup sluggishness: warmup has no input processing so no
  // divergence; the moment warmup ends, the per-input-only integration falls
  // behind the client's per-frame integration).
  const playersWhoMovedThisTick = new Set<string>();
  for (const input of inputs) {
    const inputPlayer = ctx.match.getPlayer(input.playerId);
    if (!inputPlayer || inputPlayer.connectionState !== 'connected') continue;
    if (ctx.reconnectionManager) {
      ctx.reconnectionManager.recordInput(input.playerId);
    }
    if (inputPlayer.isFreshSpawnActive(tick)) {
      if (
        input.action === InputAction.ATTACK ||
        input.action === InputAction.THROW ||
        input.action === InputAction.DASH
      ) {
        continue;
      }
    }
    if (input.clientTick > inputPlayer.lastProcessedInput) {
      inputPlayer.lastProcessedInput = input.clientTick;
    }
    ctx.updateLastProcessedInput(input.clientTick);
    switch (input.action) {
      case InputAction.MOVE: {
        const data = input.data as MoveInputData;
        const player = ctx.match.getPlayer(input.playerId);
        const dx = data.dx;
        const dy = data.dy;
        if (player) {
          const rawAngle = data.aimAngle;
          if (rawAngle !== undefined && Number.isFinite(rawAngle)) {
            player.movement.facingAngle = normalizeAnglePositive(rawAngle);
          }
        }
        ctx.moveCommand.execute({
          playerId: input.playerId,
          dx,
          dy,
          tick: data.tick,
        });
        if (dx !== 0 || dy !== 0) {
          ctx.match.cancelChestOpeningForPlayer(input.playerId);
          ctx.checkTrapWalkOver(input.playerId);
          ctx.checkPowerUpWalkOver(input.playerId);
        }
        playersWhoMovedThisTick.add(input.playerId);
        break;
      }
      case InputAction.ATTACK: {
        if (!ctx.attackRateLimiter.check(input.playerId)) {
          break;
        }
        ctx.match.cancelChestOpeningForPlayer(input.playerId);
        const data = input.data as AttackInputData;
        const player = ctx.match.getPlayer(input.playerId);
        if (player) {
          const rawAngle = data.aimAngle;
          if (rawAngle !== undefined && Number.isFinite(rawAngle)) {
            player.movement.facingAngle = normalizeAnglePositive(rawAngle);
          }
        }
        ctx.attackCommand.execute({
          playerId: input.playerId,
          aimAngle: player?.movement.facingAngle ?? 0,
          tick: data.tick,
        });
        break;
      }
      case InputAction.THROW: {
        const data = input.data as ThrowInputData;
        const player = ctx.match.getPlayer(input.playerId);
        if (player) {
          const rawAngle = data.aimAngle;
          if (rawAngle !== undefined && Number.isFinite(rawAngle)) {
            player.movement.facingAngle = normalizeAnglePositive(rawAngle);
          }
          if (!player.canThrow(tick)) {
            break;
          }
          const weapon = player.getActiveWeapon();
          if (weapon) {
            const definition = weaponRegistry.getDefinition(weapon.type);
            if (definition && definition.canThrow) {
              ctx.attackCommand.execute({
                playerId: input.playerId,
                aimAngle: player.movement.facingAngle,
                tick: data.tick ?? 0,
                forceAttackType: AttackType.THROWN,
              });
            }
          }
        }
        break;
      }
      case InputAction.PICKUP: {
        const data = input.data as PickupInputData;
        const player = ctx.match.getPlayer(input.playerId);
        if (player && player.isActive && player.canPickup()) {
          const targetId = data.targetId;
          if (targetId) {
            const state = ctx.match.getState();
            if (state.chests.has(targetId)) {
              ctx.openChestCommand.execute({
                playerId: input.playerId,
                chestId: targetId,
                tick: data.tick,
              });
            } else if (state.traps.has(targetId)) {
              ctx.triggerTrapCommand.execute({
                playerId: input.playerId,
                trapId: targetId,
                tick: data.tick,
              });
            } else {
              // targetId is a weapon pickup — use weapon pickup command
              ctx.pickupWeaponCommand.execute({
                playerId: input.playerId,
                tick: data.tick,
              });
            }
          } else {
            ctx.pickupWeaponCommand.execute({
              playerId: input.playerId,
              tick: data.tick,
            });
          }
        }
        break;
      }
      case InputAction.SWITCH_SLOT: {
        const data = input.data as SwitchSlotInputData;
        const player = ctx.match.getPlayer(input.playerId);
        if (player) {
          player.switchSlot(data.slot);
        }
        break;
      }
      case InputAction.DASH: {
        const dashData = input.data as DashInputData;
        const dashResult = ctx.dashCommand.execute({
          playerId: input.playerId,
          tick,
          dx: dashData.dx,
          dy: dashData.dy,
        });
        if (dashResult.success && dashResult.dashData) {
          ctx.activeDashes.set(input.playerId, dashResult.dashData);
        }
        break;
      }
      default:
        continue;
    }
  }

  // MOMENTUM INTEGRATION PASS — advance physics for players who did NOT receive
  // a MOVE input this tick. This makes the server integrate position every tick
  // (matching the client's fixed-timestep prediction loop), eliminating the
  // root cause of the "sluggish local player after warmup" bug.
  //
  // Root cause: the client runs physics EVERY frame (coasting on last input
  // direction when no new frame arrives). The server previously ran physics
  // ONLY when a MOVE input landed on that exact tick. At ~50fps client input
  // rate on a 60Hz server, ~10 ticks/sec got no MOVE → the player froze those
  // ticks → server position fell behind client prediction → reconciliation
  // yanked the player back → permanent sluggish feel. During warmup this was
  // invisible (no inputs processed = no divergence).
  //
  // Fix: for each alive player with nonzero velocity who didn't MOVE this
  // tick, apply validateAndMove with their lastMoveDirection. This integrates
  // momentum + deceleration every tick, so the server tracks the client's
  // per-frame prediction. When the player releases the key (no input + zero
  // velocity), validateAndMove applies deceleration toward zero — exactly what
  // the client does.
  //
  // server-alive-scratch-hoist: iterates the shared per-tick alive array
  // (built at step top) instead of a fresh forEachAlivePlayer map walk — the
  // two are equivalent because no input processed above can flip the ALIVE
  // status bit (damage only reduces HP; the bit flips in step9).
  const alive = ctx.alivePlayers;
  for (let i = 0; i < alive.length; i++) {
    const player = alive[i]!;
    if (playersWhoMovedThisTick.has(player.id)) continue;
    if (player.connectionState !== 'connected') continue;
    const mv = player.movement;
    if (mv.velocityX === 0 && mv.velocityY === 0) continue;
    // Replay the last move direction — this is the "coast" the client does.
    const dir = mv.lastMoveDirection.toVector();
    ctx.moveCommand.execute({
      playerId: player.id,
      dx: dir.dx,
      dy: dir.dy,
      tick,
    });
  }
}
