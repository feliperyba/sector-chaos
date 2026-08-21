import { POWERUP } from '@sector-battle/shared';
import { Position } from '../value-objects/index.ts';

export type GamePowerUpType = 'health_pack' | 'barrier' | 'speed_boost';

export interface PowerUpEffect {
  type: 'speed_boost' | 'barrier' | 'health_pack';
  multiplier?: number;
  duration: number;
  amount?: number;
  isRefresh?: boolean;
}

export class PowerUp {
  readonly id: string;
  readonly type: GamePowerUpType;
  position: Position;
  readonly spawnTime: number;
  isActive: boolean;

  private constructor(id: string, type: GamePowerUpType, position: Position, spawnTime: number) {
    this.id = id;
    this.type = type;
    this.position = position;
    this.spawnTime = spawnTime;
    this.isActive = true;
  }

  static create(id: string, type: GamePowerUpType, position: Position, spawnTime: number): PowerUp {
    return new PowerUp(id, type, position, spawnTime);
  }

  applyTo(hasExistingEffect: boolean): PowerUpEffect {
    switch (this.type) {
      case 'speed_boost':
        return {
          type: 'speed_boost',
          multiplier: POWERUP.SPEED_BOOST_MULTIPLIER,
          duration: POWERUP.SPEED_BOOST_DURATION,
          isRefresh: hasExistingEffect,
        };
      case 'barrier':
        return {
          type: 'barrier',
          duration: POWERUP.BARRIER_DURATION,
          isRefresh: hasExistingEffect,
        };
      case 'health_pack':
        return { type: 'health_pack', duration: 0, amount: POWERUP.HEALTH_PACK_HEAL };
    }
  }

  deactivate(): void {
    this.isActive = false;
  }
}
