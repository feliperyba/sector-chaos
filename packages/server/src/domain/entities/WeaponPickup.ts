import { Position } from '../value-objects/index.ts';
import { type WeaponEntity } from './Weapon.ts';

export class WeaponPickup {
  readonly id: string;
  readonly weapon: WeaponEntity;
  readonly position: Position;
  readonly spawnTick: number;
  isActive: boolean;
  readonly textureKey: string;
  readonly rotation: number;
  readonly flipH: boolean;
  readonly flipV: boolean;

  private constructor(
    id: string,
    weapon: WeaponEntity,
    position: Position,
    spawnTick: number,
    textureKey: string = '',
    rotation: number = 0,
    flipH: boolean = false,
    flipV: boolean = false,
  ) {
    this.id = id;
    this.weapon = weapon;
    this.position = position;
    this.spawnTick = spawnTick;
    this.isActive = true;
    this.textureKey = textureKey;
    this.rotation = rotation;
    this.flipH = flipH;
    this.flipV = flipV;
  }

  static create(
    id: string,
    weapon: WeaponEntity,
    position: Position,
    spawnTick: number,
    textureKey: string = '',
    rotation: number = 0,
    flipH: boolean = false,
    flipV: boolean = false,
  ): WeaponPickup {
    return new WeaponPickup(id, weapon, position, spawnTick, textureKey, rotation, flipH, flipV);
  }

  deactivate(): void {
    this.isActive = false;
  }
}
