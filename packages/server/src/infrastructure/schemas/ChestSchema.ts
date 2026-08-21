import { Schema, type } from '@colyseus/schema';

export class ChestSchema extends Schema {
  @type('string') id: string = '';
  @type('uint8') tier: number = 0;
  @type('float32') x: number = 0;
  @type('float32') y: number = 0;
  @type('uint8') state: number = 0;
  @type('string') openingPlayerId: string = '';
  @type('float32') openingProgress: number = 0;
  @type('string') textureKey = '';
  @type('float32') rotation: number = 0;
  @type('boolean') flipH: boolean = false;
  @type('boolean') flipV: boolean = false;
}
