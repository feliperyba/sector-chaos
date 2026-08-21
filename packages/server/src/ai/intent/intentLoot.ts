import { BotState } from '../BotContext.ts';
import { IntentId, type Intent, type IntentContext } from './Intent.ts';
import { hpRatio, memoizedScan, SEEK_HEALTH_HP_PERCENT } from './intentHelpers.ts';
import { weaponRole, loadoutHasRole } from '../BotLoadout.ts';
import { applyArcMod } from '../arc/MatchArc.ts';

// ---------- LOOT ----------
// Preserves the FULL legacy booster economy + heal + upgrade + endgame re-arm.
// This was the biggest source of regression when the Phase-2 skeleton was first
// wired — without these conditions, armed-count dropped (no re-arm) and dmgRatio
// fell (no barrier saves). Personality: greed amplifies diversion tendency;
// caution amplifies heal-seeking.

/** The merged single-pass loot decision (perf ticket 27). */
interface LootDecision {
  /** The legacy isValid() OR-chain — can any loot source be pursued at all? */
  valid: boolean;
  /** The legacy score() value (0 when gated out; best source × greed weight). */
  score: number;
}

// Ticket 27 — mechanical union of the pre-refactor isValid() OR-chain and the
// score() branch ladder, which evaluated the SAME predicates twice per
// re-score tick (score called isValid first, then re-derived every branch
// condition). Each source block below sets BOTH `valid` (exactly the legacy
// OR-chain disjunct) and `best` (exactly the legacy score branch) under
// byte-identical guards/thresholds:
//   barrier   : guard nearestBarrier && !selfBarrierActive; close <180 → 0.85,
//               else lowHpGrab r<0.5 && <600 || preFight enemy<700 && <450 → 0.8
//   speed     : guard nearestSpeedBoost; close <160 || chase enemy∈(350,900)
//               && <300 || escape r<0.3 && <350 → 0.6
//   heal      : nearestHealth && r < (endgame?0.85:SEEK_HEALTH_HP_PERCENT)
//               && dist < (endgame?1600:1000) → 0.4 + (1-r)*0.4
//   upgrade   : nearestWeapon.tier > active.tier && dist < (endgame?900:600)
//               → 0.4 + tierGain*0.3
//   role      : floorRole && !loadoutHasRole && dist < (endgame?700:450) → 0.35
//   re-arm    : endgame && active.ammo∈(0,3) && dist < 500 → 0.7
//   chest     : dist < 1100 && (active.tier < 2 → 0.7 || dist < 500 → 0.45)
// The score-only tail (mid-fight diversion gate, best<=0, greed multiplier)
// never feeds `valid`. Pure reads only — see the memoizedScan purity-window
// proof in intentHelpers.ts.
function computeLootDecision(ic: IntentContext): LootDecision {
  const ctx = ic.ctx;
  const r = hpRatio(ctx);
  // Don't divert to loot mid-fight unless the personality is greedy OR the
  // pickup is a genuine save (low-HP barrier/health). This is the legacy
  // "enemyInFightRange → don't divert" gate, personality-weighted.
  const lowHp = r < 0.4;
  const endgame = ic.aliveBotCount > 0 && ic.aliveBotCount <= 8;
  const healThreshold = endgame ? 0.85 : SEEK_HEALTH_HP_PERCENT;
  const healSearchDist = endgame ? 1600 : 1000;
  const upgradeDist = endgame ? 900 : 600;

  let valid = false;
  // Score the best available pickup (mirrors legacy priority).
  let best = 0;
  // Barrier save: low HP, no active barrier, in range. The strongest save.
  // A close barrier grab while low-HP is a COMBAT play (absorb the incoming
  // hit), not passive looting — score it above the DUEL baseline so a bot
  // about to fight grabs a barrier it is standing on top of instead of
  // charging in naked. The pre-fight / low-HP-grab variants (farther away)
  // stay at 0.8 so they don't pull bots out of fights they should take.
  if (ctx.nearestBarrier && !ctx.selfBarrierActive) {
    const close = ctx.nearestBarrier.distance < 180;
    const lowHpGrab = r < 0.5 && ctx.nearestBarrier.distance < 600;
    const preFight =
      ctx.nearestEnemy && ctx.nearestEnemy.distance < 700 && ctx.nearestBarrier.distance < 450;
    if (close) {
      best = Math.max(best, 0.85);
    } else if (lowHpGrab || preFight) {
      best = Math.max(best, 0.8);
    }
    if (close || lowHpGrab || preFight) valid = true;
  }
  // Speed boost: chase or escape tool.
  if (ctx.nearestSpeedBoost) {
    const close = ctx.nearestSpeedBoost.distance < 160;
    const chase =
      ctx.nearestEnemy &&
      ctx.nearestEnemy.distance > 350 &&
      ctx.nearestEnemy.distance < 900 &&
      ctx.nearestSpeedBoost.distance < 300;
    const escape = r < 0.3 && ctx.nearestSpeedBoost.distance < 350;
    if (close || chase || escape) {
      best = Math.max(best, 0.6);
      valid = true;
    }
  }
  // Heal: proactive (high threshold) or critical.
  if (ctx.nearestHealth && r < healThreshold && ctx.nearestHealth.distance < healSearchDist) {
    const need = 1 - r;
    best = Math.max(best, 0.4 + need * 0.4);
    valid = true;
  }
  // Weapon upgrade: higher tier nearby.
  if (
    ctx.nearestWeapon &&
    ctx.nearestWeapon.tier > ctx.getActiveWeapon().tier &&
    ctx.nearestWeapon.distance < upgradeDist
  ) {
    const tierGain = (ctx.nearestWeapon.tier - ctx.getActiveWeapon().tier) / 3;
    best = Math.max(best, 0.4 + tierGain * 0.3);
    valid = true;
  }
  // Role-diversity: a bot holding only one role (melee OR ranged) should grab
  // a nearby weapon of the MISSING role, even at equal tier. Without this a
  // bow-only bot can't answer a close-range rusher, and a melee-only bot
  // can't pressure a kiter. The floor weapon's weaponType (now synced via
  // WorldSnapshot) makes this possible. Scored just below a tier upgrade so a
  // strict upgrade still wins, but a same-tier role-filler is worth the detour.
  if (ctx.nearestWeapon && ctx.nearestWeapon.weaponType !== undefined) {
    const floorRole = weaponRole(ctx.nearestWeapon.weaponType);
    if (floorRole && !loadoutHasRole(ctx, floorRole)) {
      const roleDist = endgame ? 700 : 450;
      if (ctx.nearestWeapon.distance < roleDist) {
        // Equal-or-higher tier gap-filler; slightly less than a pure upgrade.
        best = Math.max(best, 0.35);
        valid = true;
      }
    }
  }
  // Endgame re-arm: low-ammo weapon + nearby spare.
  if (
    endgame &&
    ctx.nearestWeapon &&
    ctx.getActiveWeapon().ammo > 0 &&
    ctx.getActiveWeapon().ammo < 3 &&
    ctx.nearestWeapon.distance < 500
  ) {
    best = Math.max(best, 0.7);
    valid = true;
  }
  // Chests: the highest-value loot source. A chest can drop a tier-2+ weapon
  // OR a powerup (barrier/heal/speed). Worth pursuing whenever the bot's loadout
  // isn't already strong — a tier<2 weapon makes the chest a strong upgrade
  // prospect (0.7); even well-armed, the powerup chance is worth a detour if
  // the chest is close (0.45). This is the fix for "bots get stuck at chests
  // but never open them" — previously no intent ever selected a chest as a goal,
  // so bots only ended up at one by coincidence and then couldn't open it.
  if (ctx.nearestChest && ctx.nearestChest.distance < 1100) {
    const activeTier = ctx.getActiveWeapon().tier;
    if (activeTier < 2) {
      best = Math.max(best, 0.7);
      valid = true;
    } else if (ctx.nearestChest.distance < 500) {
      best = Math.max(best, 0.45);
      valid = true;
    }
  }
  // Score-only tail (never feeds `valid`): the mid-fight diversion gate, the
  // nothing-scored zero, and the greed multiplier — byte-identical to the
  // legacy post-isValid score() body.
  if (ic.enemyInFightRange && !lowHp && ic.profile.greed < 0.7) {
    return { valid, score: 0 };
  }
  if (best <= 0) return { valid, score: 0 };
  // Greed amplifies; caution boosts heals (handled implicitly via healThreshold).
  return { valid, score: Math.min(1, best * (0.55 + ic.profile.greed * 0.6)) };
}

export class LootIntent implements Intent {
  readonly id = IntentId.LOOT;
  /** Memoized per (bot, tick) — see memoizedScan in intentHelpers.ts. */
  private decision(ic: IntentContext): LootDecision {
    return memoizedScan(ic, IntentId.LOOT, computeLootDecision);
  }
  score(ic: IntentContext): number {
    // MATCH ARC (ticket 10, DEC-011): LOOT is THE looting-family score —
    // shaped by lootingMod × the archetype slope (early band up to 1.5: the
    // loot-focused opening; late band down to 0.5: the armed endgame fights
    // and rotates instead of scavenging). Applied in the score() wrapper —
    // NOT inside the memoized decision — so isValid (the gate surface) is
    // untouched: the arc shapes attractiveness, never viability.
    return applyArcMod(this.decision(ic).score, ic.arc, ic.profile.archetype, 'looting');
  }
  commitTicks(ic: IntentContext): number {
    return Math.round(20 * ic.profile.skill.commitMultiplier);
  }
  isValid(ic: IntentContext): boolean {
    return this.decision(ic).valid;
  }
  execute(): { inputs: null; nextState: BotState } {
    return { inputs: null, nextState: BotState.LOOT };
  }
}

// ---------- WANDER ----------
export class WanderIntent implements Intent {
  readonly id = IntentId.WANDER;
  score(): number {
    return 0.15;
  }
  commitTicks(): number {
    return 60;
  }
  isValid(): boolean {
    return true;
  }
  execute(): { inputs: null; nextState: BotState } {
    return { inputs: null, nextState: BotState.WANDER };
  }
}
