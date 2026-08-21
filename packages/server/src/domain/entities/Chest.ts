import { ChestRarity, WeaponType, CHEST } from '@sector-battle/shared';
import { Position } from '../value-objects/index.ts';

export type ChestState = 'closed' | 'opening' | 'open';
export type ChestRejectionReason = 'already_open' | 'out_of_range';

export interface OpeningResult {
  success: boolean;
  reason?: ChestRejectionReason;
}

export interface TickResult {
  completed: boolean;
  interrupted: boolean;
}

export interface WeaponDefinition {
  type: WeaponType;
  tier: ChestRarity;
}

const TIER_DISTRIBUTION: Record<ChestRarity, number> = {
  [ChestRarity.COMMON]: 0.7,
  [ChestRarity.RARE]: 0.2,
  [ChestRarity.EPIC]: 0.08,
  [ChestRarity.LEGENDARY]: 0.02,
};

const INTERACTION_RANGE = CHEST.INTERACTION_RANGE;
const OPENING_DURATION = CHEST.OPEN_DURATION;

export class Chest {
  readonly id: string;
  readonly tier: ChestRarity;
  position: Position;
  state: ChestState;
  contents: WeaponDefinition | null;
  openingPlayerId: string | null;
  openingProgress: number;
  openingPlayerStartPos: Position | null;
  readonly textureKey: string;
  readonly rotation: number;
  readonly flipH: boolean;
  readonly flipV: boolean;

  private constructor(
    id: string,
    tier: ChestRarity,
    position: Position,
    textureKey: string = '',
    rotation: number = 0,
    flipH: boolean = false,
    flipV: boolean = false,
  ) {
    this.id = id;
    this.tier = tier;
    this.position = position;
    this.state = 'closed';
    this.contents = null;
    this.openingPlayerId = null;
    this.openingProgress = 0;
    this.openingPlayerStartPos = null;
    this.textureKey = textureKey;
    this.rotation = rotation;
    this.flipH = flipH;
    this.flipV = flipV;
  }

  static create(
    id: string,
    tier: ChestRarity,
    position: Position,
    textureKey: string = '',
    rotation: number = 0,
    flipH: boolean = false,
    flipV: boolean = false,
  ): Chest {
    return new Chest(id, tier, position, textureKey, rotation, flipH, flipV);
  }

  startOpening(playerId: string, playerDistance: number, playerPos: Position): OpeningResult {
    if (this.state !== 'closed') {
      throw new Error(`Invalid transition: cannot start opening from state '${this.state}'`);
    }
    if (playerDistance > INTERACTION_RANGE) {
      return { success: false, reason: 'out_of_range' };
    }
    // NOTE: chest loot always spawns as a GROUND PICKUP on an adjacent tile
    // (see ChestOpeningHandler.completeOpening → addWeaponPickup / addPowerUp),
    // never directly into the player's inventory. Inventory state is therefore
    // irrelevant to opening — there is no inventory-full precondition (GDD §11.2
    // specifies only range + stationary-channel + not-attacking + not-dead).
    this.state = 'opening';
    this.openingPlayerId = playerId;
    this.openingProgress = 0;
    this.openingPlayerStartPos = new Position(playerPos.x, playerPos.y);
    return { success: true };
  }

  tickOpening(dt: number, playerCurrentPos: Position): TickResult {
    if (this.state !== 'opening') {
      return { completed: false, interrupted: false };
    }
    if (this.openingPlayerStartPos) {
      const dx = playerCurrentPos.x - this.openingPlayerStartPos.x;
      const dy = playerCurrentPos.y - this.openingPlayerStartPos.y;
      if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
        this.interrupt();
        return { completed: false, interrupted: true };
      }
    }
    this.openingProgress += dt;
    if (this.openingProgress >= OPENING_DURATION) {
      return { completed: true, interrupted: false };
    }
    return { completed: false, interrupted: false };
  }

  completeOpening(loot: WeaponDefinition): void {
    if (this.state !== 'opening')
      throw new Error(`Invalid transition: cannot complete opening from state '${this.state}'`);
    this.state = 'open';
    this.contents = loot;
    this.openingProgress = OPENING_DURATION;
  }

  interrupt(): void {
    if (this.state !== 'opening')
      throw new Error(`Invalid transition: cannot interrupt from state '${this.state}'`);
    this.state = 'closed';
    this.openingPlayerId = null;
    this.openingProgress = 0;
    this.openingPlayerStartPos = null;
  }

  static readonly TIER_DISTRIBUTION = TIER_DISTRIBUTION;
  static readonly INTERACTION_RANGE = INTERACTION_RANGE;
  static readonly OPENING_DURATION = OPENING_DURATION;
}
