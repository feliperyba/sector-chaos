import { Position } from '../value-objects/index.ts';

export class Explosion {
  readonly id: string;
  readonly ownerId: string;
  position: Position;
  damage: number;
  ticksRemaining: number;

  constructor(id: string, ownerId: string, position: Position, damage: number, duration: number) {
    this.id = id;
    this.ownerId = ownerId;
    this.position = position;
    this.damage = damage;
    this.ticksRemaining = duration;
  }

  tick(): boolean {
    this.ticksRemaining--;
    return this.ticksRemaining <= 0;
  }
}
