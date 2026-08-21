import { TileType, DamageType } from '@sector-battle/shared';
import { Position } from '../value-objects/index.ts';
import { type Player, type Destructible, type DamageResult } from '../entities/index.ts';
import type { GameEvent } from '../events/index.ts';
import { EventCollector } from '../shared/EventCollector.ts';
import type { BarrelExplosionManager } from './BarrelExplosionManager.ts';
import type { DamagePipeline } from '../services/DamagePipeline.ts';

export function movePlayerAction(
  players: Map<string, Player>,
  id: string,
  newPosition: Position,
): GameEvent[] {
  const player = players.get(id);
  if (!player || !player.isActive) return [];
  // server-movement-scratch-aabb: copy on retain. MovementService now returns
  // shared zero-alloc scratch Positions (invalidated by the next call), so the
  // single retention point — storing the player's authoritative position —
  // copies the values into a fresh immutable Position. This preserves the
  // previous value semantics exactly (Position fields are readonly, so no
  // holder of the old object can observe any difference).
  player.movement.position = new Position(newPosition.x, newPosition.y);
  return [];
}

export function triggerBarrel(
  barrelExplosionManager: BarrelExplosionManager,
  gridX: number,
  gridY: number,
  sourceOwnerId: string,
  currentTick: number,
): GameEvent[] {
  return barrelExplosionManager.resolveExplosion(gridX, gridY, sourceOwnerId, currentTick);
}

export function destroyDestructibleAction(
  deps: {
    destructibles: Map<string, Destructible>;
    worldToGrid: (worldX: number, worldY: number) => { gridX: number; gridY: number };
    setTileAt: (gridX: number, gridY: number, type: TileType) => void;
    barrelExplosionManager: BarrelExplosionManager;
    tick: number;
    eventCollector: EventCollector<GameEvent>;
    /** siege-tile-index (ticket 09) — eager bucket removal for the direct
     *  `destructibles.delete` below (one of the two non-EntityOps delete
     *  sites; the barrel-chain one is on BarrelExplosionContext). Wired by
     *  destroyDestructibleForMatch. */
    onDestructibleMapDelete?: (id: string, gridX: number, gridY: number) => void;
  },
  id: string,
  droppedLoot?: unknown,
): GameEvent[] {
  const d = deps.destructibles.get(id);
  if (!d) return [];
  const gridPos = deps.worldToGrid(d.position.x, d.position.y);
  const events: GameEvent[] = [];
  deps.setTileAt(gridPos.gridX, gridPos.gridY, TileType.EMPTY);
  if (d.type === 'barrel') {
    events.push(
      ...deps.barrelExplosionManager.resolveExplosion(
        gridPos.gridX,
        gridPos.gridY,
        'barrel',
        deps.tick,
      ),
    );
  }
  events.push({
    type: 'DestructibleDestroyed',
    tick: deps.tick,
    timestamp: Date.now(),
    id,
    destructibleType: d.type,
    position: { x: d.position.x, y: d.position.y },
    droppedLoot: droppedLoot ?? null,
    gridX: gridPos.gridX,
    gridY: gridPos.gridY,
  });
  for (const event of events) deps.eventCollector.emit(event);
  deps.onDestructibleMapDelete?.(id, gridPos.gridX, gridPos.gridY);
  deps.destructibles.delete(id);
  return events;
}

export function applyZoneDamageAction(
  players: Map<string, Player>,
  damagePipeline: DamagePipeline,
  tick: number,
  playerId: string,
  amount: number,
): DamageResult {
  const player = players.get(playerId);
  if (!player || !player.isActive) return { killed: false, damageApplied: 0 };
  const result = damagePipeline.processDamage(
    {
      sourceId: 'zone',
      damage: amount,
      damageType: DamageType.ZONE_DAMAGE,
      targetIds: [playerId],
      sourcePosition: { x: player.movement.position.x, y: player.movement.position.y },
      currentTick: tick,
    },
    (id) => players.get(id),
  );
  return { killed: result.killed, damageApplied: result.damageApplied };
}
