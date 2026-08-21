import { CHEST, weaponRegistry } from '@sector-battle/shared';
import type { StateSync } from '../network/StateSync.js';

const TIER_NAMES = ['Common', 'Uncommon', 'Rare', 'Legendary'];
const INTERACTION_RADIUS = 32;

/**
 * Squared sentinel for the weapon-pickup proximity check (ticket #41).
 * `32 * 32 === 1024` is exact in double arithmetic, and `d2 < 1024` is
 * provably identical to the previous `Math.sqrt(d2) < 32` for EVERY
 * representable double: `sqrt(d2)` can only round UP to exactly 32 when
 * `d2 >= (32 - 2^-49)^2 = 1024 - 2^-44`, but doubles just below 1024 are
 * spaced 2^-43 apart, so no representable d2 lands in that window (verified
 * exhaustively over the 2^24 consecutive doubles below 1024 in the ticket
 * #41 test battery). The radius semantics are unchanged — only the
 * comparison form.
 */
const INTERACTION_RADIUS_SQ = INTERACTION_RADIUS * INTERACTION_RADIUS;

/**
 * Squared sentinel for the chest proximity check — same argument as
 * {@link INTERACTION_RADIUS_SQ}: `192 * 192 === 36864` exactly, and the
 * sqrt-rounding window just below 36864 (width `3 * 2^-39`) is finer than
 * the double grid there (spacing `2^-37`), so `d2 < 36864` is exactly
 * equivalent to `Math.sqrt(d2) < 192` for every representable double.
 */
const CHEST_INTERACTION_RANGE_SQ = CHEST.INTERACTION_RANGE * CHEST.INTERACTION_RANGE;

/**
 * Number of segments in the opening-progress bar. 5 keeps each step legible
 * without bloating the prompt string (the bar renders as monospace-ish block
 * chars in the existing HUD Label).
 */
const OPENING_BAR_SEGMENTS = 5;

/** Clamp `openingProgress` (seconds) to [0,1] of `CHEST.OPEN_DURATION`. */
function openingRatio(openingProgress: number): number {
  return Math.max(0, Math.min(1, openingProgress / CHEST.OPEN_DURATION));
}

/**
 * Format the chest-opening prompt with a 5-segment progress bar + percentage.
 * `openingProgress` is in seconds (0 → CHEST.OPEN_DURATION); clamped to [0,1]
 * of the duration. The string is a pure function of the rendered pair
 * `(Math.round(ratio * 5), Math.round(ratio * 100))` — the prompt cache keys
 * on exactly that pair, so the bar + percentage still refresh at the same
 * per-bucket visual cadence as the pre-#41 rebuild-every-scan form. Example
 * at 60%: `'Opening ▓▓▓░░ 60%'`.
 */
function formatOpeningPrompt(openingProgress: number): string {
  const ratio = openingRatio(openingProgress);
  const filled = Math.round(ratio * OPENING_BAR_SEGMENTS);
  const bar = '▓'.repeat(filled) + '░'.repeat(OPENING_BAR_SEGMENTS - filled);
  return `Opening ${bar} ${Math.round(ratio * 100)}%`;
}

export class InteractionDetector {
  nearestPickupId = '';
  nearestChestId = '';
  nearestType: 'weapon' | 'chest' | '' = '';
  interactionPrompt = '';

  /**
   * Prompt caches (ticket #41). The prompt strings are a pure function of a
   * small key (weapon: weaponType+tier; chest: state and, while opening, the
   * `(filledSegments, percent)` bucket), so the string is rebuilt only when
   * that key changes instead of on every send-boundary scan. Identical key →
   * identical string, so the HUD sees the exact same value sequence as
   * before (its own `===` dirty-check behavior is unchanged).
   */
  private weaponPromptKey = '';
  private weaponPromptCache = '';
  private chestPromptKey = '';
  private chestPromptCache = '';

  detect(localX: number, localY: number, stateSync: StateSync): void {
    const entities = stateSync.getEntities();

    // Squared-distance scan (ticket #41): comparisons run on d2 = dx² + dy² —
    // sqrt is monotone non-decreasing on d2, so the nearest-selection order
    // is unchanged, and the squared sentinels above are exactly equivalent
    // to the old sqrt-vs-radius checks. No distance value is exposed
    // downstream (only ids/type/prompt), so no sqrt is computed at all.
    let bestWeaponDistSq = INTERACTION_RADIUS_SQ;
    let bestWeaponId = '';
    let bestWeaponType = 0;
    let bestWeaponTier = 0;

    for (const [id, wp] of entities.weaponPickups) {
      if (wp.lifetime <= 0) continue;
      const dx = wp.x - localX;
      const dy = wp.y - localY;
      const distSq = dx * dx + dy * dy;
      if (distSq < bestWeaponDistSq) {
        bestWeaponDistSq = distSq;
        bestWeaponId = id;
        bestWeaponType = wp.weaponType;
        bestWeaponTier = wp.tier;
      }
    }

    let bestChestDistSq: number = CHEST_INTERACTION_RANGE_SQ;
    let bestChestId = '';
    let bestChestState = 0;
    let bestChestProgress = 0;

    for (const [id, c] of entities.chests) {
      if (c.state >= 2) continue;
      const dx = c.x - localX;
      const dy = c.y - localY;
      const distSq = dx * dx + dy * dy;
      if (distSq < bestChestDistSq) {
        bestChestDistSq = distSq;
        bestChestId = id;
        bestChestState = c.state;
        bestChestProgress = c.openingProgress;
      }
    }

    // Rebuild the winning prompt only when its key changes. Weapon key: the
    // string's full determinant set (weaponType + tier) — two pickups of the
    // same type/tier produce the same string, so the cache survives nearest-
    // candidate swaps between them. Chest key: state, plus the (filled,
    // percent) bucket while opening — exactly the numbers the rendered bar
    // derives from, so the progress prompt still updates the frame its
    // glyphs/percentage change.
    if (bestWeaponId) {
      const key = `w|${bestWeaponType}|${bestWeaponTier}`;
      if (key !== this.weaponPromptKey) {
        this.weaponPromptKey = key;
        const wName = weaponRegistry.getDefinition(bestWeaponType)?.name ?? 'Weapon';
        const tierName = bestWeaponTier > 0 ? (TIER_NAMES[bestWeaponTier] ?? '') : '';
        this.weaponPromptCache = tierName ? `[E] Pick up ${tierName} ${wName}` : `[E] Pick up ${wName}`;
      }
    }
    if (bestChestId) {
      let key: string;
      if (bestChestState === 1) {
        const ratio = openingRatio(bestChestProgress);
        const filled = Math.round(ratio * OPENING_BAR_SEGMENTS);
        const pct = Math.round(ratio * 100);
        key = `c|1|${filled}|${pct}`;
      } else {
        key = 'c|0';
      }
      if (key !== this.chestPromptKey) {
        this.chestPromptKey = key;
        // Opening: show a 5-segment progress bar + percentage that updates
        // each bucket change (bypasses HUDManager's text dirty-check, so the
        // timer stays live). Closed: the standard prompt.
        this.chestPromptCache = bestChestState === 1 ? formatOpeningPrompt(bestChestProgress) : '[E] Open chest';
      }
    }

    if (bestChestId && bestChestDistSq < bestWeaponDistSq) {
      this.nearestPickupId = '';
      this.nearestChestId = bestChestId;
      this.nearestType = 'chest';
      this.interactionPrompt = this.chestPromptCache;
    } else if (bestWeaponId) {
      this.nearestPickupId = bestWeaponId;
      this.nearestChestId = '';
      this.nearestType = 'weapon';
      this.interactionPrompt = this.weaponPromptCache;
    } else if (bestChestId) {
      this.nearestPickupId = '';
      this.nearestChestId = bestChestId;
      this.nearestType = 'chest';
      this.interactionPrompt = this.chestPromptCache;
    } else {
      this.nearestPickupId = '';
      this.nearestChestId = '';
      this.nearestType = '';
      this.interactionPrompt = '';
    }
  }
}
