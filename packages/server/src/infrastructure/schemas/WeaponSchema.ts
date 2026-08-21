import { Schema, type } from '@colyseus/schema';

export class WeaponSchema extends Schema {
  @type('string') id: string = '';
  @type('uint8') weaponType: number = 0;
  @type('uint8') tier: number = 0;
  @type('uint16') ammo: number = 0;
  @type('uint16') maxAmmo: number = 0;
}
