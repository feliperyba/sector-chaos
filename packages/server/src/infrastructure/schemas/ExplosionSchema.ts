import { Schema, type } from '@colyseus/schema';

export class ExplosionSchema extends Schema {
  @type('string') id: string = '';
  @type('string') ownerId: string = '';
  @type('float32') x: number = 0;
  @type('float32') y: number = 0;
  @type('uint16') radius: number = 0;
  @type('uint8') damage: number = 0;
}
