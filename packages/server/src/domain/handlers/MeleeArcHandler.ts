import {
  buildSectorPolygon,
  ColliderCollision,
  COMBAT,
  type HurtboxEntity,
} from '@sector-battle/shared';
import type { Player } from '../entities/index.ts';

export interface MeleeOverlapResult {
  hitEntityIds: string[];
  durabilityCost: number;
}

export class MeleeArcHandler {
  execute(
    player: Player,
    range: number,
    entities: HurtboxEntity[],
    arcAngle: number = Math.PI / 2,
  ): MeleeOverlapResult {
    if (range <= 0) return { hitEntityIds: [], durabilityCost: 0 };

    const px = player.movement.position.x;
    const py = player.movement.position.y;
    const facing = Number.isFinite(player.movement.facingAngle) ? player.movement.facingAngle : 0;
    const sectorPolygon = buildSectorPolygon(
      px,
      py,
      facing,
      arcAngle,
      COMBAT.ARC_INNER_RADIUS,
      range,
    );

    const hitCandidates: { id: string; dist: number }[] = [];

    for (const entity of entities) {
      if (entity.id === player.id) continue;

      const ex = entity.position.x - px;
      const ey = entity.position.y - py;
      const dist = Math.sqrt(ex * ex + ey * ey);

      if (ColliderCollision.testAABB(entity.hurtbox, sectorPolygon) === null) continue;

      hitCandidates.push({ id: entity.id, dist });
    }

    hitCandidates.sort((a, b) => a.dist - b.dist);
    const hitEntityIds = hitCandidates.map((c) => c.id);

    return { hitEntityIds, durabilityCost: hitEntityIds.length };
  }
}
