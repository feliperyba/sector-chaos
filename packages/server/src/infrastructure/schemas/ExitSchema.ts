import { Schema, type } from '@colyseus/schema';

export class ExitSchema extends Schema {
  @type('string') id: string = '';
  @type('float32') x: number = 0;
  @type('float32') y: number = 0;
  @type('uint8') gridX: number = 0;
  @type('uint8') gridY: number = 0;
  @type('uint8') sectorIndex: number = 0;
  @type('boolean') active: boolean = false;
  @type('string') textureKey: string = '';
  @type('float32') rotation: number = 0;
  @type('boolean') flipH: boolean = false;
  @type('boolean') flipV: boolean = false;
}
