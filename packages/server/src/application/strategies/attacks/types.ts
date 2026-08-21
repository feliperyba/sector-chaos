import {
  AttackType,
  IdGenerator,
  type WeaponDefinition,
  type HurtboxEntity,
} from '@sector-battle/shared';
import type { Player } from '../../../domain/entities/index.ts';
import type { WeaponEntity } from '../../../domain/entities/index.ts';
import type { GameEvent } from '../../../domain/events/index.ts';
import type { GameMatch } from '../../../domain/aggregates/GameMatch.ts';
import type { ShieldHandler } from '../../../domain/handlers/ShieldHandler.ts';

export interface AttackParams {
  weapon: WeaponEntity;
  weaponSlot: number;
  damage: number;
  stats: WeaponDefinition['baseStats'];
  effectiveType: AttackType;
  definition: WeaponDefinition;
}

export interface AttackContext {
  match: GameMatch;
  currentTick: number;
  idGenerator: IdGenerator;
  shieldHandler: ShieldHandler;
  entities: HurtboxEntity[];
  /**
   * Projectile spawn point — the simulated weapon hand at release (wall-safe:
   * falls back to the player center when a wall sits between body and hand).
   */
  spawnPosition: { x: number; y: number };
  resolveMeleeDamage: (
    player: Player,
    hitEntityIds: string[],
    damage: number,
    knockback: number,
    weaponType: import('@sector-battle/shared').WeaponType,
    weaponSlot: number,
    events: GameEvent[],
  ) => void;
}

export interface IAttackHandler {
  attackType: AttackType;
  execute(player: Player, params: AttackParams, ctx: AttackContext): GameEvent[];
}
