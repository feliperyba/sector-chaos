/**
 * Per-enemy recent-damage tracking — bot-ai-v2 ticket 09 (DEC-010.6).
 *
 * Restores the GDD §14.8 `recentDamage` targeting term: "normalized damage
 * dealt to this enemy in last 5s (cap: 100 HP = 1.0)". The implemented
 * reading (the ticket's wording): per-enemy damage TAKEN, observed from the
 * per-scan health deltas — which includes the damage THIS bot dealt AND the
 * damage third parties dealt. That is exactly the "weakened/invested
 * combatant" signal a bot JOINING an ongoing fight should prefer (SPEC #24:
 * third-partying reads as opportunistic skill).
 *
 * Feeding: BotPerception.scanWorld calls {@link noteScan} each perception
 * scan with the fresh enemy list; health DROPS between consecutive sightings
 * of the same enemy accumulate as bounded events. Reading:
 * BotTargeting adds normalized(id, tick) × RECENT_DAMAGE_SCORE_WEIGHT to the
 * additive score band (the GDD W_DAMAGE=0.3 term scaled to the code's band).
 *
 * Determinism: pure bookkeeping over the deterministic scan stream — no RNG,
 * no wall-clock. Bounded memory: ≤ RECENT_DAMAGE_MAX_EVENTS events per
 * enemy, ≤ 16 enemies (LRU eviction, same bound as the belief store).
 */

import type { EnemyInfo } from '../BotContextTypes.ts';

/** The GDD §14.8 window: damage in "last 5s". */
export const RECENT_DAMAGE_WINDOW_TICKS = 300;
/** The GDD §14.8 cap: 100 HP of damage normalizes to 1.0. */
export const RECENT_DAMAGE_CAP_HP = 100;
/**
 * The GDD W_DAMAGE term (0.3) rescaled to the code's additive band: the
 * implemented score terms run ~3.0/2.0/0.8/1.0 (a ×10 band vs the GDD's
 * 0.3/0.3/0.2/0.2), so recentDamage enters at 0.3 × 10 = 2.0 — proportional
 * to the GDD's weight relative to its proximity term (0.3 → 3.0).
 */
export const RECENT_DAMAGE_SCORE_WEIGHT = 2.0;
/** Events retained per enemy (bounded ring; old events age out at read). */
const RECENT_DAMAGE_MAX_EVENTS = 8;
/** Max tracked enemies (LRU — same bound rationale as BELIEF_MAX_ENEMIES). */
const RECENT_DAMAGE_MAX_ENEMIES = 16;

interface DamageEvent {
  amount: number;
  tick: number;
}

interface EnemyDamageEntry {
  /** Health at the last sighting — the drop baseline. */
  hpSnapshot: number;
  events: DamageEvent[];
  lastTick: number;
}

/**
 * The per-bot tracker (one instance on ctx.combat.recentDamage).
 */
export class RecentDamageTracker {
  /** Insertion-ordered; every touch moves the enemy to the tail (LRU). */
  private readonly entries = new Map<string, EnemyDamageEntry>();

  /**
   * Feed one perception scan: for every enemy in the list, a health DROP vs
   * the previous sighting becomes a damage event; the snapshot refreshes.
   * Enemies re-seen after a gap contribute their observed drop as one event
   * (heals clamp to zero — a healed enemy is not "weakened" anymore).
   */
  noteScan(enemies: readonly EnemyInfo[], tick: number): void {
    for (const e of enemies) {
      let entry = this.entries.get(e.id);
      if (!entry) {
        entry = { hpSnapshot: e.health, events: [], lastTick: tick };
        this.entries.set(e.id, entry);
        this.evictOverCap();
        continue;
      }
      const drop = entry.hpSnapshot - e.health;
      if (drop > 0) {
        entry.events.push({ amount: drop, tick });
        if (entry.events.length > RECENT_DAMAGE_MAX_EVENTS) entry.events.shift();
      }
      entry.hpSnapshot = e.health;
      entry.lastTick = tick;
      // LRU refresh (delete+set moves the key to the tail).
      this.entries.delete(e.id);
      this.entries.set(e.id, entry);
    }
  }

  /**
   * Normalized recent damage taken by `enemyId` (0..1): Σ in-window event
   * amounts ÷ RECENT_DAMAGE_CAP_HP, clamped. Unknown enemies read 0. Pure.
   * Window boundary: age ∈ [0, WINDOW−1] — "last 5s" at 60 t/s is exactly
   * 300 distinct tick ages; an event aged exactly WINDOW ticks is out.
   */
  normalized(enemyId: string, tick: number): number {
    const entry = this.entries.get(enemyId);
    if (!entry) return 0;
    let sum = 0;
    for (const ev of entry.events) {
      const age = tick - ev.tick;
      if (age < 0 || age >= RECENT_DAMAGE_WINDOW_TICKS) continue;
      sum += ev.amount;
    }
    if (sum <= 0) return 0;
    return Math.min(1, sum / RECENT_DAMAGE_CAP_HP);
  }

  /** Drop one enemy's bookkeeping (target cleared). */
  clear(enemyId: string): void {
    this.entries.delete(enemyId);
  }

  private evictOverCap(): void {
    while (this.entries.size > RECENT_DAMAGE_MAX_ENEMIES) {
      const victim = this.entries.keys().next().value;
      if (victim === undefined) break;
      this.entries.delete(victim);
    }
  }
}
