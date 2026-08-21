import { InputAction } from '../enums/InputAction.js';

const ACTION_TO_BIT: Record<string, number> = {
  MOVE: InputAction.MOVE,
  ATTACK: InputAction.ATTACK,
  THROW: InputAction.THROW,
  PICKUP: InputAction.PICKUP,
  SWITCH_SLOT: InputAction.SWITCH_SLOT,
  DASH: InputAction.DASH,
};

const BIT_TO_ACTION: string[] = ['MOVE', 'ATTACK', 'THROW', 'PICKUP', 'SWITCH_SLOT', 'DASH'];

export function actionsToBitmask(actions: readonly string[]): number {
  let mask = 0;
  for (let i = 0; i < actions.length; i++) {
    const bit = ACTION_TO_BIT[actions[i]!];
    if (bit !== undefined) mask |= 1 << bit;
  }
  return mask;
}

export function hasAction(bitmask: number, action: string): boolean {
  const bit = ACTION_TO_BIT[action];
  return bit !== undefined ? (bitmask & (1 << bit)) !== 0 : false;
}

export function bitmaskToActions(bitmask: number): string[] {
  const result: string[] = [];
  bitmaskToActionsInto(bitmask, result);
  return result;
}

export function bitmaskToActionsInto(bitmask: number, target: string[]): void {
  target.length = 0;
  for (let i = 0; i < BIT_TO_ACTION.length; i++) {
    if ((bitmask & (1 << i)) !== 0) {
      target.push(BIT_TO_ACTION[i]!);
    }
  }
}
