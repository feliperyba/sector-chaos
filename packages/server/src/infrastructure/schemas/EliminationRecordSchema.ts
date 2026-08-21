import { Schema, type } from '@colyseus/schema';

export class EliminationRecordSchema extends Schema {
  @type('uint8') order: number = 0;
  @type('string') playerId: string = '';
  @type('string') killerId: string = '';
  @type('uint8') weaponType: number = 0;
  @type('float64') timestamp: number = 0;
}
