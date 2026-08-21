import { TileType } from '@sector-battle/shared';
import { Position } from '../value-objects/index.ts';
import type { Player } from '../entities/Player.ts';
import type { Trap } from '../entities/Trap.ts';
import type { Destructible } from '../entities/Destructible.ts';
import type { Chest } from '../entities/Chest.ts';
import type { WeaponPickup } from '../entities/WeaponPickup.ts';
import type { PowerUp } from '../entities/PowerUp.ts';
import { simRandom } from '../shared/SimRandom.ts';

export interface TeleportDeps {
  players: Map<string, Player>;
  traps: Map<string, Trap>;
  destructibles: Map<string, Destructible>;
  chests: Map<string, Chest>;
  weaponPickups: Map<string, WeaponPickup>;
  powerUps: Map<string, PowerUp>;
  grid: TileType[][];
  mapWidth: number;
  mapHeight: number;
  tileWidth: number;
  tileHeight: number;
}

export function findTeleportDestination(deps: TeleportDeps, playerId: string): Position | null {
  const player = deps.players.get(playerId);
  if (!player) return null;

  const occupied = new Set<string>();
  const tw = deps.tileWidth;
  const th = deps.tileHeight;

  for (const [, p] of deps.players) {
    const gx = Math.floor(p.movement.position.x / tw);
    const gy = Math.floor(p.movement.position.y / th);
    occupied.add(`${gx},${gy}`);
  }
  for (const [, t] of deps.traps) {
    const gx = Math.floor(t.position.x / tw);
    const gy = Math.floor(t.position.y / th);
    occupied.add(`${gx},${gy}`);
  }
  for (const [, d] of deps.destructibles) {
    if (d.isDestroyed) continue;
    const gx = Math.floor(d.position.x / tw);
    const gy = Math.floor(d.position.y / th);
    occupied.add(`${gx},${gy}`);
  }
  for (const [, c] of deps.chests) {
    const gx = Math.floor(c.position.x / tw);
    const gy = Math.floor(c.position.y / th);
    occupied.add(`${gx},${gy}`);
  }
  for (const [, wp] of deps.weaponPickups) {
    if (!wp.isActive) continue;
    const gx = Math.floor(wp.position.x / tw);
    const gy = Math.floor(wp.position.y / th);
    occupied.add(`${gx},${gy}`);
  }
  for (const [, pu] of deps.powerUps) {
    if (!pu.isActive) continue;
    const gx = Math.floor(pu.position.x / tw);
    const gy = Math.floor(pu.position.y / th);
    occupied.add(`${gx},${gy}`);
  }

  const emptyTiles: { gx: number; gy: number }[] = [];
  for (let gy = 0; gy < deps.mapHeight; gy++) {
    for (let gx = 0; gx < deps.mapWidth; gx++) {
      if (deps.grid[gy]![gx] !== TileType.EMPTY) continue;
      if (occupied.has(`${gx},${gy}`)) continue;
      emptyTiles.push({ gx, gy });
    }
  }

  if (emptyTiles.length > 0) {
    const dest = emptyTiles[Math.floor(simRandom('teleport-destination') * emptyTiles.length)]!;
    return new Position(dest.gx * tw + tw / 2, dest.gy * th + th / 2);
  }

  const playerGX = Math.floor(player.movement.position.x / tw);
  const playerGY = Math.floor(player.movement.position.y / th);
  let nearest: { gx: number; gy: number; distSq: number } | null = null;
  for (let gy = 0; gy < deps.mapHeight; gy++) {
    for (let gx = 0; gx < deps.mapWidth; gx++) {
      if (deps.grid[gy]![gx] !== TileType.EMPTY) continue;
      const dx = gx - playerGX;
      const dy = gy - playerGY;
      const distSq = dx * dx + dy * dy;
      if (!nearest || distSq < nearest.distSq) nearest = { gx, gy, distSq };
    }
  }

  if (nearest) return new Position(nearest.gx * tw + tw / 2, nearest.gy * th + th / 2);
  return null;
}
