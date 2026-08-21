import {
  TileType,
  WeaponType,
  WeaponTier,
  PowerUpType,
  DURABILITY_BY_TIER,
  weaponRegistry,
  SeededRNG,
  NETWORK,
} from '@sector-battle/shared';
import { Chest } from '../entities/Chest.ts';
import type { Player } from '../entities/Player.ts';
import { PowerUp } from '../entities/PowerUp.ts';
import type { GamePowerUpType } from '../entities/PowerUp.ts';
import { WeaponEntity } from '../entities/Weapon.ts';
import { Position } from '../value-objects/index.ts';
import type { GameEvent } from '../events/index.ts';
import { LootService } from '../services/LootService.ts';

export interface ChestOpeningHandlerContext {
  getPlayer(id: string): Player | undefined;
  getChests(): Chest[];
  getCurrentTick(): number;
  emitEvent(event: GameEvent): void;
  setTileAt(gridX: number, gridY: number, type: TileType): void;
  worldToGrid(worldX: number, worldY: number): { gridX: number; gridY: number };
  addWeaponPickup(id: string, weapon: WeaponEntity, position: Position): void;
  addPowerUp(p: PowerUp): void;
  removeChest(id: string): void;
  /** server-chest-cancel-index: drop a completed/interrupted chest from the index. */
  unregisterChestOpening(playerId: string, chestId: string): void;
  getTileAt(gridX: number, gridY: number): TileType;
  nextId(): string;
  getTileWidth(): number;
  lootService: LootService;
  lootRng: SeededRNG;
}

const POWERUP_TYPE_MAP: Record<number, GamePowerUpType> = {
  [PowerUpType.HEALTH_PACK]: 'health_pack',
  [PowerUpType.BARRIER]: 'barrier',
  [PowerUpType.SPEED_BOOST]: 'speed_boost',
};

export class ChestOpeningHandler {
  constructor(private ctx: ChestOpeningHandlerContext) {}

  tickOpenings(dt: number): void {
    const openingChests = this.ctx.getChests().filter((c) => c.state === 'opening');

    for (const chest of openingChests) {
      if (!chest.openingPlayerId) continue;

      const player = this.ctx.getPlayer(chest.openingPlayerId);
      if (!player || !player.isAlive()) {
        this.interruptChest(chest, chest.openingPlayerId);
        continue;
      }

      const distance = player.movement.position.distanceTo(chest.position);
      if (distance > Chest.INTERACTION_RANGE) {
        this.interruptChest(chest, chest.openingPlayerId);
        continue;
      }

      const tickResult = chest.tickOpening(dt, player.movement.position);

      if (tickResult.completed) {
        this.completeOpening(chest, chest.openingPlayerId);
      } else if (tickResult.interrupted) {
        this.ctx.emitEvent({
          type: 'ChestOpeningInterrupted',
          tick: this.ctx.getCurrentTick(),
          timestamp: Date.now(),
          chestId: chest.id,
          playerId: chest.openingPlayerId ?? '',
        });
      }
    }
  }

  private interruptChest(chest: Chest, playerId: string): void {
    if (chest.state === 'opening') {
      chest.interrupt();
    }
    this.ctx.unregisterChestOpening(playerId, chest.id);
    this.ctx.emitEvent({
      type: 'ChestOpeningInterrupted',
      tick: this.ctx.getCurrentTick(),
      timestamp: Date.now(),
      chestId: chest.id,
      playerId,
    });
  }

  private completeOpening(chest: Chest, playerId: string): void {
    const loot = this.ctx.lootService.rollChestLoot(chest.tier, this.ctx.lootRng);
    const chestGrid = this.ctx.worldToGrid(chest.position.x, chest.position.y);

    this.ctx.setTileAt(chestGrid.gridX, chestGrid.gridY, TileType.EMPTY);

    chest.completeOpening({ type: WeaponType.DAGGER, tier: chest.tier });
    this.ctx.unregisterChestOpening(playerId, chest.id);

    this.ctx.emitEvent({
      type: 'ChestOpened',
      tick: this.ctx.getCurrentTick(),
      timestamp: Date.now(),
      chestId: chest.id,
      playerId,
      tier: chest.tier,
      lootContents: loot,
    });

    if (loot.kind === 'weapon') {
      this.spawnWeaponLoot(chest, loot, chestGrid);
    }

    if (loot.kind === 'powerup') {
      const gameType = POWERUP_TYPE_MAP[loot.powerUpType] ?? 'health_pack';
      const adjacent = this.findAdjacentEmptyTile(chestGrid.gridX, chestGrid.gridY);
      const tileWidth = this.ctx.getTileWidth();
      let spawnPos: Position;
      if (adjacent) {
        spawnPos = new Position(
          adjacent.gx * tileWidth + tileWidth / 2,
          adjacent.gy * tileWidth + tileWidth / 2,
        );
      } else {
        spawnPos = chest.position;
      }
      const powerUp = PowerUp.create(
        this.ctx.nextId(),
        gameType,
        spawnPos,
        this.ctx.getCurrentTick(),
      );
      this.ctx.addPowerUp(powerUp);
    }

    chest.openingProgress = 0;
    chest.openingPlayerId = null;

    this.ctx.removeChest(chest.id);
  }

  private spawnWeaponLoot(
    chest: Chest,
    loot: { kind: 'weapon'; tier: WeaponTier },
    chestGrid: { gridX: number; gridY: number },
  ): void {
    const pool = weaponRegistry.getSpawnableTypes();
    const weaponType = this.ctx.lootRng.weightedPick(pool.map((w) => ({ item: w, weight: 1 })));

    const definition = weaponRegistry.getDefinition(weaponType);
    const ammo = DURABILITY_BY_TIER[loot.tier];
    const cooldownTicks = Math.ceil(definition.baseStats.cooldown / NETWORK.TICK_INTERVAL);

    const weapon = new WeaponEntity(
      this.ctx.nextId(),
      weaponType,
      loot.tier,
      ammo,
      ammo,
      cooldownTicks,
    );

    const adjacent = this.findAdjacentEmptyTile(chestGrid.gridX, chestGrid.gridY);
    const tileWidth = this.ctx.getTileWidth();

    let pickupPos: Position;
    if (adjacent) {
      pickupPos = new Position(
        adjacent.gx * tileWidth + tileWidth / 2,
        adjacent.gy * tileWidth + tileWidth / 2,
      );
    } else {
      pickupPos = chest.position;
    }

    this.ctx.addWeaponPickup(this.ctx.nextId(), weapon, pickupPos);
  }

  private findAdjacentEmptyTile(gridX: number, gridY: number): { gx: number; gy: number } | null {
    const cardinal = [
      { dx: 0, dy: -1 },
      { dx: 0, dy: 1 },
      { dx: -1, dy: 0 },
      { dx: 1, dy: 0 },
    ];

    for (const { dx, dy } of cardinal) {
      const nx = gridX + dx;
      const ny = gridY + dy;
      if (this.ctx.getTileAt(nx, ny) === TileType.EMPTY) {
        return { gx: nx, gy: ny };
      }
    }

    const diagonal = [
      { dx: -1, dy: -1 },
      { dx: 1, dy: -1 },
      { dx: -1, dy: 1 },
      { dx: 1, dy: 1 },
    ];

    for (const { dx, dy } of diagonal) {
      const nx = gridX + dx;
      const ny = gridY + dy;
      if (this.ctx.getTileAt(nx, ny) === TileType.EMPTY) {
        return { gx: nx, gy: ny };
      }
    }

    return null;
  }
}
