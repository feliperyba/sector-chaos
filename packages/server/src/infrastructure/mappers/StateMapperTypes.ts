/**
 * StateMapperTypes.ts — wire-order constants + the match-state view types the
 * `StateMapper` projects from/onto (moved out of `StateMapper.ts` #23 so the
 * mapper class file has headroom under the 500-line lint cap for entity sync
 * table rows). `StateMapper.ts` re-exports everything here, so all historical
 * import paths (`./StateMapper.ts`, `./index.ts`) are unchanged.
 */
import type {
  Player,
  Projectile,
  PowerUp,
  Trap,
  Chest,
  Destructible,
  Exit,
  Explosion,
  WeaponPickup,
  ChestState,
} from '../../domain/entities/index.ts';
import type { DestructibleType } from '../../domain/entities/Destructible.ts';
import { WeaponTier, ChestRarity } from '@sector-battle/shared';
import type { ZoneState } from '@sector-battle/shared';
import type { SiegedSector } from '../../domain/services/SiegeService.ts';
import type { EliminationRecord } from '../../domain/services/EliminationService.ts';

export const TIER_ORDER: Record<string, number> = {
  [WeaponTier.COMMON]: 0,
  [WeaponTier.UNCOMMON]: 1,
  [WeaponTier.RARE]: 2,
  [WeaponTier.LEGENDARY]: 3,
};

export const CHEST_TIER_ORDER: Record<number, number> = {
  [ChestRarity.COMMON]: 0,
  [ChestRarity.RARE]: 1,
  [ChestRarity.EPIC]: 2,
  [ChestRarity.LEGENDARY]: 3,
};

/** Wire order for `ChestState` (module constant — was a per-call literal). */
export const CHEST_STATE_ORDER: Record<ChestState, number> = { closed: 0, opening: 1, open: 2 };

/**
 * Wire order for destructible types (module constant — was a per-call literal).
 * `'light'` (map-polish ticket 07) appends index 4 — the client resolver maps
 * unknown indices to a fallback visual until its ticket-08 render ownership
 * lands. Existing crate/barrel/iron/wall indices are unchanged.
 */
export const DESTRUCTIBLE_TYPE_ORDER: Record<DestructibleType, number> = {
  crate: 0,
  barrel: 1,
  iron: 2,
  wall: 3,
  light: 4,
};

export interface MatchMeta {
  matchId: string;
  mapSeed: number;
  mapWidth: number;
  mapHeight: number;
}

/**
 * The 3 animation fields projected onto the wire (`PlayerSchema.animPhase` /
 * `animPhaseStartTick` / `comboIndex`). The real owner is
 * `PlayerAnimationSystem`'s `AnimSimState`; this thin interface names only the
 * slice the mapper consumes so the infrastructure layer need not depend on the
 * full animation sim type. `AnimSimState` satisfies this structurally.
 */
export interface AnimWireFields {
  /** Current `AnimPhase` enum value (wire uint8). */
  phase: number;
  /** Tick at which the current phase began. */
  phaseStartTick: number;
  /** Attack alternation counter (mirrored to the wire as `comboIndex & 0xff`). */
  comboIndex: number;
}

/**
 * Per-player animation resolver accepted by `mapDelta`. It is threaded
 * through the entity sync table (`StateMapperSync.syncMap`) into the player
 * row's projector as an argument, so the projector is a module-stable
 * reference — no per-sync-tick closure allocation (#23).
 */
export type AnimStateResolver = (playerId: string) => AnimWireFields | undefined;

export interface MatchState {
  players: Map<string, Player>;
  projectiles: Map<string, Projectile>;
  powerUps: Map<string, PowerUp>;
  traps: Map<string, Trap>;
  chests: Map<string, Chest>;
  destructibles: Map<string, Destructible>;
  exits: Map<string, Exit>;
  explosions: Map<string, Explosion>;
  weaponPickups: Map<string, WeaponPickup>;
  /**
   * ticket 08 — per-kind static-row sync-gate version counters (mirrored
   * live from GameMatch; see StateMapperSync.StaticRowGate). Destructibles
   * and exits are only re-projected when these advance.
   */
  destructibleVersion: number;
  exitVersion: number;
  tick: number;
  phase: number;
  zone: ZoneState;
  lastProcessedInput: number;
  eliminations: readonly EliminationRecord[];
  siegedSectors: readonly SiegedSector[];
  mapSiegeProgress: {
    northOffset: number;
    eastOffset: number;
    southOffset: number;
    westOffset: number;
  };
}
