import { Schema, type } from '@colyseus/schema';

export class TrapSchema extends Schema {
  @type('string') id: string = '';
  @type('uint8') type: number = 0;
  @type('float32') x: number = 0;
  @type('float32') y: number = 0;
  @type('boolean') isRevealed: boolean = false;
  @type('float32') cooldownRemaining: number = 0;
  @type('string') textureKey = '';
  @type('float32') rotation: number = 0;
  @type('boolean') flipH: boolean = false;
  @type('boolean') flipV: boolean = false;
  @type('boolean') fireAreaActive: boolean = false;
  @type('float32') fireAreaRemainingMs: number = 0;
}
