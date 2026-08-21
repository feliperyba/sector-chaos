import { TILE_PIXEL_SIZE } from '@sector-battle/shared';
import { BotState, type EnemyInfo } from '../BotContext.ts';
import { IntentId, type Intent, type IntentContext } from './Intent.ts';
import { memoizedScan } from './intentHelpers.ts';
import { vulnerabilityScore } from '../IntentSignals.ts';
import { KILL_SECURE_ENEMY_HP_PERCENT } from '../BotSystemConstants.ts';
import { packGridKey } from '../BotDestructibles.ts';
import { applyArcMod } from '../arc/MatchArc.ts';
import {
  CONTEST_BREAK_OFF_BLACKLIST_TICKS,
  CONTEST_RECONTEST_SUSPEND_TICKS,
  contestRaceLost,
} from '../combat/ItemContests.ts';

// ---------- Per-tick inner-scan memo (perf ticket 26) ----------
// The three engage-family intents below each call their inner enemy/item scan
// from score(), isValid() AND execute() — the selector invokes isValid+score
// in both its committed-preempt loop and its full re-score loop, then the tick
// driver invokes execute() on the winner. Without a memo that is up to 3
// identical loops + 3 nested result literals per intent per bot per tick.
//
// The shared memoizedScan helper (intentHelpers.ts) owns the per-(bot, intent,
// tick) contract, the tick-boundary invalidation, and the select()→execute()
// purity-window proof (all intents' score/isValid/commitTicks are pure reads;
// the window write-set is empty). Scan-specific read-sets:
//   - scanBestVulnerable reads ctx.weapons (weaponType/ammo via hasRealWeapon)
//     and ctx.enemies fields (health, barrierActive, distance, + the
//     vulnerabilityScore fields: isFreshSpawn, spawnInvulnTicksLeft, isLooting,
//     engagedTargetId, maxHealth, weaponTier, weaponType)      → ∅
//   - scanBestHotBarrel reads ctx.hotBarrels (x, y, distance),
//     ctx.activeSlot and ctx.weapons[activeSlot].weaponType      → ∅
//   - scanContestedItem reads ctx.items (tier, type, x, y, id, distance),
//     ctx.enemies fields (health, x, y) and — ticket 09 —
//     ctx.combat.contestBreakOffUntilTick (the re-contest gate)   → ∅
// All three memoize (no guardrail exclusion needed).
//
// Value semantics: scanBestVulnerable returns a live EnemyInfo reference from
// ctx.enemies — safe because nothing mutates EnemyInfo objects inside the
// window (the per-scan mutators flagLooters/flagSpawnPrey/deriveEngagement run
// inside scanWorld, before selection) and no consumer mutates the returned
// object (execute() only reads prey.id/prey.distance). The other two scans
// return fresh literals that consumers only read.

/** Find the most vulnerable visible enemy, or null if none is vulnerable
 *  enough to be worth diverting from a normal duel. */
function scanBestVulnerable(ic: IntentContext): EnemyInfo | null {
  const ctx = ic.ctx;
  if (!ctx.hasRealWeapon()) return null;
  let best: EnemyInfo | null = null;
  let bestScore = 0;
  // Threshold: only divert if a target is meaningfully more vulnerable than
  // baseline (0.5 = clearly exploitable: looting, about-to-clear spawn,
  // third-party, or low-HP). Below that, DUEL handles it via normal targeting.
  const threshold = 0.5;
  for (const e of ctx.enemies) {
    if (e.health <= 0) continue;
    if (e.barrierActive) continue;
    const v = vulnerabilityScore(e);
    // Distance matters — a vulnerable enemy across the map isn't worth
    // diverting to (by the time we arrive, the vulnerability is gone).
    // Scale by proximity so nearby vulnerable targets win.
    const proximity = Math.max(0.3, 1 - e.distance / 1400);
    const adjusted = v * proximity;
    if (adjusted > bestScore && v >= threshold) {
      bestScore = adjusted;
      best = e;
    }
  }
  return best;
}

// ---------- HUNT_VULNERABLE (Phase 3 — "they notice me") ----------
// Targets the player a fun bot SHOULD target: the looter (committed, locked
// out), the spawn about to lose invuln (timed ambush), the third-party
// (already fighting someone else), the low-HP kill-secure, the fists-only prey.
// This is the intent that makes bots feel like they NOTICE vulnerable players
// instead of fighting whoever happens to be nearest.
//
// Implementation: scores the MOST VULNERABLE visible enemy (via the Phase-1
// IntentSignals.vulnerabilityScore), weighted by personality.opportunism. On
// execute, locks that enemy as ctx.targetId so the ENGAGE executor (selectTarget
// retains the lock for 180 ticks) pursues it specifically — not just the
// nearest enemy. Routes to ENGAGE for movement/attack (evolve-in-place).
export class HuntVulnerableIntent implements Intent {
  readonly id = IntentId.HUNT_VULNERABLE;

  /** Memoized per (bot, tick) — see memoizedScan in intentHelpers.ts. */
  private bestVulnerable(ic: IntentContext): EnemyInfo | null {
    return memoizedScan(ic, IntentId.HUNT_VULNERABLE, scanBestVulnerable);
  }

  score(ic: IntentContext): number {
    const prey = this.bestVulnerable(ic);
    if (!prey) return 0;
    // Score scales with the prey's vulnerability × the bot's opportunism
    // personality. A high-opportunism bot diverts hard for a looter; a
    // low-opportunism bot treats it as just another fight.
    const v = vulnerabilityScore(prey);
    // MATCH ARC (ticket 10, DEC-011): HUNT_VULNERABLE is a combat-family
    // score — shaped by combatMod × the archetype slope (early opportunism
    // suppressed, late amplified; AGGRESSOR resists the suppression).
    return applyArcMod(
      Math.min(1, v * (0.5 + ic.profile.opportunism * 0.6)),
      ic.arc,
      ic.profile.archetype,
      'combat',
    );
  }

  commitTicks(ic: IntentContext): number {
    // Commit long enough to reach and punish the vulnerable target. A looter
    // stays committed for ~2s (chest-open time); a spawn-prey window is ~3s.
    // Re-score if the vulnerability evaporates (prey stops looting, etc.) —
    // isValid handles that.
    return Math.round(30 * ic.profile.skill.commitMultiplier);
  }

  isValid(ic: IntentContext): boolean {
    return this.bestVulnerable(ic) !== null;
  }

  execute(ic: IntentContext): { inputs: null; nextState: BotState } {
    const prey = this.bestVulnerable(ic);
    if (prey) {
      // Lock the vulnerable target so the ENGAGE executor (selectTarget) pursues
      // THIS enemy specifically, not the nearest one. selectTarget retains a
      // locked targetId for TARGET_LOCK_TICKS (180) as long as the enemy is
      // alive and within 1100px.
      ic.ctx.targetId = prey.id;
      ic.ctx.targetLockTick = ic.ctx.tick;
      ic.ctx.engageStartTick = ic.ctx.tick;
      ic.ctx.engageStartDist = prey.distance;
    }
    return { inputs: null, nextState: BotState.ENGAGE };
  }
}

/** Find the detonate-able barrel nearest an enemy (see BarrelTrapIntent).
 *  Memoized per (bot, tick) by the intent via memoizedScan. */
function scanBestHotBarrel(ic: IntentContext): { x: number; y: number; dist: number } | null {
  const ctx = ic.ctx;
  if (ctx.hotBarrels.length === 0) return null;
  // BARREL.EXPLOSION_RADIUS = 256. The bot must be OUTSIDE the blast (else it
  // kills itself), and the barrel must be within attack range (so the bot can
  // actually hit it). For ranged weapons that's generous; for melee the bot
  // needs to be adjacent.
  const myRange = ctx.getWeaponRange(ctx.getActiveWeapon().weaponType);
  const blastRadius = 256;
  let best: { x: number; y: number; dist: number } | null = null;
  for (const b of ctx.hotBarrels) {
    // Bot must be outside the blast radius (suicide check). Use a generous
    // margin because barrels CHAIN-exploside (one detonates adjacent barrels,
    // extending the effective blast). +120 ≈ 1 tile of safety beyond the
    // base radius — enough to survive a 2-barrel chain in most layouts.
    if (b.distance < blastRadius + 120) continue;
    // Barrel must be within attack range (so we can detonate it now).
    if (b.distance > myRange * 0.95) continue;
    if (!best || b.distance < best.dist) {
      best = { x: b.x, y: b.y, dist: b.distance };
    }
  }
  return best;
}

/** Find the best tier-2+ weapon/chest an enemy is also racing for (see
 *  ContestLootIntent). Memoized per (bot, tick) via memoizedScan. Ticket 09
 *  (DEC-010.5) extends the returned shape with the racing ENEMY's id + seat
 *  (the intercept-pathing anchor) and gates on the break-off window. */
interface ContestedItemScan {
  item: { x: number; y: number; id: string };
  /** The nearest enemy also closing on the item (null = none in range). */
  enemyId: string | null;
  enemyX: number;
  enemyY: number;
  enemyDist: number;
  myDist: number;
}
function scanContestedItem(ic: IntentContext): ContestedItemScan | null {
  const ctx = ic.ctx;
  // REAL CONTESTS (bot-ai-v2 ticket 09, DEC-010.5): a lost race is broken
  // off ONCE — while the re-contest suspension window is open, the intent is
  // invalid (no ping-pong back onto the same unwinnable item).
  if (ctx.combat && ctx.tick < ctx.combat.contestBreakOffUntilTick) return null;
  // Find the best tier-2+ weapon or chest the bot can see.
  let bestItem: { x: number; y: number; id: string; tier: number; dist: number } | null = null;
  for (const item of ctx.items) {
    const isChest = item.tier === 5; // CHEST_TIER_SENTINEL
    const isHighTierWeapon = item.type === 'weapon' && item.tier >= 2;
    if (!isChest && !isHighTierWeapon) continue;
    if (
      !bestItem ||
      item.tier > bestItem.tier ||
      (item.tier === bestItem.tier && item.distance < bestItem.dist)
    ) {
      bestItem = { x: item.x, y: item.y, id: item.id, tier: item.tier, dist: item.distance };
    }
  }
  if (!bestItem) return null;
  // Is an enemy also close to this item (contesting it)?
  const contestRange = 700; // within this distance of the item = contesting
  let nearestEnemyDist = Infinity;
  let enemyId: string | null = null;
  let enemyX = 0;
  let enemyY = 0;
  for (const e of ctx.enemies) {
    if (e.health <= 0) continue;
    const dx = e.x - bestItem.x;
    const dy = e.y - bestItem.y;
    const ed = Math.sqrt(dx * dx + dy * dy);
    if (ed < contestRange && ed < nearestEnemyDist) {
      nearestEnemyDist = ed;
      enemyId = e.id;
      enemyX = e.x;
      enemyY = e.y;
    }
  }
  if (nearestEnemyDist === Infinity) return null; // no one contesting
  return {
    item: { x: bestItem.x, y: bestItem.y, id: bestItem.id },
    enemyId,
    enemyX,
    enemyY,
    enemyDist: nearestEnemyDist,
    myDist: bestItem.dist,
  };
}

// ---------- BARREL_TRAP (Phase 3 — Bomberman-style environmental play) ----------
// Find a "hot barrel" (a barrel within blast range of an enemy, detected in
// Phase 1's populateHotBarrels) and attack it to detonate — dealing 50 AoE
// damage + chain explosions to the enemy. This is the most Bomberman-ish
// tactic in the game and the one that makes the destructible world matter in
// combat. Weighted by the `trapper` personality (some bots lean into this,
// others ignore barrels).
//
// Implementation: scores high when a hot barrel is within the bot's attack
// range (so it can be detonated THIS engagement). On execute, sets the barrel
// as the demolition target (the demolition executor handles breaking it — a
// barrel has HP 4, so one good hit detonates it) and routes to DEMOLITION.
//   - If the bot has a ranged weapon, it can detonate from afar (even better).
//   - The bot must be CAREFUL not to be in the blast radius itself — the
//     intent only fires when the bot is OUTSIDE the barrel's blast range
//     (otherwise it's suicide, not a trap).
export class BarrelTrapIntent implements Intent {
  readonly id = IntentId.BARREL_TRAP;

  /** Memoized per (bot, tick) — see memoizedScan in intentHelpers.ts. */
  private bestHotBarrel(ic: IntentContext): { x: number; y: number; dist: number } | null {
    return memoizedScan(ic, IntentId.BARREL_TRAP, scanBestHotBarrel);
  }

  score(ic: IntentContext): number {
    const barrel = this.bestHotBarrel(ic);
    if (!barrel) return 0;
    // Score scales with the trapper personality. A high-trapper bot seizes
    // barrel opportunities aggressively; a low-trapper ignores them. The base
    // is high (a barrel trap is a 50-damage AoE play — very strong) so even
    // moderate-trapper bots take it when convenient.
    return Math.min(1, 0.6 + ic.profile.trapper * 0.4);
  }

  commitTicks(): number {
    // Short commit — a barrel opportunity is fleeting (the enemy moves away).
    // Either detonate it in the next second or abandon.
    return 20;
  }

  isValid(ic: IntentContext): boolean {
    return this.bestHotBarrel(ic) !== null;
  }

  execute(ic: IntentContext): { inputs: null; nextState: BotState } {
    const barrel = this.bestHotBarrel(ic);
    if (!barrel) return { inputs: null, nextState: BotState.ENGAGE };
    const ctx = ic.ctx;
    // Set the barrel as the demolition target. The demolition executor will
    // approach (if needed) and attack it. A barrel has HP 4 — one Hammer hit
    // (10 dmg) or two fist hits detonates it, triggering the 50-dmg AoE blast
    // on the nearby enemy. Convert world coords to grid for the destructibleMap
    // lookup the demolition executor uses.
    // DEC-006 fix 4: route through the SHARED accessors like every other
    // demolition path — the grid key comes from the pathfinder's tile-size
    // accessor (this previously hardcoded ts=128, correct only while the tile
    // size happens to be 128), and the target is the destructible's REAL SAT
    // collider centroid from the shared centroid map (falling back to the
    // barrel's DTO position when no enriched atlas exists). Tile-center /
    // DTO-position aim is the "misses ~88% of swings" behavior the centroid
    // map exists to fix.
    const ts = ic.pathfinder ? ic.pathfinder.getTileSize() : TILE_PIXEL_SIZE;
    const gx = Math.floor(barrel.x / ts);
    const gy = Math.floor(barrel.y / ts);
    const centroid = ic.destructibleCentroidMap?.get(packGridKey(gx, gy));
    ctx.demolitionTargetX = centroid ? centroid.x : barrel.x;
    ctx.demolitionTargetY = centroid ? centroid.y : barrel.y;
    ctx.demolitionGridX = gx;
    ctx.demolitionGridY = gy;
    ctx.preDemolitionState = BotState.ENGAGE;
    return { inputs: null, nextState: BotState.DEMOLITION };
  }
}

// ---------- CONTEST_LOOT (Phase 3 — the loot race) ----------
// Recognize an enemy heading for the same high-value item (tier-2+ weapon or
// chest) and RACE them to it — or intercept. Creates the "loot race" moment
// that makes early-game looting tense instead of solitary.
//
// Implementation: scores high when a tier-2+ weapon/chest is visible AND an
// enemy is also close to it (closer than the bot, or moving toward it). On
// execute, routes to LOOT (the loot executor paths to the item) but the bot
// has already committed to racing. The urgency comes from the commit window —
// the bot doesn't second-guess the race for 30 ticks.
export class ContestLootIntent implements Intent {
  readonly id = IntentId.CONTEST_LOOT;

  /** Memoized per (bot, tick) — see memoizedScan in intentHelpers.ts. */
  private contestedItem(ic: IntentContext): ContestedItemScan | null {
    return memoizedScan(ic, IntentId.CONTEST_LOOT, scanContestedItem);
  }

  score(ic: IntentContext): number {
    const contest = this.contestedItem(ic);
    if (!contest) return 0;
    // Score higher when the bot is CLOSER than the enemy (winnable race) and
    // the item is high-value. Greed personality amplifies — a greedy bot
    // contests harder.
    const winnable = contest.myDist < contest.enemyDist * 1.3; // within 30% = winnable
    if (!winnable && ic.profile.greed < 0.7) return 0; // too far, not greedy enough
    const proximityBonus = Math.max(0, 1 - contest.myDist / 1200);
    return Math.min(1, (0.5 + proximityBonus * 0.3) * (0.6 + ic.profile.greed * 0.5));
  }

  commitTicks(ic: IntentContext): number {
    // Commit to the race long enough to reach the item. Bailing mid-race loses
    // the item AND positions the bot badly.
    return Math.round(30 * ic.profile.skill.commitMultiplier);
  }

  isValid(ic: IntentContext): boolean {
    return this.contestedItem(ic) !== null;
  }

  execute(ic: IntentContext): { inputs: null; nextState: BotState } {
    // REAL CONTESTS (bot-ai-v2 ticket 09, DEC-010.5): publish the contested
    // seat every selected tick — executeLoot claims the item persistently,
    // routes the INTERCEPT path (the enemy's approach side), and resolves
    // the race. A decisively-lost race breaks off cleanly HERE: item
    // blacklist + the re-contest suspension window + telemetry — the bot
    // leaves for other loot and cannot re-enter the same race (no ping-pong).
    const contest = this.contestedItem(ic);
    const ctx = ic.ctx;
    const c = ctx.combat;
    if (contest && c) {
      if (contestRaceLost(contest.myDist, contest.enemyDist)) {
        c.contestedItemId = null;
        c.contestBreakOffUntilTick = ctx.tick + CONTEST_RECONTEST_SUSPEND_TICKS;
        ctx.blacklistedItems.set(contest.item.id, ctx.tick + CONTEST_BREAK_OFF_BLACKLIST_TICKS);
        c.bump(c.pendingContestOutcomes, 'breakOff');
        // The scan memo holds the PRE-break-off verdict for this tick, and the
        // suspension just flipped one of the scan's gate inputs — drop the
        // entry so any same-tick re-read (isValid/score) re-scans and sees
        // the suspension instead of a stale contest.
        ctx.intentScanMemo?.delete(IntentId.CONTEST_LOOT);
      } else {
        c.contestedItemId = contest.item.id;
        c.contestedItemX = contest.item.x;
        c.contestedItemY = contest.item.y;
        c.contestedEnemyX = contest.enemyX;
        c.contestedEnemyY = contest.enemyY;
        c.contestClaimTick = ctx.tick;
      }
    }
    // Route to LOOT — the loot executor paths to the contested item (the
    // intercept point when the race is on). The commit window keeps the bot
    // from second-guessing the race.
    return { inputs: null, nextState: BotState.LOOT };
  }
}

// ---------- DUEL ----------
// Preserves: armed + visible enemy → ENGAGE. The combat-override outside zone
// lives in SurviveZoneIntent.execute. Personality + matchup + proximity +
// kill-secure shape attractiveness; the executor handles the rest.
//
// SCORING NOTE (aggression fix): the combat score has a NON-NEGOTIABLE baseline
// — an armed bot with a live enemy in reach should fight unless survival forces
// otherwise. The old formula (aggression * matchup * proximity * killSecure)
// capped a cautious bot (aggression 0.3) at ~0.3, so it lost to LOOT (0.4+) and
// RETREAT (floor 0.5) the instant those were valid — producing the "bots never
// press an attack, they loot/wander/flee" passivity. The new formula adds a
// personality-independent floor that still lets aggression amplify and lets a
// bad matchup (heavily outranged) depress it, but never below "fight back."
export class DuelIntent implements Intent {
  readonly id = IntentId.DUEL;
  score(ic: IntentContext): number {
    const ctx = ic.ctx;
    if (!ctx.nearestEnemy || !ctx.hasRealWeapon()) return 0;
    const myRange = ctx.getWeaponRange(ctx.getActiveWeapon().weaponType);
    const enemyRange = ctx.getWeaponRange(ctx.nearestEnemy.weaponType);
    // matchup: 1.0 even, 0.6 outranged. No longer a hard multiplier on the
    // whole score — folded into the combat-quality term so the baseline holds.
    const matchup = myRange >= enemyRange ? 1.0 : 0.6;
    const proximity = Math.max(0.3, 1 - ctx.nearestEnemy.distance / 1200);
    const enemyHp = ctx.nearestEnemy.health / ctx.nearestEnemy.maxHealth;
    const killSecure =
      enemyHp < KILL_SECURE_ENEMY_HP_PERCENT ? 1.0 + ic.profile.opportunism * 0.3 : 1.0;
    // Combat quality: how GOOD this fight looks. 0..1, where 1 = a great fight
    // (point-blank, range advantage, kill-secureable). This is what personality
    // amplifies, not the whole score.
    const quality = matchup * proximity * killSecure;
    // Baseline 0.55 guarantees DUEL beats LOOT/WANDER for ANY armed bot with a
    // visible enemy, and stays competitive with RETREAT's floor (0.5) so a
    // kill-secure or even fight is taken instead of bailed on. Aggression
    // pushes the cap up to 1.0; a bad matchup can't drop it below the baseline.
    const baseline = 0.55;
    // MATCH ARC (ticket 10, DEC-011): DUEL is THE combat-family score —
    // shaped by combatMod × the archetype slope (the loot-shy opening's
    // suppressor and the rising late game's amplifier). The mid band and an
    // absent arc are the identity (pre-ticket behavior); the clamp keeps the
    // 0..1 Intent contract and caps amplified scores AT the hard-survival
    // score (SURVIVE_ZONE returns 1.0) so combat can tie but never dominate
    // survival. The baseline floor still flows through the mod — the arc
    // shapes HOW LOUD the fight-back call is, relative to loot/positioning.
    return applyArcMod(
      Math.min(1, baseline + (1 - baseline) * ic.profile.aggression * quality),
      ic.arc,
      ic.profile.archetype,
      'combat',
    );
  }
  commitTicks(ic: IntentContext): number {
    return Math.round(12 * ic.profile.skill.commitMultiplier);
  }
  isValid(ic: IntentContext): boolean {
    return ic.ctx.nearestEnemy !== null && ic.ctx.hasRealWeapon();
  }
  execute(): { inputs: null; nextState: BotState } {
    return { inputs: null, nextState: BotState.ENGAGE };
  }
}
