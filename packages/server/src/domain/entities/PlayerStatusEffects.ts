import { PlayerStatus, type PlayerStatusType } from '@sector-battle/shared';
import { PLAYER } from '@sector-battle/shared';

/**
 * Status effects and lifecycle flags — stateful domain object.
 * Owns barrier, fresh spawn, stagger, DOTs, death tracking.
 */
export class PlayerStatusEffects {
  status: number;
  barrierActive: boolean = false;
  barrierExpiryTick: number = 0;
  speedBoostExpiryTick: number = 0;
  freshSpawnExpiryTick: number = 0;
  deathTick: number = -1;
  lastDamageTick: number = -Infinity;
  lastDamageSource: { playerId: string; weaponType: string; tick: number } | null = null;
  stunExpiryTick: number = 0;
  staggerRemaining: number = 0;
  activeDOTs: Map<
    string,
    {
      damagePerTick: number;
      remainingTicks: number;
      tickIntervalTicks: number;
      accumulator: number;
    }
  > = new Map();

  constructor() {
    this.status = PlayerStatus.ALIVE | PlayerStatus.INVINCIBLE | PlayerStatus.FRESH_SPAWN;
  }

  // --- Status bitmask ---

  isAlive(): boolean {
    return !!(this.status & PlayerStatus.ALIVE);
  }

  isDead(): boolean {
    return !!(this.status & PlayerStatus.DEAD);
  }

  isSpectating(): boolean {
    return !!(this.status & PlayerStatus.SPECTATING);
  }

  isStaggered(): boolean {
    return !!(this.status & PlayerStatus.STAGGERED);
  }

  isDying(): boolean {
    return !!(this.status & PlayerStatus.DYING);
  }

  isInvincibleStatus(): boolean {
    return !!(this.status & PlayerStatus.INVINCIBLE);
  }

  setStatus(flag: PlayerStatusType): void {
    this.status |= flag;
  }

  clearStatus(flag: PlayerStatusType): void {
    this.status &= ~flag;
  }

  hasStatus(flag: PlayerStatusType): boolean {
    return !!(this.status & flag);
  }

  // --- Barrier ---

  activateBarrier(currentTick: number, durationTicks: number): void {
    this.barrierActive = true;
    this.barrierExpiryTick = currentTick + durationTicks;
    this.status |= PlayerStatus.INVINCIBLE;
  }

  isBarrierActive(currentTick: number): boolean {
    return this.barrierExpiryTick > 0 && currentTick < this.barrierExpiryTick;
  }

  expireBarrier(currentTick: number, isFreshSpawnInvulnerable: boolean): void {
    if (this.barrierExpiryTick > 0 && currentTick >= this.barrierExpiryTick) {
      this.barrierActive = false;
      this.barrierExpiryTick = 0;
      if (!isFreshSpawnInvulnerable) {
        this.status &= ~PlayerStatus.INVINCIBLE;
      }
    }
  }

  // --- Fresh Spawn ---

  isFreshSpawn(): boolean {
    return !!(this.status & PlayerStatus.FRESH_SPAWN);
  }

  isFreshSpawnActive(currentTick: number): boolean {
    return !!(this.status & PlayerStatus.FRESH_SPAWN) && currentTick < this.freshSpawnExpiryTick;
  }

  isFreshSpawnInvulnerable(currentTick: number): boolean {
    return !!(this.status & PlayerStatus.FRESH_SPAWN) && currentTick < this.freshSpawnExpiryTick;
  }

  isInvulnerable(currentTick: number, bypassBarrier: boolean = false): boolean {
    const barrierActive = !bypassBarrier && this.isBarrierActive(currentTick);
    return barrierActive || this.isFreshSpawnInvulnerable(currentTick);
  }

  expireFreshSpawn(currentTick: number, isBarrierActive: boolean): void {
    if (this.status & PlayerStatus.FRESH_SPAWN) {
      if (currentTick >= this.freshSpawnExpiryTick) {
        this.status &= ~PlayerStatus.FRESH_SPAWN;
        if (!isBarrierActive) {
          this.status &= ~PlayerStatus.INVINCIBLE;
        }
      }
    }
  }

  // --- Stagger ---

  startStagger(durationMs: number, tickRate: number): void {
    this.status |= PlayerStatus.STAGGERED;
    this.staggerRemaining = Math.ceil((durationMs / 1000) * tickRate);
  }

  updateStagger(ticks: number): boolean {
    if (this.staggerRemaining <= 0) return false;
    this.staggerRemaining = Math.max(0, this.staggerRemaining - ticks);
    if (this.staggerRemaining <= 0) {
      this.status &= ~PlayerStatus.STAGGERED;
      return true; // stagger ended
    }
    return false;
  }

  // --- DOTs ---

  applyDOT(sourceId: string, damagePerTick: number, duration: number, tickInterval: number): void {
    this.activeDOTs.set(sourceId, {
      damagePerTick,
      remainingTicks: duration,
      tickIntervalTicks: tickInterval,
      accumulator: 0,
    });
  }

  tickDOTs(): Array<{ sourceId: string; amount: number }> {
    const results: Array<{ sourceId: string; amount: number }> = [];
    for (const [sourceId, dot] of this.activeDOTs) {
      dot.remainingTicks--;
      dot.accumulator++;
      if (dot.accumulator >= dot.tickIntervalTicks) {
        dot.accumulator = 0;
        results.push({ sourceId, amount: dot.damagePerTick });
      }
      if (dot.remainingTicks <= 0) {
        this.activeDOTs.delete(sourceId);
      }
    }
    return results;
  }

  // --- Death lifecycle ---

  initFreshSpawn(currentTick: number): void {
    const spawnInvincibilityTicks = Math.ceil(PLAYER.SPAWN_INVINCIBILITY * 60);
    this.freshSpawnExpiryTick = currentTick + spawnInvincibilityTicks;
  }
}
