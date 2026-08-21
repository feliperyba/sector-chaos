import { AttackType, IdGenerator } from '@sector-battle/shared';
import type { GameMatch } from '../../domain/aggregates/GameMatch.ts';
import { CommandResult, type CommandResult as CommandResultType } from './CommandTypes.ts';
import { AttackValidator } from '../../domain/validators/AttackValidator.ts';
import type { ShieldHandler } from '../../domain/handlers/ShieldHandler.ts';
import { WindupManager } from './WindupManager.ts';
import { AttackExecutor } from './AttackExecutor.ts';
import { DestructibleDamageHandler } from './DestructibleDamageHandler.ts';
import type { PlayerAnimationSystem } from '../services/PlayerAnimationSystem.ts';
import { MeleeSweepHandler } from '../../domain/handlers/MeleeSweepHandler.ts';

export interface AttackInput {
  playerId: string;
  tick: number;
  aimAngle?: number;
  targetX?: number;
  targetY?: number;
  forceAttackType?: AttackType;
}

export class AttackCommand {
  private match: GameMatch;
  private validator: AttackValidator;
  private windupManager: WindupManager;
  private executor: AttackExecutor;
  private animationSystem: PlayerAnimationSystem | null = null;
  private destructibleHandler: DestructibleDamageHandler;
  private meleeSweepHandler: MeleeSweepHandler | null = null;

  constructor(match: GameMatch, shieldHandler: ShieldHandler) {
    this.match = match;
    this.validator = new AttackValidator();
    this.windupManager = new WindupManager();
    this.destructibleHandler = new DestructibleDamageHandler(match);
    this.executor = new AttackExecutor(
      match,
      shieldHandler,
      new IdGenerator('atk'),
      this.destructibleHandler,
    );
  }

  execute(input: AttackInput): CommandResultType {
    const player = this.match.getPlayer(input.playerId);
    if (!player) return CommandResult.fail('Player not found');
    if (!player.isActive) return CommandResult.fail('Player is dead');

    const weapon = player.getActiveWeapon();
    const lastAttackTick = this.windupManager.getLastAttackTick(input.playerId);

    const validation = this.validator.validate(
      player,
      weapon,
      lastAttackTick,
      this.match.currentTick,
      this.match.currentPhase,
      input.forceAttackType === AttackType.THROWN ? { skipCanUse: true } : undefined,
    );
    if (!validation.valid) return CommandResult.fail(validation.reason ?? 'Validation failed');

    if (!weapon) return CommandResult.fail('No weapon');

    if (!this.validator.validateWeaponInInventory(player, weapon)) {
      return CommandResult.fail('Weapon not in inventory');
    }

    if (!this.windupManager.checkRateLimit(input.playerId, this.match.currentTick)) {
      return CommandResult.fail('Rate limit exceeded');
    }

    const windup = this.windupManager.startWindup(player, weapon, input.forceAttackType);
    this.windupManager.recordRate(input.playerId, this.match.currentTick);
    this.animationSystem?.onAttackStarted(input.playerId, weapon.type, windup.effectiveType);

    return CommandResult.ok([]);
  }

  setAnimationSystem(animationSystem: PlayerAnimationSystem): void {
    this.animationSystem = animationSystem;
    this.meleeSweepHandler = new MeleeSweepHandler(
      this.match,
      animationSystem,
      this.destructibleHandler,
    );
    this.executor.setSweepHandler(this.meleeSweepHandler);
    this.executor.setHandWorldProvider((playerId) => animationSystem.getHandWorld(playerId));
  }

  getMeleeSweepHandler(): MeleeSweepHandler | null {
    return this.meleeSweepHandler;
  }

  completeWindup(playerId: string): void {
    const player = this.match.getPlayer(playerId);
    if (!player || !player.isActive) {
      player?.combat.clearWindup();
      return;
    }

    const weaponSlot = player.combat.windupWeaponSlot;
    const weapon = weaponSlot >= 0 ? player.inventory.weapons[weaponSlot] : null;
    if (!weapon) {
      player.combat.clearWindup();
      return;
    }

    this.windupManager.setLastAttackTick(playerId, this.match.currentTick);
    player.recordAttack(this.match.currentTick);

    this.executor.executeAttack(player, weapon, weaponSlot);
  }

  cleanupPlayer(playerId: string): void {
    this.windupManager.cleanupPlayer(playerId);
    this.meleeSweepHandler?.cleanupPlayer(playerId);
  }
}
