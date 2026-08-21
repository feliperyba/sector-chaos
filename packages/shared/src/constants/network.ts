export const NETWORK = {
  TICK_RATE: 60,
  TICK_INTERVAL: 1000 / 60,
  /**
   * State-patch serialization rate (Hz). Decoupled from TICK_RATE: the
   * simulation still runs at 60Hz, but Colyseus only serializes + broadcasts
   * the schema diff at this rate. `syncEveryN = TICK_RATE / PATCH_RATE`
   * (GameRoom.ts:31) gates `StateMapper.mapDelta` accordingly.
   *
   * Was 60; reduced to 30 to bring the live server back inside its 16ms tick
   * budget. At 60Hz the per-tick cost of `mapDelta` (mutating 64 PlayerSchemas
   * × 37 fields + nested arrays every tick) PLUS Colyseus's tree-walk
   * serialization 60×/sec exceeded the budget under 64-player load → tick
   * overruns → the sim fell behind wall-clock → server-authoritative
   * positions arrived STALE relative to the client's 60Hz prediction → every
   * reconciliation built a backward `correctionOffset` → the local player
   * felt permanently dragged ("heavy/sluggish", fine for the first 5s before
   * patches arrived). Halving to 30Hz halves both costs; `syncEveryN` becomes
   * 2 so `mapDelta` runs every other tick.
   *
   * Client-side smoothness is preserved: the EntityInterpolator's primary path
   * is velocity dead-reckoning (EXTRAPOLATION_CAP_S = 0.1s), so 33ms patch
   * spacing is well within tolerance — it simply extrapolates further between
   * patches. Movement prediction/reconciliation (local player) is unaffected
   * (it runs at the full 60Hz TICK_RATE, independent of PATCH_RATE).
   */
  PATCH_RATE: 30,
  MAX_LATENCY: 500,
  INPUT_BUFFER_SIZE: 120,
  SNAPSHOT_INTERVAL: 0,
  MAX_MESSAGES_PER_SECOND: 200,
} as const;

/**
 * Authoritative simulation tick delta, in seconds. Derived from
 * {@link NETWORK.TICK_INTERVAL} so the per-tick dt can never drift away from
 * the network tick rate. This is the single source of truth for dt at every
 * physics-relevant site (server movement, client prediction, reconciliation,
 * tick timer) — see ADR-0035 for the determinism contract.
 *
 * Exact-equality is guaranteed by `network.test.ts` (`=== 1/60`), which
 * guards against IEEE-754 drift if the derivation chain ever changes.
 */
export const SIM_TICK_DT: number = NETWORK.TICK_INTERVAL / 1000;
