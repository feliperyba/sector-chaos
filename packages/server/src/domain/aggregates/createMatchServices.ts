import { ObjectPool, WeaponType, type GameConfig } from '@sector-battle/shared';
import { Position } from '../value-objects/index.ts';
import { Projectile, Explosion } from '../entities/index.ts';
import { CollisionService } from '../services/CollisionService.ts';
import { DamagePipeline } from '../services/DamagePipeline.ts';
import { ThrowHandler } from '../handlers/ThrowHandler.ts';
import { RangedHandler } from '../handlers/RangedHandler.ts';
import { ShieldHandler } from '../handlers/ShieldHandler.ts';
import { LootService } from '../services/LootService.ts';

export interface MatchServices {
  collisionService: CollisionService;
  shieldHandler: ShieldHandler;
  damagePipeline: DamagePipeline;
  throwHandler: ThrowHandler;
  rangedHandler: RangedHandler;
  lootService: LootService;
}

export interface ProjectileMeta {
  createdAtTick: number;
  distanceTraveled: number;
  embeddedTick: number;
}

export interface MatchPools {
  projectilePool: ObjectPool<Projectile>;
  explosionPool: ObjectPool<Explosion>;
  projectileMeta: Map<string, ProjectileMeta>;
}

export function createMatchServices(config: GameConfig): MatchServices {
  const shieldHandler = new ShieldHandler();
  const damagePipeline = new DamagePipeline(shieldHandler);
  return {
    collisionService: new CollisionService(config.map.tileWidth),
    shieldHandler,
    damagePipeline,
    throwHandler: new ThrowHandler(),
    rangedHandler: new RangedHandler(),
    lootService: new LootService(),
  };
}

export function createMatchPools(): MatchPools {
  const projectilePool = new ObjectPool<Projectile>(
    () => new Projectile('', '', new Position(0, 0), 0, 0, 0, 0, WeaponType.DAGGER, 0, 0),
    (p) => {
      p.position = new Position(0, 0);
      p.velocityX = 0;
      p.velocityY = 0;
      p.damage = 0;
      p.bouncesRemaining = 0;
      p.durability = 0;
      p.initialDurability = 0;
      p.distanceTraveled = 0;
      p.maxRange = 0;
      p.knockback = 0;
    },
    32,
  );
  const explosionPool = new ObjectPool<Explosion>(
    () => new Explosion('', '', new Position(0, 0), 0, 0),
    () => {},
    16,
  );
  return {
    projectilePool,
    explosionPool,
    projectileMeta: new Map(),
  };
}
