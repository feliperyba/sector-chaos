import { Schema, type, MapSchema } from '@colyseus/schema';
import { PlayerSchema } from './PlayerSchema.ts';
import { ProjectileSchema } from './ProjectileSchema.ts';
import { PowerUpSchema } from './PowerUpSchema.ts';
import { TrapSchema } from './TrapSchema.ts';
import { ChestSchema } from './ChestSchema.ts';
import { DestructibleSchema } from './DestructibleSchema.ts';
import { ExitSchema } from './ExitSchema.ts';
import { ExplosionSchema } from './ExplosionSchema.ts';
import { ZoneSchema } from './ZoneSchema.ts';
import { EliminationRecordSchema } from './EliminationRecordSchema.ts';
import { WeaponPickupSchema } from './WeaponPickupSchema.ts';
import { SiegeSectorSchema, MapSiegeProgressSchema } from './SiegeSchema.ts';

export class GameStateSchema extends Schema {
  @type('string') matchId: string = '';
  @type('uint8') phase: number = 0;
  @type('uint32') tick: number = 0;
  @type('uint32') timestamp: number = 0;
  @type('uint32') mapSeed: number = 0;
  @type('uint16') mapWidth: number = 0;
  @type('uint16') mapHeight: number = 0;
  @type('uint8') playersAlive: number = 0;
  @type('uint32') matchTimer: number = 0;
  private _lastSentMatchTimer: number = -1;
  @type('uint32') lastProcessedInput: number = 0;

  @type({ map: PlayerSchema }) players = new MapSchema<PlayerSchema>();
  @type({ map: ProjectileSchema }) projectiles = new MapSchema<ProjectileSchema>();
  @type({ map: PowerUpSchema }) powerUps = new MapSchema<PowerUpSchema>();
  @type({ map: TrapSchema }) traps = new MapSchema<TrapSchema>();
  @type({ map: ChestSchema }) chests = new MapSchema<ChestSchema>();
  @type({ map: DestructibleSchema }) destructibles = new MapSchema<DestructibleSchema>();
  @type({ map: ExitSchema }) exits = new MapSchema<ExitSchema>();
  @type({ map: ExplosionSchema }) explosions = new MapSchema<ExplosionSchema>();

  @type(ZoneSchema) zone = new ZoneSchema();

  @type({ map: EliminationRecordSchema }) eliminationRecords =
    new MapSchema<EliminationRecordSchema>();

  @type({ map: WeaponPickupSchema }) weaponPickups = new MapSchema<WeaponPickupSchema>();
  @type({ map: SiegeSectorSchema }) siegedSectors = new MapSchema<SiegeSectorSchema>();
  @type(MapSiegeProgressSchema) mapSiegeProgress = new MapSiegeProgressSchema();

  set matchTimerSeconds(value: number) {
    if (value !== this._lastSentMatchTimer) {
      this._lastSentMatchTimer = value;
      this.matchTimer = value;
    }
  }

  /**
   * perf-arc-neo ticket 08 — static-row sync-gate bookkeeping: the last
   * per-kind domain version counters StateMapper projected. Plain fields
   * (never `@type`-decorated, so never encoded onto the wire — the
   * `_lastSentMatchTimer` pattern). Per-room by construction: each room owns
   * its own GameStateSchema instance, so concurrent matches never share
   * bookkeeping. -1 seeds the first sync (every domain counter starts at 0
   * and only ever increments).
   */
  lastProjectedDestructibleVersion = -1;
  lastProjectedExitVersion = -1;
}
