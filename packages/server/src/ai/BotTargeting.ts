import { WeaponType } from '@sector-battle/shared';
import { safeGetWeaponDef } from './BotLoadout.ts';
import type { BotContext, EnemyInfo } from './BotContext.ts';
import { LOCK_FRESHNESS_TICKS } from './belief/BeliefConfig.ts';
import { clearEnemyHistory } from './BotContextEnemyHistory.ts';
import { RECENT_DAMAGE_SCORE_WEIGHT } from './combat/BotRecentDamage.ts';

// Target locks hold for this many ticks once a target is chosen. Kept SHORT so
// bots react to the world: a closer/different enemy can win the next re-score
// instead of being ignored for 3s. 45 ticks ≈ 0.75s — long enough to avoid
// target-flipping every tick (which would cause aim thrash), short enough that
// a bot doesn't stay locked on a stale target while a better one walks by.
// (Was 180/3s — that was the dominant cause of bots clumping on one victim and
// not reacting.)
const TARGET_LOCK_TICKS = 45;

/**
 * Down-weight applied per hunter already committed to a target. With k hunters,
 * a target's score is multiplied by 1/(1 + k * HUNTER_PENALTY) — the first
 * hunter gets full score (k=0), and each additional hunter makes the target
 * less attractive, naturally spreading fire across the lobby instead of every
 * bot piling onto the same victim. At k=3 → 0.67x, k=5 → 0.5x, k=8 → 0.33x.
 * This is the standard "don't all-gank-one-target" game-AI pattern.
 */
const HUNTER_PENALTY = 0.3;

/**
 * Pick the best target for this bot this tick. A target lock is honored for
 * TARGET_LOCK_TICKS (so a committed swing isn't aborted by aim thrash), but
 * any enemy is re-scored against the lock every tick — if a closer or more
 * vulnerable one wins by a real margin, the bot switches.
 *
 * `huntersPerTarget` (optional, per-tick shared map of targetId→committed
 * hunter count) down-weights already-contested targets so bots spread across
 * the lobby instead of converging on one victim. The caller increments the
 * chosen target's count after this returns.
 */
export function selectTarget(
  ctx: BotContext,
  huntersPerTarget?: Map<string, number>,
): EnemyInfo | null {
  if (ctx.targetId) {
    const locked = ctx.enemies.find((e) => e.id === ctx.targetId);
    if (locked && locked.health > 0 && locked.distance < 1100) {
      if (ctx.tick - ctx.targetLockTick < TARGET_LOCK_TICKS) {
        // HUNTER-SPREAD GATE: the target lock previously short-circuited here
        // BEFORE the scoring loop below, so the huntersPerTarget penalty was
        // never applied to a locked bot. When HuntVulnerableIntent (or a prior
        // selectTarget) locked the same low-HP prey on several bots at once,
        // they ALL honored the lock and piled onto one victim for the full lock
        // window (45 ticks) — immune to spread — the "bots flocking and not
        // fighting correctly" symptom. Now: if 2+ hunters are already committed
        // to this target, fall through to the scoring loop so the penalty steers
        // us toward a less-contested enemy. Solo locks (0-1 hunters, the normal
        // 1v1 case) are unaffected. 2 is the threshold because a 2v1 is still
        // efficient; a 3+ v1 is a pile-on that wastes the extra hunters.
        const hunters = huntersPerTarget?.get(locked.id) ?? 0;
        // BELIEF-FRESHNESS GATE (bot-ai-v2 ticket 05, DEC-003 / AUDIT §10c.6):
        // a lock may only short-circuit re-scoring while the bot's BELIEF
        // about the target is fresh (refreshed within LOCK_FRESHNESS_TICKS =
        // two perception scan cycles). ctx.enemies can carry up to 3-tick-
        // stale entries between staggered scans — the audit's "looter stays
        // vulnerable until next scan" class of stale-lock bugs; an enemy the
        // bot has not actually perceived recently no longer holds the lock.
        // The bot re-scores instead (and if the enemy truly left perception,
        // HUNT investigates via the belief — the believed-world pursuit).
        const lockBelief = ctx.beliefs.get(locked.id);
        const lockFresh =
          lockBelief !== undefined && ctx.tick - lockBelief.tick <= LOCK_FRESHNESS_TICKS;
        if (hunters < 2 && lockFresh) return locked;
        // Locked target is over-contested or stalely-believed — fall through
        // to re-score.
      }
    }
    if (!locked || locked.health <= 0 || locked.distance > 1100) {
      const oldId = ctx.targetId;
      ctx.targetId = null;
      if (oldId) clearEnemyHistory(ctx, oldId);
    }
  }

  let best: EnemyInfo | null = null;
  let bestScore = -Infinity;

  const myWeapon = ctx.getActiveWeapon();
  const myRange = ctx.getWeaponRange(myWeapon.weaponType);

  for (const enemy of ctx.enemies) {
    if (enemy.health <= 0) continue;
    // BELIEVED-WORLD GATE (bot-ai-v2 ticket 05, DEC-003): targeting reads
    // beliefs, not raw scan lists — an entry whose belief went stale (the
    // enemy left perception and only the scan-cycle leftover remains) is a
    // believed-world stranger, not a target. On the next scan the entry is
    // replaced; meanwhile the bot re-scores toward enemies it still
    // perceives (or HUNT investigates the stale one's belief).
    const belief = ctx.beliefs.get(enemy.id);
    if (!belief || ctx.tick - belief.tick > LOCK_FRESHNESS_TICKS) continue;
    // Skip targets that cannot currently be damaged. A fresh-spawn enemy with
    // >6 ticks of invuln remaining, or any barriered enemy, is unkillable —
    // engaging them wastes the bot's position and cooldowns (and often walks
    // it into hazards near the invulnerable target). The dedicated spawn-prey
    // intent handles fresh spawns by TIMING the attack to flag-clear instead
    // of blindly targeting them here. (6 ticks ≈ 0.1s — close enough to clear
    // that holding the lock is worth it.)
    if (enemy.barrierActive) continue;
    if (enemy.isFreshSpawn && enemy.spawnInvulnTicksLeft > 6) continue;

    const distScore = 1 / (enemy.distance + 1);
    const hpRatio = enemy.health / (enemy.maxHealth || 100);
    const killSecureBonus = hpRatio < 0.3 ? 2.0 : 1.0 / (hpRatio + 0.5);
    const enemyRange = ctx.getWeaponRange(enemy.weaponType);
    const matchupScore = myRange > enemyRange + 50 ? 1.5 : myRange >= enemyRange ? 1.0 : 0.6;
    const enemyHasFists = enemy.weaponType === WeaponType.FISTS;
    const threatScore = enemyHasFists ? 2.0 : 1.0;
    const vulnerability = enemy.isInWindup ? 1.5 : 1;

    // Unknown weapon → damage lookup fails → tier 0 (non-dangerous).
    const enemyTier = safeGetWeaponDef(enemy.weaponType)?.baseStats.damage ?? 0;
    const dangerousEnemy = enemyTier > 20 ? 1.3 : 1.0;

    // Hunter spread: down-weight targets already being pursued by other bots.
    // Replaces the old thirdPartyBonus (1.3x) which REWARDED piling on a
    // contested target and was a primary driver of the deathball/flocking bug.
    const hunters = huntersPerTarget?.get(enemy.id) ?? 0;
    const hunterSpread = 1 / (1 + hunters * HUNTER_PENALTY);

    // RECENT DAMAGE (bot-ai-v2 ticket 09, DEC-010.6): the restored GDD §14.8
    // term — normalized damage this enemy took in the last 5s (observed from
    // per-scan health deltas, so it covers MY damage AND third parties').
    // Joining an ongoing fight, the weakened/invested combatant wins the
    // re-score: third-partying reads as opportunistic skill (SPEC #24).
    // Null-tolerates literal-cast test contexts without `combat`.
    const recentDamage = ctx.combat?.recentDamage.normalized(enemy.id, ctx.tick) ?? 0;

    const score =
      (distScore * 3.0 +
        killSecureBonus * 2.0 +
        matchupScore * 0.8 +
        threatScore * 1.0 +
        recentDamage * RECENT_DAMAGE_SCORE_WEIGHT) *
      vulnerability *
      hunterSpread *
      dangerousEnemy;

    if (score > bestScore) {
      bestScore = score;
      best = enemy;
    }
  }

  if (best) {
    ctx.targetId = best.id;
    ctx.targetLockTick = ctx.tick;
  }

  return best;
}
