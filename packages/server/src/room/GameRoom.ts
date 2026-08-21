import { Room, Client } from 'colyseus';
import { GameStateSchema } from '../infrastructure/schemas/index.ts';
import {
  NETWORK,
  type EnrichedMapData,
  type TileType,
  type GameConfig,
} from '@sector-battle/shared';
import type { GameOrchestrator } from '../application/services/GameOrchestrator.ts';
import { StateMapper, type MatchMeta } from '../infrastructure/mappers/StateMapper.ts';
import { BotManager } from '../ai/BotManager.ts';
import { Pathfinder } from '../ai/navigation/Pathfinder.ts';
import type { MapIdentityManifest } from './MapIdentityManifest.ts';
import {
  type LifecycleRoom,
  handleOnCreate,
  handleOnAuth,
  handleOnJoin,
  handleOnDrop,
  handleOnLeave,
  handleOnDispose,
} from './GameRoomLifecycle.ts';
import type { GameRoomOptions } from './GameRoomConfig.ts';
import { type MessagesRoom, handleSimulationTick } from './GameRoomMessages.ts';

export class GameRoom extends Room<{ state: GameStateSchema }> {
  maxClients = 64;
  patchRate = 1000 / NETWORK.PATCH_RATE;
  maxMessagesPerSecond = NETWORK.MAX_MESSAGES_PER_SECOND;

  private syncTickCounter = 0;
  private readonly syncEveryN = Math.round(NETWORK.TICK_RATE / NETWORK.PATCH_RATE);

  private orchestrator!: GameOrchestrator;
  private matchMeta!: MatchMeta;
  private gameConfig!: GameConfig;
  private botManager!: BotManager;
  private botFillTo = 0;
  private mapGrid!: TileType[][];
  private enrichedData: EnrichedMapData | null = null;
  /**
   * The complete map-identity bundle (Named Districts program, ADR-0038):
   * district tiers/names/designation, landmark/fortress/visual-identity
   * assignment, skeleton/mirror grids, the fairness + lighting audits and
   * the derived zone seed — every identity stream the shared generation
   * authors, carried as ONE frozen value object (see `MapIdentityManifest`
   * for the per-stream wire vs generation-only split). Built once in
   * `handleOnCreate`; `buildMapDataPayload` spreads the client-facing
   * subset, the benchmark manifest reads the audit fields.
   */
  private mapManifest!: MapIdentityManifest;
  private pathfinder!: Pathfinder;
  private removedPlayers: Set<string> = new Set();
  private spectatorFollowTargets: Map<string, string> = new Map();
  private botTakenOver: Set<string> = new Set();
  private lastChatTime: Map<string, number> = new Map();
  private matchStarted = false;

  onCreate(options: GameRoomOptions): void {
    handleOnCreate(this as unknown as LifecycleRoom, options);
  }

  async onAuth(client: Client, options: { token?: string }): Promise<{ authorized: true }> {
    return handleOnAuth(client, options);
  }

  onJoin(client: Client, options: { name?: string }): void {
    handleOnJoin(this as unknown as LifecycleRoom, client, options);
  }

  async onDrop(client: Client): Promise<void> {
    await handleOnDrop(this as unknown as LifecycleRoom, client);
  }

  onLeave(client: Client): void {
    handleOnLeave(this as unknown as LifecycleRoom, client);
  }

  onDispose(): void {
    handleOnDispose(this as unknown as LifecycleRoom);
  }

  getOrchestrator(): GameOrchestrator {
    return this.orchestrator;
  }

  /**
   * The frozen map-identity bundle stashed at map build (wire subset +
   * generation-only audit fields — see `MapIdentityManifest`).
   */
  getMapIdentityManifest(): MapIdentityManifest {
    return this.mapManifest;
  }

  recordInputTime(playerId: string): void {
    this.orchestrator.getReconnectionManager().recordInput(playerId);
  }

  syncState(): void {
    const state = this.orchestrator.getMatchState();
    const animationSystem = this.orchestrator.getSimulation().getAnimationSystem();
    StateMapper.mapDelta(state, this.state, this.matchMeta, (playerId) =>
      animationSystem.getState(playerId),
    );
  }

  /**
   * Colyseus drives this at NETWORK.TICK_INTERVAL and calls it with the REAL
   * elapsed `deltaTime` (`Room` passes `this.clock.deltaTime` to the simulation
   * callback). Feeding that real delta to the orchestrator — instead of the
   * fixed TICK_INTERVAL — lets TickTimer accumulate true wall-clock and catch up
   * when the interval drifts under load (measured ~51Hz vs 60Hz). The old code
   * ignored this arg and passed the fixed constant, so the sim ran in slow
   * motion (~85% real-time) while the client predicted at true 60Hz →
   * prediction drift → the periodic reconciliation "micro-stutter".
   */
  private onSimulationTick(deltaTime: number): void {
    handleSimulationTick(this as unknown as MessagesRoom, deltaTime);
  }

  private buildMapDataPayload(): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      grid: this.mapGrid,
      width: this.gameConfig.map.arenaWidth,
      height: this.gameConfig.map.arenaHeight,
      tileSize: this.gameConfig.map.tileWidth,
      seed: this.matchMeta.mapSeed,
    };
    if (this.enrichedData) {
      payload.visualLayers = this.enrichedData.visualLayers;
      payload.atlas = this.enrichedData.atlas;
      // Light placements ride the one-shot `mapData` message (NOT per-tick
      // schema) — zero ongoing sync cost. Cosmetic-only; client consumes in
      // ticket 10. See `docs/specs/lighting-system.md` "Wire path".
      payload.lightPlacements = this.enrichedData.entities?.lightPlacements ?? [];
    } else {
      payload.lightPlacements = [];
    }
    // Map-identity streams (Named Districts, ADR-0038) all ride the frozen
    // manifest; each block below is unchanged one-shot channel logic.
    const identity = this.mapManifest;
    // Loot-tier pyramid + per-match hot sector (map-redesign ticket 02):
    // server-authored identity data, one-shot with the map (no ongoing sync
    // cost). Absent on demo-TMX maps — the client skips tier rendering.
    if (identity.sectorTiers && identity.hotSector) {
      payload.sectorTiers = identity.sectorTiers;
      payload.hotSector = identity.hotSector;
    }
    // POI names + map designation (map-redesign ticket 03): same one-shot
    // channel, same server-authoritative rule. Absent on demo-TMX maps —
    // the client skips naming surfaces (labels, banner, designation).
    if (identity.poiNames && identity.designation) {
      payload.poiNames = identity.poiNames;
      if (identity.macroPoiNames) payload.macroPoiNames = identity.macroPoiNames;
      payload.designation = identity.designation;
    }
    // Landmarks (map-redesign ticket 04): hero composites + minor nodes, same
    // one-shot channel. The client bakes composites into the static layer and
    // draws minimap icons from this; beacons ride lightPlacements. Absent on
    // demo-TMX maps.
    if (identity.landmarks) {
      payload.landmarks = identity.landmarks;
    }
    // Fortress (map-redesign ticket 06 / DEC-004): compound/Citadel variant +
    // vault anchor + beacon spec, same one-shot channel. The beacon LIGHT
    // rides lightPlacements (appended by the SeedMapAdapter); the client
    // renders only. Absent on demo-TMX maps.
    if (identity.fortress !== undefined) {
      payload.fortress = identity.fortress;
    }
    // Visual identity (map-redesign ticket 07 / DEC-006): sector type grid +
    // floor tint fields + gateway dressing, same one-shot channel. The client
    // resolves the identity sheets and bakes everything into the static
    // layers (visual-only, zero per-frame cost). Absent on demo-TMX maps —
    // the client falls back to the legacy global wall tint.
    if (identity.sectorTypes) {
      payload.sectorTypes = identity.sectorTypes;
    }
    if (identity.identity) {
      payload.identity = identity.identity;
    }
    return payload;
  }
}
