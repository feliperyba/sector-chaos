import { Schema, type } from '@colyseus/schema';

export class PowerUpSchema extends Schema {
  @type('string') id: string = '';
  @type('uint8') type: number = 0;
  @type('float32') x: number = 0;
  @type('float32') y: number = 0;
  @type('boolean') isActive: boolean = true;
}
