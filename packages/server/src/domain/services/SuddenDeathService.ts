import { ZONE } from '@sector-battle/shared';
import type { GameEvent } from '../events/index.ts';
import { EventCollector } from '../shared/EventCollector.ts';

export interface SuddenDeathConfig {
  escalationIntervalMs: number;
  damagePerEscalation: number;
  shrinkRateMultiplier: number;
  shrinkSpeed: number;
}

const DEFAULT_CONFIG: SuddenDeathConfig = {
  escalationIntervalMs: ZONE.SUDDEN_DEATH_ESCALATION_INTERVAL_MS,
  damagePerEscalation: ZONE.SUDDEN_DEATH_DAMAGE_PER_ESCALATION,
  shrinkRateMultiplier: ZONE.SUDDEN_DEATH_SHRINK_RATE_MULTIPLIER,
  shrinkSpeed: ZONE.SUDDEN_DEATH_SHRINK_SPEED,
};

export interface SuddenDeathState {
  active: boolean;
  startTime: number;
  elapsedMs: number;
  remainingPlayerIds: string[];
  escalationLevel: number;
  currentDamagePerTick: number;
  shrinkRateMultiplier: number;
}

export class SuddenDeathService {
  private active: boolean = false;
  private startTime: number = 0;
  private elapsedMs: number = 0;
  private remainingPlayerIds: string[] = [];
  private eventCollector = new EventCollector<GameEvent>();
  private escalationLevel: number = 0;
  private lastEscalationMs: number = 0;
  private config: SuddenDeathConfig;

  constructor(config?: Partial<SuddenDeathConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  activate(timestamp: number, remainingPlayerIds: string[]): void {
    this.active = true;
    this.startTime = timestamp;
    this.elapsedMs = 0;
    this.lastEscalationMs = 0;
    this.escalationLevel = 0;
    this.remainingPlayerIds = [...remainingPlayerIds];
    this.eventCollector.emit({
      type: 'SuddenDeathTriggered',
      tick: 0,
      timestamp,
      remainingPlayers: [...remainingPlayerIds],
    });
  }

  update(deltaMs: number): void {
    if (!this.active) return;

    this.elapsedMs += deltaMs;

    const timeSinceLastEscalation = this.elapsedMs - this.lastEscalationMs;
    if (timeSinceLastEscalation >= this.config.escalationIntervalMs) {
      this.escalationLevel++;
      this.lastEscalationMs = this.elapsedMs;
      this.eventCollector.emit({
        type: 'SuddenDeathEscalation',
        tick: 0,
        timestamp: Date.now(),
        level: this.escalationLevel,
        damagePerTick: this.getDamagePerTick(),
        shrinkRateMultiplier: this.config.shrinkRateMultiplier,
      });
    }
  }

  getDamagePerTick(): number {
    return ZONE.ZONE_DAMAGE_SUDDEN_DEATH + this.escalationLevel * this.config.damagePerEscalation;
  }

  getShrinkRateMultiplier(): number {
    return this.config.shrinkRateMultiplier;
  }

  getShrinkSpeed(): number {
    return this.config.shrinkSpeed;
  }

  getEscalationLevel(): number {
    return this.escalationLevel;
  }

  getState(): SuddenDeathState {
    return {
      active: this.active,
      startTime: this.startTime,
      elapsedMs: this.elapsedMs,
      remainingPlayerIds: [...this.remainingPlayerIds],
      escalationLevel: this.escalationLevel,
      currentDamagePerTick: this.getDamagePerTick(),
      shrinkRateMultiplier: this.config.shrinkRateMultiplier,
    };
  }

  drainEvents(): GameEvent[] {
    return this.eventCollector.drain();
  }
}
