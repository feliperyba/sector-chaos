import { WeaponType, WeaponTier, FISTS_INFINITE_DURABILITY } from '@sector-battle/shared';

export class WeaponEntity {
  readonly id: string;
  readonly type: WeaponType;
  readonly tier: WeaponTier;
  ammo: number;
  readonly maxAmmo: number;
  cooldownRemaining: number;
  readonly cooldown: number;

  constructor(
    id: string,
    type: WeaponType,
    tier: WeaponTier,
    ammo: number,
    maxAmmo: number,
    cooldown: number,
  ) {
    this.id = id;
    this.type = type;
    this.tier = tier;
    this.ammo = ammo;
    this.maxAmmo = maxAmmo;
    this.cooldownRemaining = 0;
    this.cooldown = Math.max(1, cooldown);
  }

  use(): boolean {
    if (!this.canUse) return false;
    if (this.ammo !== FISTS_INFINITE_DURABILITY) this.ammo--;
    this.cooldownRemaining = this.cooldown;
    return true;
  }

  startAttack(): boolean {
    if (!this.canUse) return false;
    this.cooldownRemaining = this.cooldown;
    return true;
  }

  startAttackWithCooldown(customCooldownTicks: number): boolean {
    if (!this.canUse) return false;
    this.cooldownRemaining = Math.max(1, customCooldownTicks);
    return true;
  }

  consumeDurability(amount: number): number {
    if (this.ammo === FISTS_INFINITE_DURABILITY) return this.ammo;
    this.ammo = Math.max(0, this.ammo - amount);
    return this.ammo;
  }

  get durability(): number {
    return this.ammo;
  }

  get isBroken(): boolean {
    return this.ammo === 0;
  }

  tick(): void {
    if (this.cooldownRemaining > 0) {
      this.cooldownRemaining--;
    }
  }

  get canUse(): boolean {
    return (
      (this.ammo > 0 || this.ammo === FISTS_INFINITE_DURABILITY) && this.cooldownRemaining <= 0
    );
  }
}
