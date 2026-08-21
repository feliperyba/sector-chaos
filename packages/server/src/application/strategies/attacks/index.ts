import { AttackType } from '@sector-battle/shared';
import type { IAttackHandler } from './types.ts';
import { ShieldAttackHandler } from './ShieldAttackHandler.ts';
import { ArcAttackHandler } from './ArcAttackHandler.ts';
import { LineAttackHandler } from './LineAttackHandler.ts';
import { ThrownAttackHandler } from './ThrownAttackHandler.ts';
import { RangedAttackHandler } from './RangedAttackHandler.ts';

export type { IAttackHandler, AttackParams, AttackContext } from './types.ts';

export const attackHandlers: IAttackHandler[] = [
  new ShieldAttackHandler(),
  new ArcAttackHandler(),
  new LineAttackHandler(),
  new ThrownAttackHandler(),
  new RangedAttackHandler(),
];

export const AttackHandlerRegistry = new Map<AttackType, IAttackHandler>(
  attackHandlers.map((h) => [h.attackType, h]),
);
