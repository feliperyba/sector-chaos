import { CRATE_LOOT, BARREL } from '@sector-battle/shared';
import { Position } from '../value-objects/index.ts';

export type DestructibleType = 'crate' | 'barrel' | 'iron' | 'wall' | 'light';

export interface DamageResult {
  destroyed: boolean;
  shouldExplode: boolean;
}

export interface DestructibleDamageContext {
  source: 'melee' | 'thrown' | 'arrow' | 'explosion' | 'other';
  rawDamage: number;
  /**
   * Juice-pass-1 ticket 05 — the simulation tick the hit lands on. Stamps a
   * primed barrel's fuse expiry (`currentTick + BARREL.FUSE_TICKS`). All four
   * production callers pass it; omitted (treated as tick 0) only by legacy
   * unit-test literals that never run the fuse step.
   */
  currentTick?: number;
}

export class Destructible {
  static readonly CRATE_LOOT_DROP_CHANCE = CRATE_LOOT.DROP_CHANCE;
  static readonly CRATE_WEAPON_SPLIT = CRATE_LOOT.WEAPON_SPLIT;
  static readonly CRATE_WEAPON_TIER_WEIGHTS = CRATE_LOOT.WEAPON_TIER_WEIGHTS;
  static readonly CRATE_POWERUP_WEIGHTS = CRATE_LOOT.POWERUP_WEIGHTS;

  readonly id: string;
  readonly type: DestructibleType;
  hp: number;
  readonly maxHp: number;
  position: Position;
  isDestroyed: boolean;
  /**
   * Juice-pass-1 ticket 05 (GDD §5.5/§7.15) — primed-barrel fuse. Barrels
   * only: the first hit that leaves the barrel alive (in practice
   * melee/thrown/arrow — explosions one-shot) primes a 5 s server-
   * authoritative fuse. Game-tick based, never wall-clock. At expiry the
   * barrel auto-explodes through the same destroy path as a killing hit.
   * Every destructible spawns unprimed; only a surviving hit sets this.
   */
  primed: boolean;
  /** Game tick at which a primed barrel's fuse expires (0 while unprimed). */
  fuseExpiresAtTick: number;
  readonly textureKey: string;
  readonly rotation: number;
  readonly flipH: boolean;
  readonly flipV: boolean;

  private constructor(
    id: string,
    type: DestructibleType,
    position: Position,
    textureKey: string = '',
    rotation: number = 0,
    flipH: boolean = false,
    flipV: boolean = false,
  ) {
    this.id = id;
    this.type = type;
    this.position = position;
    this.isDestroyed = false;
    this.primed = false;
    this.fuseExpiresAtTick = 0;
    this.textureKey = textureKey;
    this.rotation = rotation;
    this.flipH = flipH;
    this.flipV = flipV;

    switch (type) {
      case 'crate':
        this.maxHp = 2;
        break;
      case 'barrel':
        // Juice-pass-1 ticket 05 (GDD §5.5): flat two-hit barrels — HP 2,
        // every melee/thrown/arrow hit costs exactly 1 (see takeDamage).
        this.maxHp = 2;
        break;
      case 'iron':
        this.maxHp = Infinity;
        break;
      case 'wall':
        this.maxHp = 10;
        break;
      case 'light':
        // Map-polish ticket 07 — the light-prop fixture (sconce/brazier/
        // crystal): any single hit smashes it (GDD §5.5.1's 1-HP-per-hit
        // convention; a fixture is flimsier than a crate). No loot drop, no
        // explosion — GDD-silent values flagged for owner ratification
        // (ticket 09's GDD §5.5 amendment).
        this.maxHp = 1;
        break;
    }

    this.hp = this.maxHp;
  }

  get isActive(): boolean {
    return !this.isDestroyed;
  }

  /**
   * Map-polish ticket 07/09 — the NON-SOLID ruling's single source of truth:
   * a destructible whose map tile stays EMPTY (blocks no movement, no
   * projectile; hits arrive via the entity index only). Today only the
   * light-prop fixture qualifies; keying on this property (not the type
   * string) keeps future non-solid destructible types correct everywhere
   * (the loot sweep's tick-1 guard, the hurtbox gathering's contact
   * fallback).
   */
  get nonSolid(): boolean {
    return this.type === 'light';
  }

  static create(
    id: string,
    type: DestructibleType,
    position: Position,
    textureKey: string = '',
    rotation: number = 0,
    flipH: boolean = false,
    flipV: boolean = false,
  ): Destructible {
    return new Destructible(id, type, position, textureKey, rotation, flipH, flipV);
  }

  takeDamage(context: DestructibleDamageContext): DamageResult {
    if (this.type === 'iron') {
      return { destroyed: false, shouldExplode: false };
    }

    if (this.isDestroyed) {
      return { destroyed: true, shouldExplode: false };
    }

    // Juice-pass-1 ticket 05 (GDD §5.5/§5.5.1) — barrel-only damage
    // override: every melee hit, thrown collision, and arrow hit costs
    // EXACTLY 1 HP regardless of the weapon's destructibleDamage (a Fists
    // punch and a Hammer swing prime identically). Explosions keep their
    // full raw damage (one-shot at HP 2); crates/walls/light keep per-weapon
    // damage untouched.
    const isFlatBarrelHit =
      this.type === 'barrel' &&
      (context.source === 'melee' || context.source === 'thrown' || context.source === 'arrow');
    const hpLoss = isFlatBarrelHit ? 1 : context.rawDamage;
    this.hp = Math.max(0, this.hp - hpLoss);

    if (this.hp <= 0 && !this.isDestroyed) {
      this.isDestroyed = true;
      return {
        destroyed: true,
        shouldExplode: this.type === 'barrel',
      };
    }

    // Any hit that leaves a BARREL alive primes its 5 s fuse (GDD §5.5):
    // expiry is stamped from the hit's tick, never wall-clock. First
    // surviving hit only — a re-prime can never extend a fuse.
    if (this.type === 'barrel' && !this.primed) {
      this.primed = true;
      this.fuseExpiresAtTick = (context.currentTick ?? 0) + BARREL.FUSE_TICKS;
    }

    return { destroyed: false, shouldExplode: false };
  }
}
