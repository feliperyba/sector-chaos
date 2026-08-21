import { Schema, type, ArraySchema } from '@colyseus/schema';
import { WeaponSchema } from './WeaponSchema.ts';

export class PlayerSchema extends Schema {
  @type('string') id: string = '';
  @type('string') name: string = '';
  @type('uint8') color: number = 0;
  @type('float32') x: number = 0;
  @type('float32') y: number = 0;
  @type('uint8') direction: number = 0;
  @type('float32') facingAngle: number = 0;
  @type('float32') speed: number = 0;
  @type('float32') velocityX: number = 0;
  @type('float32') velocityY: number = 0;
  @type('uint8') health: number = 0;
  @type('uint8') maxHealth: number = 0;
  @type('uint8') status: number = 0;
  @type('uint8') kills: number = 0;
  @type('uint8') activeSlot: number = 0;
  @type('uint32') lastDamageTick: number = 0;
  @type('uint16') dashCooldown: number = 0;
  @type('boolean') barrierActive: boolean = false;
  @type('boolean') isBlocking: boolean = false;
  @type('boolean') speedBoostActive: boolean = false;
  @type('boolean') connected: boolean = true;
  @type('boolean') isBot: boolean = false;
  @type('boolean') isWindupActive: boolean = false;
  @type('uint8') windupWeaponType: number = 0;
  @type('string') windupAttackType: string = '';
  @type('uint8') animPhase: number = 0;
  @type('uint32') animPhaseStartTick: number = 0;
  @type('uint8') comboIndex: number = 0;
  @type('uint32') barrierExpiryTick: number = 0;
  @type('uint32') speedBoostExpiryTick: number = 0;
  @type('uint32') freshSpawnExpiryTick: number = 0;
  @type('uint32') lastProcessedInput: number = 0;
  @type([WeaponSchema]) weapons = new ArraySchema<WeaponSchema>();
  @type(['string']) items = new ArraySchema<string>();
}
