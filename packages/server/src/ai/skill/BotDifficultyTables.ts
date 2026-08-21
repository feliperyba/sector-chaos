/**
 * MMR → per-bot difficulty assignment DATA — bot-ai-v2 ticket 08 (DEC-009.1).
 *
 * GDD §14.6 "Bot Difficulty Distribution" implemented VERBATIM as data:
 *
 *   - Bot difficulty scales with lobby MMR. Higher MMR lobbies get harder
 *     bots, lower MMR lobbies get easier bots.
 *   - Each bot receives individually-assigned difficulty from a weighted
 *     distribution (not a single global difficulty per room).
 *   - Low MMR lobby: 70% Easy, 20% Medium, 10% Hard
 *   - Mid MMR lobby: 20% Easy, 60% Medium, 20% Hard
 *   - High MMR lobby: 10% Easy, 20% Medium, 70% Hard
 *   - Lobby average MMR flows from Matchmaker → LobbyRoom → GameRoom →
 *     BotManager for per-bot weighted random difficulty assignment.
 *   - Default fallback (no MMR data): all bots receive `normal` difficulty.
 *
 * The GDD names three difficulty levels (Easy/Medium/Hard) which map onto the
 * code's DifficultyLevel enum values 'easy'/'medium'/'hard'; the default names
 * the 'normal' enum value (GameRoomLifecycle already defaults the room-wide
 * fallback to 'normal', so "no MMR data → all bots normal" holds via the
 * room-wide setter that remains the explicit fallback).
 *
 * Band edges (low/mid/high) are NOT specified by the GDD — they live here as
 * named tunable data (SPEC user story 35: tuning in tables). The chosen edges
 * give the mid band a 600-point width (three matchmaking buckets either side
 * of a 1500 midpoint — Matchmaker.MMR_RANGE = 100 per bucket).
 *
 * Determinism contract: the assignment roll is drawn by the CALLER from the
 * room's seeded stream (`simRandom('bot-difficulty')` — Math.random in
 * production, seed-deterministic under the benchmark's SimRandom override),
 * one draw per registered bot in registration order. No wall-clock reads.
 */

import type { DifficultyLevel } from '../intent/PersonalityProfile.ts';

/** Lobby MMR band selecting the distribution row. */
export type MmrBand = 'low' | 'mid' | 'high';

/** One row of a difficulty mix: an enum value + its GDD-stated percent. */
export interface DifficultyWeight {
  readonly difficulty: DifficultyLevel;
  /** Share of bots assigned this difficulty, in PERCENT (GDD table form). */
  readonly percent: number;
}

/**
 * THE GDD §14.6 TABLE (verbatim percent values). Do not "round" or renormalize
 * these — the unit suite pins them against the GDD text row by row.
 */
export const MMR_DIFFICULTY_MIX: Readonly<Record<MmrBand, readonly DifficultyWeight[]>> = {
  // Low MMR lobby: 70% Easy, 20% Medium, 10% Hard
  low: [
    { difficulty: 'easy', percent: 70 },
    { difficulty: 'medium', percent: 20 },
    { difficulty: 'hard', percent: 10 },
  ],
  // Mid MMR lobby: 20% Easy, 60% Medium, 20% Hard
  mid: [
    { difficulty: 'easy', percent: 20 },
    { difficulty: 'medium', percent: 60 },
    { difficulty: 'hard', percent: 20 },
  ],
  // High MMR lobby: 10% Easy, 20% Medium, 70% Hard
  high: [
    { difficulty: 'easy', percent: 10 },
    { difficulty: 'medium', percent: 20 },
    { difficulty: 'hard', percent: 70 },
  ],
};

/**
 * Band edges (tunable data — the GDD defines only the distributions):
 * low < 1200 ≤ mid ≤ 1800 < high.
 */
export const MMR_LOW_BAND_MAX = 1200;
export const MMR_HIGH_BAND_MIN = 1800;

/**
 * Classify a lobby's average MMR into its §14.6 band. Returns `null` for the
 * NO-DATA path (undefined, non-finite, or non-positive — the LobbyRoom leaves
 * `averageMmr` undefined when nobody carried an MMR and the Matchmaker
 * defaults to 0): the caller then applies the GDD default (the room-wide
 * difficulty, 'normal' in production) WITHOUT drawing from the stream, so the
 * default path is fully deterministic.
 */
export function mmrBandFromAverage(mmr: number | undefined): MmrBand | null {
  if (mmr === undefined || !Number.isFinite(mmr) || mmr <= 0) return null;
  if (mmr < MMR_LOW_BAND_MAX) return 'low';
  if (mmr > MMR_HIGH_BAND_MIN) return 'high';
  return 'mid';
}

/**
 * Weighted-random difficulty pick from a mix table. Pure: the roll comes from
 * the caller's seeded stream, so the same (mix, roll) pair always yields the
 * same difficulty. Rolls ≥ 1 (impossible from [0,1) streams) clamp to the
 * last row defensively.
 */
export function drawDifficultyFromMix(
  mix: readonly DifficultyWeight[],
  roll: number,
): DifficultyLevel {
  const total = mix.reduce((sum, w) => sum + w.percent, 0);
  let x = roll * total;
  for (const w of mix) {
    x -= w.percent;
    if (x < 0) return w.difficulty;
  }
  return mix[mix.length - 1]!.difficulty;
}

/**
 * The WIDE DELIBERATE MIX for all-bot benchmark lobbies (DEC-009.1): an even
 * 20/20/20/20/20 spread across ALL FIVE DifficultyLevel tiers, so believability
 * is measured across the full tier range (easy through elite — including the
 * two enum values the GDD's three-row table doesn't name). Pinned by the
 * benchmark harness via BotManager.setDifficultyMixOverride; never used by a
 * production lobby (production always goes through the MMR path or the
 * room-wide default).
 */
export const BENCH_WIDE_MIX: readonly DifficultyWeight[] = [
  { difficulty: 'easy', percent: 20 },
  { difficulty: 'normal', percent: 20 },
  { difficulty: 'medium', percent: 20 },
  { difficulty: 'hard', percent: 20 },
  { difficulty: 'elite', percent: 20 },
];
