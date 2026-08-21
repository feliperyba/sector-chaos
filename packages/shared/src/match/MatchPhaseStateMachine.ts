import { MatchPhase } from '../enums/MatchPhase.js';
import { ZONE } from '../constants/zone.js';

/**
 * Coarse match-band boundaries, DERIVED from the zone phase table (single
 * source of truth — a zone pacing tuning moves these bands with it):
 * ACTIVE covers zone phases 1-3, ZONE_SHRINKING 4-5, FINAL_CLOSURE 6,
 * OVERTIME (sudden death) 7+. The pre-canon hard-coded 360/540/600s
 * literals encoded the retired 120s-phase timeline and desynced the bands
 * from the actual zone as soon as pacing was tuned.
 */
const PHASE_MS = (n: number): number => ZONE.PHASES[n - 1]!.duration * 1000;
const ZONE_SHRINKING_AT_MS = PHASE_MS(1) + PHASE_MS(2) + PHASE_MS(3);
const FINAL_CLOSURE_AT_MS = ZONE_SHRINKING_AT_MS + PHASE_MS(4) + PHASE_MS(5);
const OVERTIME_AT_MS = FINAL_CLOSURE_AT_MS + PHASE_MS(6);

export interface PhaseContext {
  aliveCount: number;
  /**
   * Total match-timer elapsed time in ms (since the match started), NOT the
   * per-phase timer. Zone transitions are scheduled on the absolute match
   * timeline per the zone phase table (see ZONE_SHRINKING_AT_MS and friends
   * above).
   */
  elapsedMs: number;
  isZoneOvertime: boolean;
  /**
   * Alive-player count at or below which the match ends (last player standing
   * wins). Battle-royale rule for the real match is `1`; `0` ends only when
   * everyone is dead; `-1` disables the check entirely (test scenes).
   * Defaults to `0` when omitted.
   */
  lastStandingThreshold?: number;
}

export interface PhaseTransition {
  from: MatchPhase;
  to: MatchPhase;
  when: (context: PhaseContext) => boolean;
}

export type PhaseEventType = 'check_match_end' | 'activate_overtime';

export interface PhaseTransitionResult {
  newPhase: MatchPhase;
  events: PhaseEventType[];
}

const TRANSITIONS: readonly PhaseTransition[] = [
  {
    from: MatchPhase.ACTIVE,
    to: MatchPhase.FINISHED,
    when: (ctx) => ctx.aliveCount <= (ctx.lastStandingThreshold ?? 0),
  },
  {
    from: MatchPhase.ZONE_SHRINKING,
    to: MatchPhase.FINISHED,
    when: (ctx) => ctx.aliveCount <= (ctx.lastStandingThreshold ?? 0),
  },
  {
    from: MatchPhase.FINAL_CLOSURE,
    to: MatchPhase.FINISHED,
    when: (ctx) => ctx.aliveCount <= (ctx.lastStandingThreshold ?? 0),
  },
  {
    from: MatchPhase.OVERTIME,
    to: MatchPhase.FINISHED,
    when: (ctx) => ctx.aliveCount <= (ctx.lastStandingThreshold ?? 0),
  },
  // Zone-schedule transitions fire on the absolute match timer, thresholds
  // derived from the zone phase table (see ZONE_SHRINKING_AT_MS above).
  {
    from: MatchPhase.ACTIVE,
    to: MatchPhase.ZONE_SHRINKING,
    when: (ctx) => ctx.elapsedMs >= ZONE_SHRINKING_AT_MS,
  },
  {
    from: MatchPhase.ZONE_SHRINKING,
    to: MatchPhase.FINAL_CLOSURE,
    when: (ctx) => ctx.elapsedMs >= FINAL_CLOSURE_AT_MS,
  },
  {
    from: MatchPhase.FINAL_CLOSURE,
    to: MatchPhase.OVERTIME,
    when: (ctx) => (ctx.isZoneOvertime || ctx.elapsedMs >= OVERTIME_AT_MS) && ctx.aliveCount > 1,
  },
];

function getEvents(from: MatchPhase, to: MatchPhase): PhaseEventType[] {
  if (to === MatchPhase.FINISHED) return ['check_match_end'];
  if (from === MatchPhase.FINAL_CLOSURE && to === MatchPhase.OVERTIME) return ['activate_overtime'];
  return [];
}

export class MatchPhaseStateMachine {
  static readonly transitions = TRANSITIONS;

  tick(currentPhase: MatchPhase, context: PhaseContext): PhaseTransitionResult {
    for (const transition of TRANSITIONS) {
      if (transition.from === currentPhase && transition.when(context)) {
        return {
          newPhase: transition.to,
          events: getEvents(transition.from, transition.to),
        };
      }
    }
    return { newPhase: currentPhase, events: [] };
  }
}
