/**
 * StimulusRouter — bot-ai-v2 ticket 03 (DEC-002).
 *
 * Subscribes the bot system to the server's domain-event stream: the SAME
 * aggregated event list the network mapper ships to clients
 * (GameOrchestrator.update's return value — sim + zone + siege + phase
 * events, in that order). Each stimulus-typed event fans out to every bot
 * within its per-type hearing radius as `{type, worldX, worldY, tick,
 * strength}` — a CAUSE for every later effect (ticket 04's Reactor).
 *
 * DELIVERY MECHANICS (Wei's cost constraint, DEC-002 dissent):
 *  - ONE spatial-grid range query per radius event over the EXISTING player
 *    grid (WorldSnapshot.playerGrid) — no per-bot subscriptions; cost is
 *    O(recipients), not O(bots × events).
 *  - Exact Euclidean radius membership is re-checked per candidate (the
 *    grid query is cell-aligned, not radius-exact — same contract as
 *    BotPerception's player scan).
 *  - Global events (zone telegraphs) iterate the bots map directly — no
 *    radius, no query.
 *  - The event's emitter does not hear its own event (a bot's own attack /
 *  chest open / the attacker of a damage event); the victim of a damage
 *  event DOES receive it.
 *
 * DETERMINISM: fan-out is RNG-free and event-order-deterministic (the event
 * order is server-authoritative); every stimulus is tick-stamped from the
 * source event (`event.tick`, falling back to the ingest tick for
 * wall-clock-free services like ZoneService that stamp `tick: 0`). The
 * event `timestamp` field is never read — no wall-clock in this path, so
 * the benchmark's same-seed byte-identity contract holds.
 *
 * Stimuli are INERT this ticket (DEC-002): nothing in the decision layer
 * consumes them. The two sanctioned behavioral surfaces are the shared
 * fight memory (StimulusFightMemory — the hotspot migration) and the
 * believability damage-latency channel (observation-only).
 */

import { distance } from '@sector-battle/shared';
import type { GameEvent } from '../../domain/events/index.ts';
import { STIMULUS_BASE_STRENGTH, STIMULUS_HEARING_RADII } from './StimulusConfig.ts';
import { BotStimulusState, refreshStimulusScan } from './StimulusScan.ts';
import { isFightStimulus, writeFightMemory } from './StimulusFightMemory.ts';
import { STIMULUS_TYPE_KEYS, type Stimulus, type StimulusType } from './StimulusTypes.ts';
import type { CombatHotspotMemory } from '../TickBlackboard.ts';

/** World-position resolver for events that carry no coordinates of their
 * own (ChestOpened — resolved to the OPENER's position, who stands at the
 * chest during the open channel). Null = cannot place, skip the event. */
export type PlayerPosResolver = (playerId: string) => { x: number; y: number } | null;

/** A stimulus plus its routing metadata (one per extracted event). */
export interface RoutedStimulus {
  stimulus: Stimulus;
  /** Hearing radius for this type (px); Infinity for global events. */
  radius: number;
  /** Global events deliver to every alive bot — no radius query. */
  global: boolean;
  /** Player whose action produced the event (does not hear it). */
  emitterId: string | null;
  /** Victim of a damage event (the believability latency subject). */
  subjectId: string | null;
}

/**
 * Extract the stimulus routed from one domain event. PURE — the same event
 * always yields the same routed stimulus (routing purity is unit-tested at
 * this seam). Returns null for non-stimulus events.
 *
 * Mapping of record (DEC-002 hearing table):
 *  - BarrelExploded → explosion (loud)
 *  - WeaponFired   → attack (the distant-fight channel; ANY player's
 *    attack — human gunfire feeds the bots' world too)
 *  - WeaponShattered → thrownLanded (a thrown weapon destroyed on impact —
 *    the audible landing; soft convert-to-pickup landings emit no event)
 *  - PlayerEliminated → elimination
 *  - ChestOpened  → chest, placed at the opener's position
 *  - ZoneWarning   → zoneTelegraph (global geometry)
 *  - PlayerDamaged → damage (victim hears/feels it; enables the true
 *    stimulus→response latency measurement + ticket 04's startle)
 *  SiegeWallWarning (per-tile geometry) and all other events: not routed.
 */
export function extractStimulus(
  event: GameEvent,
  fallbackTick: number,
  resolvePlayerPos: PlayerPosResolver,
): RoutedStimulus | null {
  // ZoneService (and other wall-clock-driven services) stamp `tick: 0` —
  // those stimuli carry the ingest tick instead. Never read `timestamp`.
  const tick = event.tick > 0 ? event.tick : fallbackTick;
  let type: StimulusType;
  let worldX = 0;
  let worldY = 0;
  let emitterId: string | null = null;
  let subjectId: string | null = null;
  // Ticket 05 (DEC-003) identity/direction payload: WHO the event is about
  // (never position truth) and, for damage, the direction toward the
  // attacker (the negated knockback — pure server physics).
  let sourcePlayerId: string | undefined;
  let dirX = 0;
  let dirY = 0;

  switch (event.type) {
    case 'BarrelExploded':
      type = 'explosion';
      worldX = event.position.x;
      worldY = event.position.y;
      break;
    case 'WeaponFired':
      type = 'attack';
      worldX = event.x;
      worldY = event.y;
      emitterId = event.playerId;
      sourcePlayerId = event.playerId; // the firer — feeds HEARD beliefs
      break;
    case 'WeaponShattered':
      type = 'thrownLanded';
      worldX = event.x;
      worldY = event.y;
      break;
    case 'PlayerEliminated':
      type = 'elimination';
      worldX = event.x;
      worldY = event.y;
      sourcePlayerId = event.playerId; // the victim — beliefs about them drop
      break;
    case 'ChestOpened': {
      type = 'chest';
      const pos = resolvePlayerPos(event.playerId);
      if (!pos) return null;
      worldX = pos.x;
      worldY = pos.y;
      emitterId = event.playerId;
      break;
    }
    case 'ZoneWarning':
      type = 'zoneTelegraph';
      worldX = event.nextCenterX;
      worldY = event.nextCenterY;
      break;
    case 'PlayerDamaged': {
      type = 'damage';
      worldX = event.x;
      worldY = event.y;
      emitterId = event.sourceId;
      subjectId = event.playerId;
      sourcePlayerId = event.sourceId; // the attacker — the damage belief's subject
      // Knockback = (victim − attacker)·normalized × force, so the direction
      // TOWARD the attacker is the negated, re-normalized knockback. Zero
      // knockback → (0,0): direction unknown (a sourceless hit).
      const kl = Math.sqrt(
        event.knockbackX * event.knockbackX + event.knockbackY * event.knockbackY,
      );
      if (kl > 1e-6) {
        // A zero axis negates to IEEE −0; normalize to +0 so downstream
        // telemetry/DTO deep-equals read a clean 0, not −0.
        const nx = -event.knockbackX / kl;
        const ny = -event.knockbackY / kl;
        dirX = nx === 0 ? 0 : nx;
        dirY = ny === 0 ? 0 : ny;
      }
      break;
    }
    default:
      return null;
  }

  return {
    stimulus: {
      type,
      worldX,
      worldY,
      tick,
      strength: STIMULUS_BASE_STRENGTH[type],
      ...(sourcePlayerId !== undefined ? { sourcePlayerId } : {}),
      ...(type === 'damage' ? { dirX, dirY } : {}),
    },
    radius: STIMULUS_HEARING_RADII[type],
    global: type === 'zoneTelegraph',
    emitterId,
    subjectId,
  };
}

/** Delivery counters (benchmark JSON — deterministic tick-derived ints). */
export interface StimulusDeliverySummary {
  /** Events that produced a stimulus, per type (STIMULUS_TYPE_KEYS order). */
  routedByType: Record<string, number>;
  /** Stimuli enqueued into bot queues, per type (STIMULUS_TYPE_KEYS order). */
  deliveredByType: Record<string, number>;
  deliveredTotal: number;
  /** Fight-memory writes (attack + explosion stimuli folded into hotspot). */
  fightMemoryWrites: number;
}

/** The router's view of its host system (BotSystem satisfies this
 * structurally; unit tests stub it — no room needed). */
export interface StimulusRouterDeps {
  /** Registered bots (liveness read per delivery). */
  readonly bots: Map<string, { isAlive: boolean }>;
  /** Range query over ALL players (bots + humans) near a world point. */
  queryPlayers(
    cx: number,
    cy: number,
    range: number,
    cb: (dto: { id: string; x: number; y: number }) => void,
  ): void;
  /** World position of a player id (ChestOpened placement), or null. */
  readonly resolvePlayerPos: PlayerPosResolver;
  /** The shared, persistent fight memory (hotspot migration target). */
  readonly combatHotspot: CombatHotspotMemory;
  /** Believability hook: a damage stimulus reached its victim. */
  noteDamageStimulus(botId: string, tick: number): void;
  // --- believed-state hooks (bot-ai-v2 ticket 05, DEC-003) ---
  /** A delivered attack stimulus: the bot HEARD firerId shoot at the seat. */
  noteAttackHeard(botId: string, firerId: string, x: number, y: number, tick: number): void;
  /** A damage stimulus reached its VICTIM: write the damage-direction
   *  belief (estimated origin from direction + per-bot RNG spread). */
  noteDamageDirection(
    botId: string,
    attackerId: string | null,
    x: number,
    y: number,
    dirX: number,
    dirY: number,
    tick: number,
  ): void;
  /** An elimination stimulus: victimId's beliefs drop (dead enemies are not
   *  worth investigating); an open pursuit on them closes. The stimulus seat
   *  + tick also feed ticket 09's per-bot kill-feed memory (danger sector +
   *  safe-loot window) — x/y/tick since bot-ai-v2 ticket 09 (DEC-010.4);
   *  2-argument implementations remain assignable (structural subtyping). */
  noteEliminationHeard(
    botId: string,
    victimId: string | null,
    x: number,
    y: number,
    tick: number,
  ): void;
  /**
   * KILL PROGRESS (bot-ai-v2 ticket 06, DEC-005.3): the killer of a
   * PlayerEliminated event — kills are one of the three sanctioned
   * anti-stall progress classes (displacement / completed pickups / kills),
   * so the host forwards the killer's id for a lastProgressTick stamp.
   * Called regardless of hearing radius (a kill is a kill at any distance).
   */
  noteKillScored(killerId: string, tick: number): void;
}

export class StimulusRouter {
  private readonly deps: StimulusRouterDeps;
  /** Per-bot bounded queues + scan views, keyed by playerId. */
  private readonly states = new Map<string, BotStimulusState>();
  private readonly routedByType: Record<string, number> = {};
  private readonly deliveredByType: Record<string, number> = {};
  private deliveredTotal = 0;
  private fightMemoryWrites = 0;

  constructor(deps: StimulusRouterDeps) {
    this.deps = deps;
    for (const key of STIMULUS_TYPE_KEYS) {
      this.routedByType[key] = 0;
      this.deliveredByType[key] = 0;
    }
  }

  /** Pair with BotSystem.registerBot — creates the bot's stimulus state. */
  registerBot(playerId: string): void {
    if (!this.states.has(playerId)) this.states.set(playerId, new BotStimulusState());
  }

  /** Pair with BotSystem.unregisterBot — drops the bot's stimulus state. */
  unregisterBot(playerId: string): void {
    this.states.delete(playerId);
  }

  /** A registered bot's stimulus state (queue + last scan view). */
  getState(playerId: string): BotStimulusState | undefined {
    return this.states.get(playerId);
  }

  /** Refresh a bot's per-scan stimulus view (called by the perception
   * phase each scan — the DEC-002 merge point). */
  refreshScanFor(playerId: string, nowTick: number): void {
    const state = this.states.get(playerId);
    if (state) refreshStimulusScan(state, nowTick);
  }

  /** Drop every bot state (BotSystem.dispose). Counters are kept — the
   * benchmark reads them after the match ends. */
  clearStates(): void {
    this.states.clear();
  }

  /**
   * Fan one aggregated event batch out to hearing-range bots. Called once
   * per orchestrator update with the exact stream clients receive
   * (read-only — this never drains or mutates the stream).
   */
  ingest(events: readonly GameEvent[], fallbackTick: number): void {
    for (const event of events) {
      // KILL PROGRESS (DEC-005.3): forward eliminations to their killers
      // before radius routing — a kill counts as anti-stall progress at any
      // distance (the killer is the bot whose goal just succeeded).
      if (event.type === 'PlayerEliminated' && event.killedBy) {
        this.deps.noteKillScored(event.killedBy, event.tick > 0 ? event.tick : fallbackTick);
      }
      const routed = extractStimulus(event, fallbackTick, this.deps.resolvePlayerPos);
      if (!routed) continue;
      this.routedByType[routed.stimulus.type]!++;
      if (isFightStimulus(routed.stimulus.type)) {
        writeFightMemory(this.deps.combatHotspot, routed.stimulus);
        this.fightMemoryWrites++;
      }
      if (routed.global) {
        this.deps.bots.forEach((ctx, id) => {
          if (ctx.isAlive) this.deliver(id, routed);
        });
      } else {
        const { worldX, worldY } = routed.stimulus;
        this.deps.queryPlayers(worldX, worldY, routed.radius, (dto) => {
          if (dto.id === routed.emitterId) return;
          // Exact membership: the grid returns cell-aligned candidates.
          if (distance(dto.x, dto.y, worldX, worldY) > routed.radius) return;
          this.deliver(dto.id, routed);
        });
      }
    }
  }

  private deliver(botId: string, routed: RoutedStimulus): void {
    const ctx = this.deps.bots.get(botId);
    if (!ctx || !ctx.isAlive) return;
    const state = this.states.get(botId);
    if (!state) return; // player in range but not a registered bot (human)
    const s = routed.stimulus;
    state.queue.enqueue(s);
    this.deliveredByType[s.type]!++;
    this.deliveredTotal++;
    if (s.type === 'damage' && routed.subjectId === botId) {
      this.deps.noteDamageStimulus(botId, s.tick);
      this.deps.noteDamageDirection(
        botId,
        s.sourcePlayerId ?? null,
        s.worldX,
        s.worldY,
        s.dirX ?? 0,
        s.dirY ?? 0,
        s.tick,
      );
    }
    // Believed-state fan-out (ticket 05, DEC-003): heard shots and deaths
    // feed the per-bot belief store. The emitter-exclusion above already
    // guarantees a bot never hears its own attack.
    if (s.type === 'attack' && s.sourcePlayerId !== undefined) {
      this.deps.noteAttackHeard(botId, s.sourcePlayerId, s.worldX, s.worldY, s.tick);
    }
    if (s.type === 'elimination') {
      this.deps.noteEliminationHeard(botId, s.sourcePlayerId ?? null, s.worldX, s.worldY, s.tick);
    }
  }

  /** Counter snapshot for the benchmark JSON (key order: STIMULUS_TYPE_KEYS). */
  getDeliverySummary(): StimulusDeliverySummary {
    return {
      routedByType: { ...this.routedByType },
      deliveredByType: { ...this.deliveredByType },
      deliveredTotal: this.deliveredTotal,
      fightMemoryWrites: this.fightMemoryWrites,
    };
  }
}
