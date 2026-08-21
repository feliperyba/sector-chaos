import { Schema, type } from '@colyseus/schema';

export class DestructibleSchema extends Schema {
  @type('string') id: string = '';
  @type('uint8') type: number = 0;
  @type('uint8') hp: number = 0;
  @type('uint8') maxHp: number = 0;
  @type('float32') x: number = 0;
  @type('float32') y: number = 0;
  @type('boolean') isDestroyed: boolean = false;
  // Juice-pass-1 ticket 05 — primed-barrel fuse on the wire (GDD §5.5):
  // live-synced so the client's escalating fire (ticket 06) can read the
  // fuse progress. Barrels only; always false/0 for every other type.
  @type('boolean') primed: boolean = false;
  @type('uint32') fuseExpiresAtTick: number = 0;
  @type('string') textureKey = '';
  @type('float32') rotation: number = 0;
  @type('boolean') flipH: boolean = false;
  @type('boolean') flipV: boolean = false;
}
