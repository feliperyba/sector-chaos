import { Schema, type } from '@colyseus/schema';

export class ProjectileSchema extends Schema {
  @type('string') id: string = '';
  @type('string') ownerId: string = '';
  @type('float32') x: number = 0;
  @type('float32') y: number = 0;
  @type('float32') velocityX: number = 0;
  @type('float32') velocityY: number = 0;
  @type('uint8') damage: number = 0;
  @type('int16') bounces: number = 0;
  @type('uint8') weaponType: number = 0;
  @type('uint8') tier: number = 0;
}
