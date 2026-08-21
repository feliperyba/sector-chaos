import { Schema, type } from '@colyseus/schema';

export class SiegeSectorSchema extends Schema {
  @type('uint8') row: number = 0;
  @type('uint8') col: number = 0;
  @type('boolean') active: boolean = true;
}

export class MapSiegeProgressSchema extends Schema {
  @type('uint8') northOffset: number = 0;
  @type('uint8') eastOffset: number = 0;
  @type('uint8') southOffset: number = 0;
  @type('uint8') westOffset: number = 0;
}
