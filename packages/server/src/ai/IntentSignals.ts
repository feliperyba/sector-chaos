/**
 * IntentSignals — pure derivations that turn raw snapshot/perception data into
 * the "moment" signals a fun bot keys off: who is looting, who just spawned,
 * who is engaged with someone else (a third-party opportunity), which barrels
 * are hot (in blast range of an enemy).
 *
 * These are the EYES of the intent layer. The whole point of the redesign is
 * that a reflex bot cannot produce fun moments because it cannot SEE them —
 * the priority cascade only knew "enemy near" and "I am low HP". With these
 * signals, the intent layer can pick "hunt the looter", "ambush the spawner",
 * "third-party that duel", "detonate that barrel".
 *
 * All functions are pure (no mutation except where explicitly documented, e.g.
 * populating ctx fields) so they are trivially unit-testable.
 */
import { BARREL, WeaponType } from '@sector-battle/shared';
import type { BotContext, EnemyInfo, HotBarrelInfo } from './BotContext.ts';

/** Blast radius of a barrel explosion (px). Beyond this the barrel is harmless. */
const BLAST_RADIUS = BARREL.EXPLOSION_RADIUS;

/**
 * Mark enemies currently opening a chest as looting. Mutates ctx.enemies in
 * place (sets .isLooting). Called once per scan with the opening-chest list.
 *
 * A looting enemy is committed: the chest-open interaction locks the player
 * out of most actions, so they are the single most vulnerable target on the
 * map. This is THE "notice me" moment — without this signal the bot literally
 * cannot tell a looter from any other player.
 */
export function flagLooters(ctx: BotContext, openingPlayerIds: Set<string>): void {
  for (const e of ctx.enemies) {
    e.isLooting = openingPlayerIds.has(e.id);
  }
}

/**
 * Compute the set of player ids currently opening a chest, from the snapshot.
 * Returned as a Set for O(1) lookup in flagLooters. Built once per scan.
 */
export function collectOpeningPlayerIds(
  forEachOpeningChest: (cb: (dto: { openingPlayerId: string }) => void) => void,
): Set<string> {
  const set = new Set<string>();
  forEachOpeningChest((dto) => {
    if (dto.openingPlayerId) set.add(dto.openingPlayerId);
  });
  return set;
}

/**
 * Populate spawnInvulnTicksLeft for fresh-spawn enemies. The bot times its
 * attack to land the instant invuln clears (the most vulnerable moment: full
 * HP but fists-only, no i-frames — see PlayerStatusEffects.expireFreshSpawn).
 *
 * `expiryByEnemyId` maps enemy.id → freshSpawnExpiryTick (captured at scan
 * time from the PlayerDTO). Enemies not in the map get 0 (already vulnerable).
 *
 * Mutates ctx.enemies in place.
 */
export function flagSpawnPrey(
  ctx: BotContext,
  currentTick: number,
  expiryByEnemyId: Map<string, number>,
): void {
  for (const e of ctx.enemies) {
    if (!e.isFreshSpawn) {
      e.spawnInvulnTicksLeft = 0;
      continue;
    }
    const expiry = expiryByEnemyId.get(e.id) ?? 0;
    e.spawnInvulnTicksLeft = Math.max(0, expiry - currentTick);
  }
}

/**
 * Heuristic: is enemy A "engaged fighting someone other than me"?
 *
 * This is the third-party signal — a bot that interrupts an ongoing duel has
 * a huge advantage: both combatants are cooldown-locked, focused on each other,
 * and not watching their flank. There is no explicit per-player target field
 * in the domain (verified), so we derive it from what IS available:
 *  - A recently attacked (within ATTACK_RECENT ticks) → committed to a fight.
 *  - A is facing/near another enemy B (not me) → A's attention is on B.
 *  - A is not closing on me → I am not A's current target.
 *
 * Sets enemy.engagedTargetId to B's id when the heuristic fires, else null.
 * Mutates ctx.enemies in place.
 *
 * NOTE: this is intentionally permissive — false positives just mean a bot
 * occasionally treats a non-dueling enemy as a third-party chance, which costs
 * little. False negatives (missing real duels) are the costly failure mode
 * because the bot walks into a fair 1v1 instead of waiting for the advantage.
 */
const ATTACK_RECENT_TICKS = 60; // ~1s — "recently swung" window
const FACING_DOT_THRESHOLD = 0.5; // cos(60°) — "facing toward"
const NEAR_DIST = 600; // px — "near another enemy"

export function deriveEngagement(ctx: BotContext): void {
  const enemies = ctx.enemies;
  for (const a of enemies) {
    a.engagedTargetId = null;
    const ticksSinceAttack = ctx.tick - a.lastAttackTick;
    if (ticksSinceAttack > ATTACK_RECENT_TICKS) continue;

    // Look for a second enemy B that A is focused on (not me, not A).
    for (const b of enemies) {
      if (b.id === a.id) continue;
      const abx = b.x - a.x;
      const aby = b.y - a.y;
      const abDist = Math.sqrt(abx * abx + aby * aby);
      if (abDist > NEAR_DIST) continue;
      // Is A facing B? a.facingAngle is radians; compute dot of facing vs A→B.
      const facingX = Math.cos(a.facingAngle);
      const facingY = Math.sin(a.facingAngle);
      const abLen = abDist || 1;
      const dot = (facingX * abx + facingY * aby) / abLen;
      if (dot < FACING_DOT_THRESHOLD) continue;
      // A is committed (recent attack) AND facing/near B → A is fighting B.
      a.engagedTargetId = b.id;
      break;
    }
  }
}

/**
 * Populate ctx.hotBarrels — barrels that are in blast range of at least one
 * enemy. These are offensive opportunities (a ranged/line hit detonates them
 * for 50 AoE + chain) AND hazards (the enemy might detonate them onto the bot).
 *
 * Previously this field was declared-but-never-populated (dead infrastructure).
 * Now built each scan from destructibles (barrel positions) crossed with enemy
 * positions vs BLAST_RADIUS.
 *
 * Mutates ctx.hotBarrels (replaces contents).
 */
export function populateHotBarrels(
  ctx: BotContext,
  forEachBarrel: (cb: (b: { x: number; y: number }) => void) => void,
): void {
  ctx.hotBarrels.length = 0;
  const enemies = ctx.enemies;
  if (enemies.length === 0) return;
  const blast = BLAST_RADIUS;
  const blastSq = blast * blast;
  forEachBarrel((barrel) => {
    // Is any enemy within blast radius of this barrel?
    for (const e of enemies) {
      const dx = e.x - barrel.x;
      const dy = e.y - barrel.y;
      if (dx * dx + dy * dy <= blastSq) {
        const bdx = barrel.x - ctx.x;
        const bdy = barrel.y - ctx.y;
        ctx.hotBarrels.push({
          x: barrel.x,
          y: barrel.y,
          distance: Math.sqrt(bdx * bdx + bdy * bdy),
        } satisfies HotBarrelInfo);
        return; // one enemy in range is enough to mark it hot
      }
    }
  });
}

/**
 * Convenience: how "vulnerable" is this enemy right now, as a 0..1 score?
 * Aggregates the signals into a single value the intent layer can sort on.
 * 1.0 = maximally vulnerable (looting, or spawn-invuln about to clear while
 * fists-only), 0 = invulnerable (barrier active, or fresh-spawn invuln with
 * long remaining).
 *
 * Pure function of the enemy + ctx (no mutation).
 */
export function vulnerabilityScore(e: EnemyInfo): number {
  if (e.barrierActive) return 0; // hard invulnerable — do not bother
  if (e.isFreshSpawn && e.spawnInvulnTicksLeft > 6) {
    // Invulnerable for a while; pre-positioning is fine but no damage yet.
    // Small score so a bot will PATH toward them but not prioritize over a
    // present kill. The 6-tick floor means "about to clear" → full vulnerable.
    return 0.15;
  }
  let score = 0.1; // baseline: a present, damageable enemy is somewhat vulnerable
  if (e.isLooting) score = Math.max(score, 0.95); // committed, locked out
  if (e.spawnInvulnTicksLeft > 0 && e.spawnInvulnTicksLeft <= 6) {
    // About to clear — the optimal ambush window. Highest value.
    score = Math.max(score, 0.9);
  }
  if (e.engagedTargetId !== null) score = Math.max(score, 0.7); // third-party
  // Low HP kill-secure: the closer to death, the more vulnerable.
  const hpRatio = e.health / (e.maxHealth || 1);
  if (hpRatio < 0.3) score = Math.max(score, 0.6 + (0.3 - hpRatio)); // up to ~0.9
  // Fists-only: armed enemy is a threat, fists enemy is prey.
  if (e.weaponTier === 0 && e.weaponType === WeaponType.FISTS) {
    score = Math.max(score, 0.6);
  }
  return Math.min(1, score);
}
