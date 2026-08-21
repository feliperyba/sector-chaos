import type { Explosion } from '../entities/Explosion.ts';
import type { ObjectPool } from '@sector-battle/shared';

export function updateExplosions(
  explosions: Map<string, Explosion>,
  explosionPool: ObjectPool<Explosion>,
): void {
  const expired: string[] = [];
  for (const [id, e] of explosions) {
    if (e.tick()) expired.push(id);
  }
  for (const id of expired) {
    const e = explosions.get(id);
    if (e) explosionPool.release(e);
    explosions.delete(id);
  }
}
