/**
 * Schema-mirror drift-catching test (ADR-0014 binding, FILE_CONSTRAINTS #7).
 *
 * The server owns the wire shape: every `@type(...)`-decorated field on a
 * Colyseus `Schema` subclass under `packages/server/src/infrastructure/schemas/`
 * is what actually crosses the wire. The shared package mirrors those shapes as
 * plain TS interfaces (`PlayerSchemaData`, `WeaponSchemaData`, …) so the client
 * network layer can drop its `any` casts (see
 * `packages/shared/src/types/schema-types.ts`). Those two sources of truth are
 * kept in sync by hand, which silently rots.
 *
 * This file is the third list — a runtime field-name constant per schema —
 * that must agree with BOTH the server schema and the shared interface. Any
 * drift between any two of the three causes a test failure. Three lists that
 * must agree is strictly safer than two that agree only by convention.
 *
 * Adding this test adds zero runtime dependencies to `packages/shared` — it
 * lives in `packages/server`, which already depends on `@colyseus/schema`
 * (exposes the runtime metadata via `Metadata.getFields`) and Zod.
 *
 * See `docs/issues/05-refactor-schema-mirror-quadrangle.md` (Step 1 + Step 5).
 */

import { describe, it, expect } from 'vitest';
import { Metadata } from '@colyseus/schema';
import type {
  PlayerSchemaData,
  WeaponSchemaData,
  ProjectileSchemaData,
  DestructibleSchemaData,
  ChestSchemaData,
  EliminationRecordSchemaData,
  ExitSchemaData,
  ExplosionSchemaData,
  PowerUpSchemaData,
  TrapSchemaData,
  WeaponPickupSchemaData,
  SiegeSectorSchemaData,
  MapSiegeProgressSchemaData,
  ZoneSchemaData,
  GameRoomStateData,
} from '@sector-battle/shared';
import { PlayerSchema } from '../../src/infrastructure/schemas/PlayerSchema.ts';
import { WeaponSchema } from '../../src/infrastructure/schemas/WeaponSchema.ts';
import { ProjectileSchema } from '../../src/infrastructure/schemas/ProjectileSchema.ts';
import { DestructibleSchema } from '../../src/infrastructure/schemas/DestructibleSchema.ts';
import { ChestSchema } from '../../src/infrastructure/schemas/ChestSchema.ts';
import { EliminationRecordSchema } from '../../src/infrastructure/schemas/EliminationRecordSchema.ts';
import { ExitSchema } from '../../src/infrastructure/schemas/ExitSchema.ts';
import { ExplosionSchema } from '../../src/infrastructure/schemas/ExplosionSchema.ts';
import { PowerUpSchema } from '../../src/infrastructure/schemas/PowerUpSchema.ts';
import { TrapSchema } from '../../src/infrastructure/schemas/TrapSchema.ts';
import { WeaponPickupSchema } from '../../src/infrastructure/schemas/WeaponPickupSchema.ts';
import {
  SiegeSectorSchema,
  MapSiegeProgressSchema,
} from '../../src/infrastructure/schemas/SiegeSchema.ts';
import { ZoneSchema } from '../../src/infrastructure/schemas/ZoneSchema.ts';
import { GameStateSchema } from '../../src/infrastructure/schemas/GameStateSchema.ts';

/**
 * Read the `@type()`-decorated field names off a Colyseus `Schema` subclass at
 * runtime, returning them as a plain string array in declaration order.
 *
 * `Metadata.getFields()` returns the field-name → type-definition map; only the
 * keys are needed here. The metadata is populated by the `@type()` decorator at
 * class-construction time, so this reads the exact same information Colyseus
 * itself uses to (de)serialize the wire bytes.
 */
function schemaFieldNames(klass: new (...args: never[]) => unknown): string[] {
  return Object.keys(Metadata.getFields(klass));
}

/**
 * Subset helper for the reverse-direction compile-time assertion below. Resolves
 * to `true` only when every member of union `T` is assignable to union `U`.
 */
type IsSubset<T, U> = [T] extends [U] ? true : false;

// ---------------------------------------------------------------------------
// Per-schema runtime field-lists.
// ---------------------------------------------------------------------------
// Each list is intentionally hand-maintained — that is the point. If someone
// adds a `@type()` to a server schema but forgets to update either the list or
// the matching shared interface, a test below fails. Order matches the
// `@type(...)` declaration order in the server schema files.

const PLAYER_SCHEMA_DATA_FIELDS = [
  'id',
  'name',
  'color',
  'x',
  'y',
  'direction',
  'facingAngle',
  'speed',
  'velocityX',
  'velocityY',
  'health',
  'maxHealth',
  'status',
  'kills',
  'activeSlot',
  'lastDamageTick',
  'dashCooldown',
  'barrierActive',
  'isBlocking',
  'speedBoostActive',
  'connected',
  'isBot',
  'isWindupActive',
  'windupWeaponType',
  'windupAttackType',
  'animPhase',
  'animPhaseStartTick',
  'comboIndex',
  'barrierExpiryTick',
  'speedBoostExpiryTick',
  'freshSpawnExpiryTick',
  'lastProcessedInput',
  'weapons',
  'items',
] as const;

const WEAPON_SCHEMA_DATA_FIELDS = ['id', 'weaponType', 'tier', 'ammo', 'maxAmmo'] as const;

const PROJECTILE_SCHEMA_DATA_FIELDS = [
  'id',
  'ownerId',
  'x',
  'y',
  'velocityX',
  'velocityY',
  'damage',
  'bounces',
  'weaponType',
  'tier',
] as const;

const DESTRUCTIBLE_SCHEMA_DATA_FIELDS = [
  'id',
  'type',
  'hp',
  'maxHp',
  'x',
  'y',
  'isDestroyed',
  'primed',
  'fuseExpiresAtTick',
  'textureKey',
  'rotation',
  'flipH',
  'flipV',
] as const;

const CHEST_SCHEMA_DATA_FIELDS = [
  'id',
  'tier',
  'x',
  'y',
  'state',
  'openingPlayerId',
  'openingProgress',
  'textureKey',
  'rotation',
  'flipH',
  'flipV',
] as const;

const ELIMINATION_RECORD_SCHEMA_DATA_FIELDS = [
  'order',
  'playerId',
  'killerId',
  'weaponType',
  'timestamp',
] as const;

const EXIT_SCHEMA_DATA_FIELDS = [
  'id',
  'x',
  'y',
  'gridX',
  'gridY',
  'sectorIndex',
  'active',
  'textureKey',
  'rotation',
  'flipH',
  'flipV',
] as const;

const EXPLOSION_SCHEMA_DATA_FIELDS = ['id', 'ownerId', 'x', 'y', 'radius', 'damage'] as const;

const POWERUP_SCHEMA_DATA_FIELDS = ['id', 'type', 'x', 'y', 'isActive'] as const;

const TRAP_SCHEMA_DATA_FIELDS = [
  'id',
  'type',
  'x',
  'y',
  'isRevealed',
  'cooldownRemaining',
  'textureKey',
  'rotation',
  'flipH',
  'flipV',
  'fireAreaActive',
  'fireAreaRemainingMs',
] as const;

const WEAPON_PICKUP_SCHEMA_DATA_FIELDS = [
  'id',
  'weaponType',
  'tier',
  'ammo',
  'maxAmmo',
  'x',
  'y',
  'lifetime',
  'textureKey',
  'rotation',
  'flipH',
  'flipV',
] as const;

const SIEGE_SECTOR_SCHEMA_DATA_FIELDS = ['row', 'col', 'active'] as const;

const MAP_SIEGE_PROGRESS_SCHEMA_DATA_FIELDS = [
  'northOffset',
  'eastOffset',
  'southOffset',
  'westOffset',
] as const;

const ZONE_SCHEMA_DATA_FIELDS = [
  'centerX',
  'centerY',
  'targetCenterX',
  'targetCenterY',
  'isTransitioningCenter',
  'currentRadius',
  'targetRadius',
  'phase',
  'phaseStartTime',
  'phaseEndTime',
  'hasNextPhasePreview',
  'nextPhaseCenterX',
  'nextPhaseCenterY',
  'nextPhaseRadius',
] as const;

// GameStateSchema declares `matchTimerSeconds` as a setter (not a `@type()`),
// so it is intentionally absent from the field-list below — only `@type()`
// fields cross the wire.
const GAME_ROOM_STATE_DATA_FIELDS = [
  'matchId',
  'phase',
  'tick',
  'timestamp',
  'mapSeed',
  'mapWidth',
  'mapHeight',
  'playersAlive',
  'matchTimer',
  'lastProcessedInput',
  'players',
  'projectiles',
  'powerUps',
  'traps',
  'chests',
  'destructibles',
  'exits',
  'explosions',
  'zone',
  'eliminationRecords',
  'weaponPickups',
  'siegedSectors',
  'mapSiegeProgress',
] as const;

// ---------------------------------------------------------------------------
// Compile-time links between each runtime field-list and its shared interface.
// ---------------------------------------------------------------------------
// Forward (`satisfies`): every field-list entry is a key of the shared
// interface. Reverse (`IsSubset`): every key of the shared interface is in the
// field-list. Both produce no runtime code; either fails the typecheck on drift.

void (null as unknown as (typeof PLAYER_SCHEMA_DATA_FIELDS)[number]) satisfies keyof PlayerSchemaData;
const _playerReverse: IsSubset<keyof PlayerSchemaData, (typeof PLAYER_SCHEMA_DATA_FIELDS)[number]> =
  true;
void _playerReverse;

void (null as unknown as (typeof WEAPON_SCHEMA_DATA_FIELDS)[number]) satisfies keyof WeaponSchemaData;
const _weaponReverse: IsSubset<keyof WeaponSchemaData, (typeof WEAPON_SCHEMA_DATA_FIELDS)[number]> =
  true;
void _weaponReverse;

void (null as unknown as (typeof PROJECTILE_SCHEMA_DATA_FIELDS)[number]) satisfies keyof ProjectileSchemaData;
const _projectileReverse: IsSubset<
  keyof ProjectileSchemaData,
  (typeof PROJECTILE_SCHEMA_DATA_FIELDS)[number]
> = true;
void _projectileReverse;

void (null as unknown as (typeof DESTRUCTIBLE_SCHEMA_DATA_FIELDS)[number]) satisfies keyof DestructibleSchemaData;
const _destructibleReverse: IsSubset<
  keyof DestructibleSchemaData,
  (typeof DESTRUCTIBLE_SCHEMA_DATA_FIELDS)[number]
> = true;
void _destructibleReverse;

void (null as unknown as (typeof CHEST_SCHEMA_DATA_FIELDS)[number]) satisfies keyof ChestSchemaData;
const _chestReverse: IsSubset<keyof ChestSchemaData, (typeof CHEST_SCHEMA_DATA_FIELDS)[number]> =
  true;
void _chestReverse;

void (null as unknown as (typeof ELIMINATION_RECORD_SCHEMA_DATA_FIELDS)[number]) satisfies keyof EliminationRecordSchemaData;
const _eliminationReverse: IsSubset<
  keyof EliminationRecordSchemaData,
  (typeof ELIMINATION_RECORD_SCHEMA_DATA_FIELDS)[number]
> = true;
void _eliminationReverse;

void (null as unknown as (typeof EXIT_SCHEMA_DATA_FIELDS)[number]) satisfies keyof ExitSchemaData;
const _exitReverse: IsSubset<keyof ExitSchemaData, (typeof EXIT_SCHEMA_DATA_FIELDS)[number]> = true;
void _exitReverse;

void (null as unknown as (typeof EXPLOSION_SCHEMA_DATA_FIELDS)[number]) satisfies keyof ExplosionSchemaData;
const _explosionReverse: IsSubset<
  keyof ExplosionSchemaData,
  (typeof EXPLOSION_SCHEMA_DATA_FIELDS)[number]
> = true;
void _explosionReverse;

void (null as unknown as (typeof POWERUP_SCHEMA_DATA_FIELDS)[number]) satisfies keyof PowerUpSchemaData;
const _powerUpReverse: IsSubset<
  keyof PowerUpSchemaData,
  (typeof POWERUP_SCHEMA_DATA_FIELDS)[number]
> = true;
void _powerUpReverse;

void (null as unknown as (typeof TRAP_SCHEMA_DATA_FIELDS)[number]) satisfies keyof TrapSchemaData;
const _trapReverse: IsSubset<keyof TrapSchemaData, (typeof TRAP_SCHEMA_DATA_FIELDS)[number]> = true;
void _trapReverse;

void (null as unknown as (typeof WEAPON_PICKUP_SCHEMA_DATA_FIELDS)[number]) satisfies keyof WeaponPickupSchemaData;
const _weaponPickupReverse: IsSubset<
  keyof WeaponPickupSchemaData,
  (typeof WEAPON_PICKUP_SCHEMA_DATA_FIELDS)[number]
> = true;
void _weaponPickupReverse;

void (null as unknown as (typeof SIEGE_SECTOR_SCHEMA_DATA_FIELDS)[number]) satisfies keyof SiegeSectorSchemaData;
const _siegeSectorReverse: IsSubset<
  keyof SiegeSectorSchemaData,
  (typeof SIEGE_SECTOR_SCHEMA_DATA_FIELDS)[number]
> = true;
void _siegeSectorReverse;

void (null as unknown as (typeof MAP_SIEGE_PROGRESS_SCHEMA_DATA_FIELDS)[number]) satisfies keyof MapSiegeProgressSchemaData;
const _mapSiegeReverse: IsSubset<
  keyof MapSiegeProgressSchemaData,
  (typeof MAP_SIEGE_PROGRESS_SCHEMA_DATA_FIELDS)[number]
> = true;
void _mapSiegeReverse;

void (null as unknown as (typeof ZONE_SCHEMA_DATA_FIELDS)[number]) satisfies keyof ZoneSchemaData;
const _zoneReverse: IsSubset<keyof ZoneSchemaData, (typeof ZONE_SCHEMA_DATA_FIELDS)[number]> = true;
void _zoneReverse;

void (null as unknown as (typeof GAME_ROOM_STATE_DATA_FIELDS)[number]) satisfies keyof GameRoomStateData;
const _gameRoomReverse: IsSubset<
  keyof GameRoomStateData,
  (typeof GAME_ROOM_STATE_DATA_FIELDS)[number]
> = true;
void _gameRoomReverse;

// ---------------------------------------------------------------------------
// Data-driven runtime assertions. Each schema gets three checks: server schema
// declares every field-list entry, field-list contains every server field, and
// the two counts match (guards against duplicates either way).
// ---------------------------------------------------------------------------

interface SyncCase {
  label: string;
  klass: new (...args: never[]) => unknown;
  fields: readonly string[];
}

const SYNC_CASES: SyncCase[] = [
  { label: 'PlayerSchema', klass: PlayerSchema, fields: PLAYER_SCHEMA_DATA_FIELDS },
  { label: 'WeaponSchema', klass: WeaponSchema, fields: WEAPON_SCHEMA_DATA_FIELDS },
  { label: 'ProjectileSchema', klass: ProjectileSchema, fields: PROJECTILE_SCHEMA_DATA_FIELDS },
  {
    label: 'DestructibleSchema',
    klass: DestructibleSchema,
    fields: DESTRUCTIBLE_SCHEMA_DATA_FIELDS,
  },
  { label: 'ChestSchema', klass: ChestSchema, fields: CHEST_SCHEMA_DATA_FIELDS },
  {
    label: 'EliminationRecordSchema',
    klass: EliminationRecordSchema,
    fields: ELIMINATION_RECORD_SCHEMA_DATA_FIELDS,
  },
  { label: 'ExitSchema', klass: ExitSchema, fields: EXIT_SCHEMA_DATA_FIELDS },
  { label: 'ExplosionSchema', klass: ExplosionSchema, fields: EXPLOSION_SCHEMA_DATA_FIELDS },
  { label: 'PowerUpSchema', klass: PowerUpSchema, fields: POWERUP_SCHEMA_DATA_FIELDS },
  { label: 'TrapSchema', klass: TrapSchema, fields: TRAP_SCHEMA_DATA_FIELDS },
  {
    label: 'WeaponPickupSchema',
    klass: WeaponPickupSchema,
    fields: WEAPON_PICKUP_SCHEMA_DATA_FIELDS,
  },
  { label: 'SiegeSectorSchema', klass: SiegeSectorSchema, fields: SIEGE_SECTOR_SCHEMA_DATA_FIELDS },
  {
    label: 'MapSiegeProgressSchema',
    klass: MapSiegeProgressSchema,
    fields: MAP_SIEGE_PROGRESS_SCHEMA_DATA_FIELDS,
  },
  { label: 'ZoneSchema', klass: ZoneSchema, fields: ZONE_SCHEMA_DATA_FIELDS },
  { label: 'GameStateSchema', klass: GameStateSchema, fields: GAME_ROOM_STATE_DATA_FIELDS },
];

describe('Schema three-way field sync (server schema / shared interface / test field-list)', () => {
  for (const tc of SYNC_CASES) {
    describe(tc.label, () => {
      it('server schema declares every field-list entry', () => {
        const serverFields = new Set(schemaFieldNames(tc.klass));
        for (const field of tc.fields) {
          expect(serverFields.has(field), `server ${tc.label} missing @type() for "${field}"`).toBe(
            true,
          );
        }
      });

      it('field-list contains every server @type() field', () => {
        const listFields = new Set<string>(tc.fields);
        const serverFields = schemaFieldNames(tc.klass);
        for (const field of serverFields) {
          expect(
            listFields.has(field),
            `test field-list for ${tc.label} missing server field "${field}"`,
          ).toBe(true);
        }
      });

      it('field-list count matches server schema count', () => {
        expect(schemaFieldNames(tc.klass).length).toBe(tc.fields.length);
      });
    });
  }
});
