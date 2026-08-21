/**
 * Stimulus type definitions — bot-ai-v2 ticket 03 (DEC-002).
 *
 * A Stimulus is one server domain event projected into the bot "hearing"
 * model: `{type, worldX, worldY, tick, strength}`. The StimulusRouter fans
 * each routed event out to every bot within the per-type hearing radius
 * (see StimulusConfig.ts); each bot keeps a bounded queue (StimulusQueue.ts)
 * whose contents merge into the per-scan perception view (StimulusScan.ts).
 *
 * CONTRACTS (decision log DEC-002):
 *  - Server-side only, ZERO new network payloads: the router consumes the
 *    SAME aggregated domain-event stream the network mapper ships to clients
 *    (GameOrchestrator.update's return value). Bots stay players on the
 *    input pipeline — stimuli never emit inputs directly.
 *  - Tick-stamped only: `tick` is the game tick of the source event (or the
 *    ingest fallback tick for wall-clock-free services that stamp `tick: 0`,
 *    e.g. ZoneWarning). The `timestamp` field of the source event is NEVER
 *    read — no wall-clock enters this path, so the benchmark's virtual-clock
 *    determinism contract holds.
 *  - RNG-free + event-order-deterministic: delivery is a pure function of
 *    (event stream order, bot positions). Same seed → same deliveries.
 *  - Stimuli became DECISION INPUTS at bot-ai-v2 ticket 04 (the Reactor's
 *    condition reads) and ticket 05 (the believed-state layer's heard/
 *    damage/elimination belief writes — the sourcePlayerId/dirX/dirY fields
 *    below feed exactly those consumers; POSITION TRUTH still never rides
 *    a damage stimulus, only direction).
 */

/** The stimulus channels (one per routed domain event family). */
export type StimulusType =
  | 'explosion'
  | 'attack'
  | 'thrownLanded'
  | 'elimination'
  | 'chest'
  | 'zoneTelegraph'
  | 'damage';

/**
 * JSON-stable enumeration order (routedByType/deliveredByType telemetry keys
 * follow this order). Never reorder — benchmark JSON consumers index by key.
 */
export const STIMULUS_TYPE_KEYS: readonly StimulusType[] = [
  'explosion',
  'attack',
  'thrownLanded',
  'elimination',
  'chest',
  'zoneTelegraph',
  'damage',
];

/** One heard world event, tick-stamped. `strength` is the base loudness from
 * StimulusConfig.STIMULUS_BASE_STRENGTH at delivery time (0..1). */
export interface Stimulus {
  type: StimulusType;
  worldX: number;
  worldY: number;
  tick: number;
  strength: number;
  /**
   * Player IDENTITY the event is about (bot-ai-v2 ticket 05, DEC-003): the
   * FIRER of an attack, the VICTIM of an elimination, the ATTACKER of a
   * damage event. Optional — absent for sourceless events (explosions,
   * thrown landings, chests, zone). This is event identity (the same
   * information the kill feed carries), never the actor's position truth —
   * damage beliefs estimate position from direction, not from this id.
   */
  sourcePlayerId?: string;
  /**
   * Unit direction TOWARD the attacker, from the victim (damage stimuli
   * only): the negated server-authoritative knockback vector, normalized.
   * (0,0) / absent when the damage carried no knockback (direction unknown).
   * The believed-state layer's damage-origin ESTIMATE consumes this
   * (BeliefMath.estimateDamageOrigin) — the true attacker coordinates never
   * ride the stimulus.
   */
  dirX?: number;
  dirY?: number;
}

/** A stimulus with its age-decayed effective strength (the per-scan view
 * shape — see StimulusScan.refreshStimulusScan). */
export interface DecayedStimulus extends Stimulus {
  /** Base strength × linear age fade in [0, 1]; 0 exactly at expiry. */
  effectiveStrength: number;
}
