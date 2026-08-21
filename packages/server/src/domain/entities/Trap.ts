import { Position } from '../value-objects/index.ts';
import { TRAP, TrapType } from '@sector-battle/shared';

export interface TrapEffect {
  type: 'damage' | 'damage_over_time' | 'teleport' | 'knockback';
  amount?: number;
  amountPerTick?: number;
  tickInterval?: number;
  duration?: number;
  targetId?: string;
  destination?: { x: number; y: number };
  stunDuration?: number;
  sourceId?: string;
  knockbackForce?: number;
  knockbackDirection?: { x: number; y: number };
}

interface TrapConfig {
  damage?: number;
  instantDamage?: number;
  dotDamagePerSecond?: number;
  dotDuration?: number;
  radius: number;
  cooldownTicks: number;
  knockbackDistance?: number;
  stunDuration?: number;
  areaRadius?: number;
  areaDurationTicks?: number;
  areaDotPerTick?: number;
}

const TRAP_CONFIGS: Record<TrapType, TrapConfig> = {
  [TrapType.SPIKE]: {
    damage: TRAP.SPIKE_DAMAGE,
    radius: TRAP.TRIGGER_RADIUS,
    cooldownTicks: TRAP.SPIKE_COOLDOWN_TICKS,
    knockbackDistance: TRAP.SPIKE_KNOCKBACK,
    stunDuration: TRAP.SPIKE_STUN_DURATION,
  },
  [TrapType.FIRE]: {
    instantDamage: TRAP.FIRE_INSTANT_DAMAGE,
    radius: TRAP.TRIGGER_RADIUS,
    cooldownTicks: 0,
    areaRadius: TRAP.FIRE_AREA_RADIUS,
    areaDurationTicks: TRAP.FIRE_DURATION_TICKS,
    areaDotPerTick: TRAP.FIRE_DOT_PER_TICK,
  },
  [TrapType.TELEPORT]: {
    damage: 0,
    radius: TRAP.TRIGGER_RADIUS,
    cooldownTicks: TRAP.TELEPORT_COOLDOWN_TICKS,
  },
};

export class Trap {
  readonly id: string;
  readonly type: TrapType;
  position: Position;
  cooldownRemaining: number;
  lastTriggerTime: number;
  isRevealed: boolean;
  readonly textureKey: string;
  readonly rotation: number;
  readonly flipH: boolean;
  readonly flipV: boolean;
  fireAreaActive: boolean;
  fireAreaRemainingTicks: number;

  private constructor(
    id: string,
    type: TrapType,
    position: Position,
    textureKey: string = '',
    rotation: number = 0,
    flipH: boolean = false,
    flipV: boolean = false,
  ) {
    this.id = id;
    this.type = type;
    this.position = position;
    this.cooldownRemaining = 0;
    this.lastTriggerTime = -Infinity;
    this.isRevealed = false;
    this.textureKey = textureKey;
    this.rotation = rotation;
    this.flipH = flipH;
    this.flipV = flipV;
    this.fireAreaActive = false;
    this.fireAreaRemainingTicks = 0;
  }

  static create(
    id: string,
    type: TrapType,
    position: Position,
    textureKey: string = '',
    rotation: number = 0,
    flipH: boolean = false,
    flipV: boolean = false,
  ): Trap {
    return new Trap(id, type, position, textureKey, rotation, flipH, flipV);
  }

  reveal(): void {
    this.isRevealed = true;
  }

  canTrigger(currentTick: number): boolean {
    if (this.cooldownRemaining > 0) return false;
    if (this.type === TrapType.FIRE && this.fireAreaActive) return false;
    return currentTick - this.lastTriggerTime >= this.getCooldownTicks();
  }

  trigger(currentTick: number, targetId: string): TrapEffect[] {
    this.lastTriggerTime = currentTick;
    this.isRevealed = true;
    this.cooldownRemaining = this.getCooldownTicks();

    switch (this.type) {
      case TrapType.SPIKE:
        return this.triggerSpike(targetId);
      case TrapType.FIRE:
        return this.triggerFire(targetId);
      case TrapType.TELEPORT:
        return [{ type: 'teleport' as const, targetId }];
      default:
        return [{ type: 'damage', amount: 0, targetId }];
    }
  }

  private triggerSpike(targetId: string): TrapEffect[] {
    const config = TRAP_CONFIGS[TrapType.SPIKE];
    return [
      {
        type: 'damage',
        amount: config.damage ?? 15,
        stunDuration: config.stunDuration ?? 0.2,
        targetId,
      },
      { type: 'knockback', targetId, knockbackForce: config.knockbackDistance ?? 128 },
    ];
  }

  private triggerFire(targetId: string): TrapEffect[] {
    const config = TRAP_CONFIGS[TrapType.FIRE];
    this.fireAreaActive = true;
    this.fireAreaRemainingTicks = config.areaDurationTicks ?? 300;
    // GDD §10.2.2: "No instant damage on trigger." Fire traps ignite an area
    // DOT instead. Return an empty effects array — the area tick handles all
    // damage. Keeping the array empty (rather than emitting a 0-damage effect)
    // avoids driving a no-op processDamage call downstream.
    const instantDamage = config.instantDamage ?? 0;
    if (instantDamage <= 0) return [];
    return [{ type: 'damage', amount: instantDamage, targetId }];
  }

  tickCooldown(dt: number): void {
    if (this.cooldownRemaining > 0) {
      this.cooldownRemaining = Math.max(0, this.cooldownRemaining - dt);
    }
    if (this.fireAreaActive) {
      this.fireAreaRemainingTicks -= dt;
      if (this.fireAreaRemainingTicks <= 0) {
        this.fireAreaActive = false;
        this.fireAreaRemainingTicks = 0;
      }
    }
  }

  resetFireCooldown(): void {
    const config = TRAP_CONFIGS[TrapType.FIRE];
    this.fireAreaRemainingTicks = config.areaDurationTicks ?? 300;
  }

  getFireAreaDotPerTick(): number {
    return TRAP_CONFIGS[TrapType.FIRE].areaDotPerTick ?? 2;
  }

  getFireAreaRadius(): number {
    return TRAP_CONFIGS[TrapType.FIRE].areaRadius ?? 1;
  }

  getTriggerRadius(): number {
    return TRAP_CONFIGS[this.type].radius;
  }

  private getCooldownTicks(): number {
    return TRAP_CONFIGS[this.type].cooldownTicks ?? 0;
  }
}
