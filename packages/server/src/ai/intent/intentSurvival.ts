import { BotState } from '../BotContext.ts';
import { IntentId, type Intent, type IntentContext } from './Intent.ts';
import {
  distToZoneCenter,
  hpRatio,
  isOnSiegeWarning,
  isOutsideZone,
  memoizedScan,
} from './intentHelpers.ts';
import { KILL_SECURE_ENEMY_HP_PERCENT } from '../BotSystemConstants.ts';
import { applyArcMod } from '../arc/MatchArc.ts';
import {
  DISENGAGE_COOLDOWN_TICKS,
  DISENGAGE_SCORE,
  evaluateDisengage,
  type DisengageCause,
} from '../combat/DiscretionTables.ts';

// ---------- SURVIVE_ZONE ----------
// Preserves: outside-zone flee, siege-warning hard flee, AND the combat-override
// (armed + enemy in range + not siege → ENGAGE instead of mutual zone-timeout,
// which is what breaks the endgame stall where the last 2 survivors orbit the
// zone center forever). The override is personality-blind — survival tactics
// are not where bots should differ.
export class SurviveZoneIntent implements Intent {
  readonly id = IntentId.SURVIVE_ZONE;
  score(ic: IntentContext): number {
    const ctx = ic.ctx;
    // COMBAT-AWARE SURVIVAL: siege crush is instant-death (100 dmg) and always
    // trumps combat → 1.0. But a bot merely OUTSIDE THE LETHAL ZONE (taking
    // gradual zone damage) with a FIGHTABLE enemy in perception range should NOT
    // hard-preempt DUEL — the bot can fight-and-reposition inward simultaneously.
    // Returning 1.0 here always beat DUEL's max (~1.0), so every zone-edge fight
    // became a flee-to-center instead of an engagement (the dominant
    // fleeZone=12% idle-with-enemy symptom). Now: if a real-weapon bot has a
    // damageable enemy within 1000px and is NOT under siege, drop to the
    // proactive level (0.5) so DUEL (baseline 0.55+) preempts via PREEMPT_MARGIN.
    // The execute() override still routes genuinely-fightable cases to ENGAGE.
    if (isOnSiegeWarning(ctx)) return 1.0;
    if (ic.zoneIsLethal && isOutsideZone(ctx)) {
      if (ctx.nearestEnemy && ctx.hasRealWeapon() && ctx.nearestEnemy.distance < 1000) {
        return 0.5;
      }
      return 1.0;
    }
    // MATCH ARC (ticket 10, DEC-011): the PROACTIVE level is the
    // positioning-family surface — positioningMod × archetype slope shapes
    // how eagerly bots pre-position (late band: up to 0.75, rotating ahead of
    // the shrink). The hard-survival levels above (siege 1.0, lethal-outside
    // 1.0, fightable zone-edge 0.5) are NEVER arc-shaped: suppression of
    // survival is not a tunable axis.
    return applyArcMod(0.5, ic.arc, ic.profile.archetype, 'positioning');
  }
  commitTicks(): number {
    return 15;
  }
  isValid(ic: IntentContext): boolean {
    const ctx = ic.ctx;
    if (ctx.zoneRadius <= 0) return false;
    // Siege walls are ALWAYS lethal (instant 100-damage crush) — flee those
    // regardless of phase.
    if (isOnSiegeWarning(ctx)) return true;
    // PROACTIVE PRE-POSITIONING: when the zone is ACTIVELY SHRINKING and the bot
    // is far from center (>60% of radius), start moving inward BEFORE taking
    // damage. Without this, bots greedily loot/fight right up to the edge, then
    // panic-flee when the shrink catches them — visibly "late to every shrink."
    // Only fires during an active shrink (not Phase 1 drop, where zoneIsShrinking
    // is false), so corner bots still loot at spawn.
    if (ctx.zoneIsShrinking && distToZoneCenter(ctx) > ctx.zoneRadius * 0.6) {
      return true;
    }
    // Outside the zone circle is only worth fleeing when the zone is actually
    // dealing damage. The map is square but the zone is a circle inscribed in
    // it, so corner-spawned bots are geometrically outside the circle at spawn
    // — but Phase 1 (the drop) deals ZERO damage. Fleeing during the drop
    // preempts SEEK_WEAPON and traps corner bots in FLEE_ZONE for 120s, so they
    // never loot (the "no objectives / wander" bug). Only flee when lethal.
    if (!ic.zoneIsLethal) return false;
    return isOutsideZone(ctx);
  }
  execute(ic: IntentContext): { inputs: null; nextState: BotState } {
    const ctx = ic.ctx;
    // COMBAT OVERRIDE: armed + enemy in engagement range + NOT siege (siege
    // crush is instant-death, ignores everything) → fight to win. This resolves
    // the endgame stall where survivors flee forever. In sudden death the zone
    // kills everyone anyway, so trading is strictly better than mutual timeout.
    //
    // ENDGAME WIDENING: with only a few bots left, the override range expands
    // from weapon-range (myRange*1.1) up to perception range (1000px). Without
    // this, the last 2-3 survivors sit on opposite sides of the zone center
    // fleeing inward in parallel — they perceive each other but never close to
    // melee range, so the override never fires and the match stalls until the
    // zone forces a crush. Widening to perception range in the true endgame
    // means "if you can SEE the last enemy, fight them" — producing the final
    // showdown instead of a parallel flee.
    if (!isOnSiegeWarning(ctx) && ctx.nearestEnemy && ctx.hasRealWeapon()) {
      // COMBAT OVERRIDE — widened to perception range (1000px) for ALL phases,
      // not just ≤3 alive. The previous myRange*1.1 gate (~280px for a Dagger)
      // meant a bot at the zone edge with an enemy at 400px fled instead of
      // fighting — they'd never close to melee while also taking zone damage, so
      // the override never fired and the match stalled (4 survivors each fleeing
      // inward in parallel, never meeting). "If you can SEE the enemy, fight
      // them" at any phase produces engagements and breaks the parallel-flee
      // stall. Siege is still exempt (instant crush death ignores everything).
      const overrideRange = 1000;
      if (ctx.nearestEnemy.distance < overrideRange) {
        return { inputs: null, nextState: BotState.ENGAGE };
      }
    }
    return { inputs: null, nextState: BotState.FLEE_ZONE };
  }
}

// ---------- RETREAT_AND_RESET ----------
// Preserves: low-HP + live-enemy-we-can't-kill-secure → disengage to reset.
// Personality: aggression raises the retreat floor (aggressors fight to lower
// HP before bailing); caution is folded via the same floor.
//
// PASSIVITY FIX: the old floor (0.12 + caution*0.32 - aggression*0.08) gave
// cautious archetypes (e.g. SURVIVOR caution 0.85) a ~0.37 floor — retreating
// at 37% HP. Combined with the personality-blind zone-edge clause (r<0.6 &&
// dist>0.7*radius), cautious bots bailed out of winnable fights the moment they
// drifted near the zone rim. The new floor is lower and tighter, and the
// zone-edge clause now requires genuine danger (lower HP AND actually deep in
// the outer ring) so a bot only retreats when it is about to die to the zone,
// not merely standing near the rim.
/** The merged single-pass retreat decision (perf ticket 27). */
interface RetreatDecision {
  /** The legacy isValid() result — enemy live, not kill-secureable, and below
   *  the retreat floor OR genuinely endangered in the deep outer ring. */
  valid: boolean;
  /** The legacy score() value (0 when invalid or above the floor). */
  score: number;
  /** ENGAGEMENT DISCRETION (bot-ai-v2 ticket 09, DEC-010.3): the accepted
   *  mid-fight disengage cause, when one fires this tick (hp / supply /
   *  thirdParty / outnumbered — see combat/DiscretionTables.ts). */
  cause?: DisengageCause;
}

// Ticket 27 — mechanical union of the pre-refactor isValid() gates and the
// score() body, which re-derived the same enemy/HP/floor predicates after
// calling isValid() first (twice per re-score tick). Every gate, threshold,
// and weight is byte-identical to the originals:
//   G1  !nearestEnemy → invalid
//   G2  enemyHpRatio < KILL_SECURE_ENEMY_HP_PERCENT → invalid (fight instead)
//   G3  r < retreatFloor (0.1 + caution*0.16 - aggression*0.05) → valid
//   G4  r < 0.4 && zoneRadius > 0 && distToZoneCenter > zoneRadius*0.85 → valid
//   score: r > retreatFloor → 0; else 0.5 + ((floor-r)/floor)*0.5, capped at 1
// Pure reads only — see the memoizedScan purity-window proof in
// intentHelpers.ts.
function computeRetreatDecision(ic: IntentContext): RetreatDecision {
  const ctx = ic.ctx;
  if (!ctx.nearestEnemy) return { valid: false, score: 0 };
  const enemyHpRatio = ctx.nearestEnemy.health / ctx.nearestEnemy.maxHealth;
  if (enemyHpRatio < KILL_SECURE_ENEMY_HP_PERCENT) {
    return { valid: false, score: 0 }; // kill-secureable — fight instead
  }
  const r = hpRatio(ctx);
  // Retreat floor: lower than before so bots fight longer. caution still
  // raises it and aggression still lowers it, but the range is compressed
  // toward the bottom: at caution=0.9/aggression=0.3 → ~0.24; at
  // caution=0.1/aggression=0.95 → ~0.10. A bot retreats only when genuinely
  // low, not at first blood.
  const retreatFloor = 0.1 + ic.profile.caution * 0.16 - ic.profile.aggression * 0.05;
  // Valid when below the personality-aware retreat floor, OR genuinely
  // endangered near the zone edge: low HP (<0.4) AND deep in the outer ring
  // (>85% of radius). The old clause (r<0.6 && >70% radius) fired on any
  // moderately-damaged bot standing anywhere in the outer third of the zone,
  // pulling bots out of fights they could win.
  let valid: boolean;
  if (r < retreatFloor) {
    valid = true;
  } else {
    const deepOuterRing = ctx.zoneRadius > 0 && distToZoneCenter(ctx) > ctx.zoneRadius * 0.85;
    valid = r < 0.4 && deepOuterRing;
  }
  // Score view (the legacy post-isValid body, byte-identical below): danger
  // under the floor scales 0.5 → 1.0; above the floor the legacy score is 0
  // (validity alone can come from the deep-outer-ring clause).
  const legacyDanger =
    r < retreatFloor ? Math.min(1, 0.5 + ((retreatFloor - r) / retreatFloor) * 0.5) : 0;
  // ENGAGEMENT DISCRETION (bot-ai-v2 ticket 09, DEC-010.3): the four
  // archetype-scaled mid-fight triggers (hp floor / supply critical /
  // third-party arrival off stimulus fight density / outnumbered via
  // incoming-threat aggregation) fold in HERE — the intent layer stays the
  // single decision point, and the winner dispatches BotState.RETREAT =
  // ticket-06's navigated break-line retreat. Kill-secure suppression,
  // archetype scaling and the no-churn guards live in DiscretionTables (the
  // Marcus-dissent no-passivity-collapse guards). Pure reads only.
  const cause = evaluateDisengage(ctx, ic.stimulusScan, ic.profile);
  if (cause) {
    return { valid: true, score: Math.max(legacyDanger, DISENGAGE_SCORE[cause]!), cause };
  }
  // DISENGAGE HOLD (the flapping guard): a discretion-triggered retreat
  // stays valid for the cooldown window after its trigger — the selector's
  // per-tick isValid check must not hard-drop the break-off on a one-tick
  // trigger flicker (no RETREAT↔ENGAGE ping-pong).
  const c = ctx.combat;
  if (
    c &&
    ctx.state === BotState.RETREAT &&
    ctx.tick - c.lastDisengageTick < DISENGAGE_COOLDOWN_TICKS
  ) {
    return { valid: true, score: 0.6 };
  }
  if (r > retreatFloor) return { valid, score: 0 };
  return { valid, score: legacyDanger };
}

export class RetreatAndResetIntent implements Intent {
  readonly id = IntentId.RETREAT_AND_RESET;
  /** Memoized per (bot, tick) — see memoizedScan in intentHelpers.ts. */
  private decision(ic: IntentContext): RetreatDecision {
    return memoizedScan(ic, IntentId.RETREAT_AND_RESET, computeRetreatDecision);
  }
  score(ic: IntentContext): number {
    return this.decision(ic).score;
  }
  commitTicks(ic: IntentContext): number {
    // Commit long enough to actually escape — 1-tick retreat→re-engage defeats it.
    return Math.round(20 * ic.profile.skill.commitMultiplier);
  }
  isValid(ic: IntentContext): boolean {
    return this.decision(ic).valid;
  }
  execute(ic: IntentContext): { inputs: null; nextState: BotState } {
    // DISENGAGE STAMP (DEC-010.3): record the accepted trigger ONCE per
    // cooldown window (the rising edge) — the hold-clause anchor + the
    // pending telemetry drain (recordTickTelemetry forwards it to the
    // believability combat surface). The stamp CLOSES the trigger's own
    // cooldown gate, so the just-computed memo (pre-stamp, cause-bearing) is
    // dropped: a same-tick re-read must re-scan and land on the hold clause
    // (0.6, valid) instead of the stale cause score.
    const d = this.decision(ic);
    const c = ic.ctx.combat;
    if (d.cause && c && ic.ctx.tick - c.lastDisengageTick >= DISENGAGE_COOLDOWN_TICKS) {
      c.lastDisengageTick = ic.ctx.tick;
      c.lastDisengageCause = d.cause;
      c.bump(c.pendingDisengages, d.cause);
      ic.ctx.intentScanMemo?.delete(IntentId.RETREAT_AND_RESET);
    }
    return { inputs: null, nextState: BotState.RETREAT };
  }
}

// ---------- ARM_UP ----------
// Preserves: unarmed → seek weapon above all (except survival). Hard gate.
export class ArmUpIntent implements Intent {
  readonly id = IntentId.ARM_UP;
  score(ic: IntentContext): number {
    // MATCH ARC (ticket 10, DEC-011): ARM_UP is a looting-family score —
    // lootingMod × archetype slope. Early (×~1.3-1.5) an unarmed bot outranks
    // everything but survival; late (×~0.5-0.7) 0.475 still beats WANDER
    // (0.15) and any suppressed LOOT source, so an endgame unarmed bot never
    // stops seeking a weapon — the arc re-weights, it does not starve.
    return applyArcMod(0.95, ic.arc, ic.profile.archetype, 'looting'); // viability gated by isValid
  }
  commitTicks(ic: IntentContext): number {
    return Math.round(25 * ic.profile.skill.commitMultiplier);
  }
  isValid(ic: IntentContext): boolean {
    return !ic.ctx.hasRealWeapon();
  }
  execute(): { inputs: null; nextState: BotState } {
    return { inputs: null, nextState: BotState.SEEK_WEAPON };
  }
}

// ---------- HUNT ----------
// Preserves: armed + no fightable enemy + tick > 600 → converge on last-seen/hotspot.
//
// PASSIVITY FIX: the old gate hard-zeroed HUNT whenever ANY enemy was
// perceived (nearestEnemy !== null), even if that enemy was far outside fight
// range. A bot that spotted an enemy across the sector, then lost the target
// lock (enemy dashed behind cover, or perception staggered every 3 ticks),
// instantly dropped HUNT — so pursuit flickered on and off. The gate now keys
// on enemyInFightRange (enemy within myRange*1.4): if the enemy is merely
// perceived but not in fight range, HUNT keeps the bot converging toward the
// last-known position / hotspot. DUEL owns the in-fight-range case.
export class HuntIntent implements Intent {
  readonly id = IntentId.HUNT;
  score(ic: IntentContext): number {
    const ctx = ic.ctx;
    if (ctx.tick <= 600) return 0;
    if (!ctx.hasRealWeapon()) return 0;
    // ENDGAME CONVERGENCE: with few bots left (≤8), the survivors are spread
    // across a 10240px map with only 1000px perception. The enemyInFightRange
    // gate (myRange*1.4 ≈ 280px) is tiny vs perception, so a bot that SEES an
    // enemy at 700px would score HUNT=0 and fall to WANDER — abandoning the
    // only contact it has. In the endgame, drop the fight-range gate: any
    // perceived enemy is worth converging on (HUNT chases last-known position).
    // DUEL still owns the in-fight-range case (it scores higher), so this only
    // affects distant endgame contacts. Outside the endgame the gate stands
    // (early-game bots should loot, not chase across the map).
    const endgame = ic.aliveBotCount > 0 && ic.aliveBotCount <= 8;
    if (!endgame && ic.enemyInFightRange) return 0;
    // MATCH ARC (ticket 10, DEC-011): HUNT (converge on the last-known enemy
    // / hotspot) is a combat-family score — suppressed in the loot-focused
    // opening, amplified in the rising late game (the escalation shape).
    return applyArcMod(0.3 + ic.profile.aggression * 0.4, ic.arc, ic.profile.archetype, 'combat');
  }
  commitTicks(ic: IntentContext): number {
    return Math.round(40 * ic.profile.skill.commitMultiplier);
  }
  isValid(ic: IntentContext): boolean {
    if (ic.ctx.tick <= 600) return false;
    if (!ic.ctx.hasRealWeapon()) return false;
    const endgame = ic.aliveBotCount > 0 && ic.aliveBotCount <= 8;
    if (!endgame && ic.enemyInFightRange) return false;
    return true;
  }
  execute(): { inputs: null; nextState: BotState } {
    return { inputs: null, nextState: BotState.HUNT };
  }
}
