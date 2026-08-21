import { Position, GridCoord } from '../value-objects/index.ts';

export class Exit {
  readonly id: string;
  position: Position;
  gridCoord: GridCoord;
  active: boolean;
  sectorIndex: number;
  readonly textureKey: string;
  readonly rotation: number;
  readonly flipH: boolean;
  readonly flipV: boolean;

  constructor(
    id: string,
    position: Position,
    gridCoord: GridCoord,
    sectorIndex: number,
    active: boolean = false,
    textureKey: string = '',
    rotation: number = 0,
    flipH: boolean = false,
    flipV: boolean = false,
  ) {
    this.id = id;
    this.position = position;
    this.gridCoord = gridCoord;
    this.active = active;
    this.sectorIndex = sectorIndex;
    this.textureKey = textureKey;
    this.rotation = rotation;
    this.flipH = flipH;
    this.flipV = flipV;
  }

  activate(): void {
    this.active = true;
  }
}
