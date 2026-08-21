import { describe, it, expect } from 'vitest';
import { normalizeAngle as sharedNormalizeAngle } from '@sector-battle/shared';

/**
 * Characterization gate (ticket 05, adapted by ticket 06): pins the
 * relationship between
 *
 *   SHARED canonical : `packages/shared/src/math/ArcCalculation.ts:2-8`
 *                      (modulo chain + `-PI -> +PI` map + non-finite guard -> 0)
 *   BOT-AI copy      : the historical while-loop twin that lived in
 *                      `packages/server/src/ai/BotInput.ts:90-94` until
 *                      ticket 06 deleted it. It survives below as the VERBATIM
 *                      uncapped replica `botNormalizeAngle` (plus the capped
 *                      variant for the non-terminating +/-Infinity proof) so
 *                      this gate still pins the shared implementation against
 *                      the exact semantics every bot call site relied on.
 *
 * Ticket 06 replaced every bot call site with the shared `normalizeAngle` /
 * `absAngleDelta`, deleting the twin from BotInput.ts. The gate now guards the
 * SHARED implementation against regressions of its documented divergences
 * (`-PI -> +PI` map, non-finite -> 0) and its ulp-level agreement with the
 * historical loop on the atan2-production domain — the agreement the
 * bit-identical-decision benchmark in ticket 06 relies on.
 *
 * EMPIRICAL CHARACTERIZATION (measured before any assertion was written):
 *
 * | Input                          | bot while-loop (BotInput.ts:90-94)        | shared (ArcCalculation.ts:2-8)          | Verdict |
 * |--------------------------------|-------------------------------------------|-----------------------------------------|---------|
 * | dense grid over [-2PI, 2PI]    | 80.7% bit-identical to shared; the rest   | reference for the bot value; in-range   | AGREE within 8.88e-16 |
 * | (20001 pts, step ~6.3e-4)      | differ by <= 2 ulps (shared's mod chain   | inputs perturbed by up to ~2 ulps      | (measured max) |
 * |                                | rounds twice; bot is a Sterbenz-exact     | vs the bot's exact passthrough          |         |
 * |                                | single subtract / in-range identity)      |                                         |         |
 * | atan2-production domain        | 43.5% bit-identical; the rest differ by   | same mod-chain perturbation             | AGREE within 1.22e-15 |
 * | (78732 pts, see sweep below)   | <= 1.22e-15                               |                                         | (measured max) |
 * | exactly +PI                    | +PI (loop condition `PI > PI` false)     | +PI (mod chain lands on -PI, mapped up) | AGREE   |
 * | exactly -PI (and -3PI, -5PI)   | -PI (loop condition `-PI < -PI` false)    | +PI (explicit `-PI -> PI` map)          | DIVERGE: 2PI sign flip, same angle |
 * | the 4 floats adjacent to +/-PI | passthrough (in range) or wrap to the     | exactly +PI for all four (mod chain     | DIVERGE ~2 ulps as angles; ~2PI |
 * | (one ulp inside/outside)       | opposite side (one ulp outside)           | rounds the boundary-adjacent float up)  | as raw floats — documented |
 * | exactly +/-2PI (even multiples)| 0 (exact)                                 | 0 (exact)                               | AGREE   |
 * | -0                             | -0 (bit-level passthrough)                | +0                                      | AGREE mathematically; Object.is-divergent |
 * | denormal 5e-324                | 5e-324 (passthrough)                      | +0 (absorbed by +PI in mod chain)       | AGREE mathematically (cos/sin identical) |
 * | NaN                            | NaN (propagates; loop exits immediately)  | 0 (Number.isFinite guard)               | DIVERGE — the drift ticket 06 removes |
 * | +Infinity / -Infinity          | NEVER TERMINATES (`Inf - 2PI === Inf`)    | 0                                       | DIVERGE — bot would HANG the tick |
 * | +/-1e3 rad                     | 159 iterations, error 2.31e-12 vs shared  | exact (single modulo chain)             | AGREE to 2.9e-12 |
 * | +/-1e4 rad                     | 1 592 iterations, error 8.92e-11          | exact                                  | AGREE to 1.1e-10 |
 * | +/-1e5 rad                     | 15 915 iterations, error 1.05e-8          | exact                                  | AGREE to 1.3e-8 |
 * | +/-1e6 rad                     | 159 155 iterations, error 1.39e-6         | exact                                  | AGREE to 1.7e-6 |
 * | +/-1e7 rad                     | 1 591 549 iterations, error 1.54e-4       | exact                                  | AGREE to 1.9e-4 |
 * | +/-1e9 rad (NOT executed here) | ~159M iterations (~0.4s), error 2.46 rad  | exact                                  | DIVERGE — bot result wrong by ~2.5 rad |
 *
 * WHY EPSILON, NOT EXACT EQUALITY: the bot loop is a single Sterbenz-exact
 * subtract (or an exact identity for already-normalized inputs), while the
 * shared modulo chain rounds up to twice — so shared PERTURBS even in-range
 * inputs by up to a few ulps (e.g. shared(PI/4) !== PI/4 exactly, while
 * bot(PI/4) === PI/4). Bit-exact agreement is therefore unattainable by
 * construction; measured worst raw-float deviation is 1.22e-15 (~5.5 ulps at
 * unit scale) across 98k+ production-class inputs. PARITY_EPSILON below adds
 * ~60% headroom over that measurement while staying ~15 orders of magnitude
 * below the smallest angle threshold bot code actually compares against
 * (PI/3, BotCombatShared.ts:199,289).
 *
 * The bot while-loop error at LARGE magnitudes grows ~linearly with the
 * iteration count (each subtract/add rounds at the CURRENT large magnitude,
 * ~1 ulp per iteration): it stays inside [-PI, PI] but its position inside
 * that range drifts from the shared result as the input magnitude grows.
 * None of the (historical) bot call sites produce magnitudes beyond
 * ~[-2PI, 2PI] (see the atan2-domain sweep below), so on production-class
 * inputs the two implementations are interchangeable — which is exactly what
 * ticket 06 needed proven before deleting the bot copy.
 *
 * Ticket 06 HAS landed: the bot twin is deleted from BotInput.ts, every call
 * site uses the shared normalizeAngle/absAngleDelta, and this gate keeps
 * pinning the shared implementation against the verbatim replica above.
 */

const PI = Math.PI;
const TWO_PI = PI * 2;

/**
 * Raw-float absolute agreement bound for finite inputs. Measured worst case:
 * 1.22e-15 (atan2-domain sweep); ulp-stepped probes measured up to 1.11e-15
 * near PI/2; the dense grid up to 8.88e-16. 2e-15 = ~9 ulps at unit scale.
 */
const PARITY_EPSILON = 2e-15;

/**
 * VERBATIM uncapped transcription of the historical loop at BotInput.ts:90-94
 * (deleted by ticket 06). Body statements, their order, and both `while`
 * conditions are identical. NaN is safe here (both comparisons are false); it
 * must NEVER be called with +/-Infinity (the loop provably never terminates —
 * asserted below via the capped variant).
 */
function botNormalizeAngle(a: number): number {
  while (a > PI) a -= TWO_PI;
  while (a < -PI) a += TWO_PI;
  return a;
}

/**
 * VERBATIM transcription of the same loop, instrumented with an iteration cap.
 * Used ONLY where the uncapped replica cannot be called:
 * (a) +/-Infinity — the real loop provably never terminates (asserted below),
 * (b) counting iterations for the large-multiple divergence table. The body
 * statements, their order, and both `while` conditions are identical.
 */
function botNormalizeAngleCapped(
  a: number,
  cap: number,
): { value: number; iterations: number; hitCap: boolean } {
  let iterations = 0;
  while (a > PI) {
    a -= TWO_PI;
    iterations += 1;
    if (iterations >= cap) return { value: a, iterations, hitCap: true };
  }
  while (a < -PI) {
    a += TWO_PI;
    iterations += 1;
    if (iterations >= cap) return { value: a, iterations, hitCap: true };
  }
  return { value: a, iterations, hitCap: false };
}

/**
 * Classifies the parity of one finite input against the two DOCUMENTED
 * divergence classes; anything outside them and PARITY_EPSILON is an error
 * string (fails the gate).
 *
 * - 'exact': bit-for-bit identical outputs (80.7% of the dense grid, 43.5% of
 *   the atan2-domain inputs — this is the agreement ticket 06 relies on).
 * - 'boundary': exact odd NEGATIVE multiple of PI — bot passes -PI through,
 *   shared maps it to +PI. Same angle, opposite sign bit.
 * - 'collapse': the floats adjacent to +/-PI where shared's modulo chain
 *   collapses to exactly +PI while bot stays on its side. Angularly <= ~2
 *   ulps apart, raw-float ~2PI apart (see the boundary pins test).
 * - 'epsilon': raw-float diff within PARITY_EPSILON (sporadic 1-2 ulp
 *   differences from shared's mod-chain rounding; measured on 19% of the
 *   dense grid and 56% of the atan2-domain inputs).
 */
type ParityClass = 'exact' | 'boundary' | 'collapse' | 'epsilon';

function classifyParity(a: number): ParityClass | string {
  const bot = botNormalizeAngle(a);
  const shared = sharedNormalizeAngle(a);
  if (Object.is(bot, shared)) return 'exact';
  if (bot === -PI && shared === PI) return 'boundary';
  if (shared === PI && Math.abs(Math.abs(bot) - PI) <= PARITY_EPSILON) return 'collapse';
  const d = Math.abs(bot - shared);
  if (d <= PARITY_EPSILON) return 'epsilon';
  return `a=${a}: bot=${bot} shared=${shared} |rawDiff|=${d}`;
}

describe('normalizeAngle shared/bot parity (ticket 05 characterization gate)', () => {
  it('agrees within the documented epsilon on a dense finite grid over [-2PI, 2PI]', () => {
    // 20001 points, step ~6.3e-4 — denser than any bot-call-site input spacing.
    // Measured distribution (deterministic floats, V8): 16136 exact,
    // 3864 epsilon-class (all <= 8.88e-16), 1 boundary (the grid lands on
    // exact -PI), 0 collapse, 0 violations.
    const steps = 20000;
    const failures: string[] = [];
    let exact = 0;
    let epsilonClass = 0;
    let boundaryExceptions = 0;
    let collapseExceptions = 0;
    let maxEpsilonDiff = 0;
    for (let i = 0; i <= steps; i += 1) {
      const a = -TWO_PI + (4 * PI * i) / steps;
      const result = classifyParity(a);
      if (result === 'exact') {
        exact += 1;
        continue;
      }
      if (result === 'epsilon') {
        epsilonClass += 1;
        maxEpsilonDiff = Math.max(
          maxEpsilonDiff,
          Math.abs(botNormalizeAngle(a) - sharedNormalizeAngle(a)),
        );
        continue;
      }
      if (result === 'boundary') {
        boundaryExceptions += 1;
        continue;
      }
      if (result === 'collapse') {
        collapseExceptions += 1;
        continue;
      }
      if (failures.length < 5) failures.push(result);
      else if (failures.length === 5) failures.push('(more failures suppressed)');
    }
    expect(failures, failures.join('; ')).toEqual([]);
    expect(maxEpsilonDiff).toBeLessThanOrEqual(PARITY_EPSILON);
    // Deterministic pins (fail loud on ANY drift): the grid hits exact -PI
    // exactly once, never hits the collapse floats, and stays >75% bit-exact.
    expect(boundaryExceptions).toBe(1);
    expect(collapseExceptions).toBe(0);
    expect(exact).toBeGreaterThan(steps * 0.75);
    expect(epsilonClass).toBeLessThan(steps * 0.25);

    // Both stay inside the closed [-PI, PI] interval on the whole grid.
    for (let i = 0; i <= steps; i += 25) {
      const a = -TWO_PI + (4 * PI * i) / steps;
      expect(botNormalizeAngle(a)).toBeGreaterThanOrEqual(-PI);
      expect(botNormalizeAngle(a)).toBeLessThanOrEqual(PI);
      expect(sharedNormalizeAngle(a)).toBeGreaterThanOrEqual(-PI);
      expect(sharedNormalizeAngle(a)).toBeLessThanOrEqual(PI);
    }
  });

  it('agrees within the documented epsilon on the exact input class bot call sites produce (atan2 output +/- offsets, atan2-atan2 diffs)', () => {
    // Bot callers (verified): BotCombatEngage.ts:154,356,408,424 and
    // BotCombatDemolition.ts:71 feed `angleTo(...)+offset` (atan2 output,
    // [-PI, PI], plus offsets up to PI/2, PI/3, PI/6, PI/4);
    // BotInput.ts:97 (angleDiff) and BotCombatShared.ts:198,289 feed
    // atan2-minus-atan2 diffs ([-2PI, 2PI]). atan2 NEVER returns non-finite
    // for finite coordinates — the only finite domain bot code can produce.
    // Measured distribution: 34229 exact, 44342 epsilon-class (max 1.22e-15),
    // 161 boundary, 0 violations.
    const offsets = [PI / 2, -PI / 2, PI / 3, -PI / 3, PI / 6, -PI / 6, PI / 4, -PI / 4, PI];
    const failures: string[] = [];
    let checked = 0;
    let boundaryExceptions = 0;
    let epsilonClass = 0;
    for (let y = -40; y <= 40 && failures.length < 5; y += 1) {
      for (let x = -40; x <= 40; x += 1) {
        const a1 = Math.atan2(y, x); // === BotInput.ts:82-84 angleTo
        const probe = (a: number): void => {
          checked += 1;
          const result = classifyParity(a);
          if (result === 'exact') return;
          if (result === 'boundary' || result === 'collapse') {
            boundaryExceptions += 1;
            return;
          }
          if (result === 'epsilon') {
            epsilonClass += 1;
            return;
          }
          if (failures.length < 5) failures.push(result);
        };
        for (const off of offsets) probe(a1 + off);
        // angleDiff(a, b) = |normalizeAngle(a - b)| — the diff of two atan2
        // outputs. Exact -PI diffs DO occur (PI/2 + PI/2 === PI exactly), and
        // the boundary class covers them.
        for (const a2 of [Math.atan2(-y, x), Math.atan2(y, -x), a1]) probe(a1 - a2);
      }
    }
    expect(failures, failures.join('; ')).toEqual([]);
    // Sanity: the sweep exercised ~79k inputs, hit the exact -PI boundary
    // class (atan2 = +/-PI/2 pairs), and epsilon-class differences are the
    // documented majority for in-range passthrough inputs.
    expect(checked).toBeGreaterThan(50000);
    expect(boundaryExceptions).toBeGreaterThan(0);
    expect(epsilonClass).toBeGreaterThan(0);
  });

  it('agrees within the epsilon at ulp scale around the boundary centers (as angles)', () => {
    // Ulp-stepped probes: shared's two roundings vs the bot's exact subtract
    // differ by up to 5.5 unit-scale ulps here (measured max 1.11e-15 near
    // PI/2) — inside PARITY_EPSILON.
    //
    // COLLAPSE CLASS: shared maps the four floats adjacent to +/-PI to exactly
    // +PI (pinned in the boundary test). For those points the RAW float diff
    // is ~2PI (sign flip) while the ANGULAR diff is <= ~2 ulps. Agreement for
    // an angle normalizer means angular agreement, so each point must satisfy
    // EITHER the raw diff <= epsilon OR the documented collapse class.
    const centers = [0, PI / 2, -PI / 2, PI, -PI, TWO_PI, -TWO_PI];
    for (const c of centers) {
      let maxAngularDiff = 0;
      let worstAt = 0;
      let collapseClassHits = 0;
      for (let k = -80; k <= 80; k += 1) {
        const ulp = c === 0 ? Number.EPSILON : Math.abs(c) * Number.EPSILON;
        const a = c + k * ulp * 4;
        const bot = botNormalizeAngle(a);
        const shared = sharedNormalizeAngle(a);
        // Both implementations stay in range at ulp scale too.
        expect(bot, `bot(${a}) out of range`).toBeGreaterThanOrEqual(-PI);
        expect(bot, `bot(${a}) out of range`).toBeLessThanOrEqual(PI);
        expect(shared, `shared(${a}) out of range`).toBeGreaterThanOrEqual(-PI);
        expect(shared, `shared(${a}) out of range`).toBeLessThanOrEqual(PI);

        if (shared === PI && Math.abs(Math.abs(bot) - PI) <= PARITY_EPSILON) {
          // Documented collapse class (includes exact -PI): the angular diff
          // |(|bot| - PI)| is <= epsilon by this very condition.
          collapseClassHits += 1;
          maxAngularDiff = Math.max(maxAngularDiff, Math.abs(Math.abs(bot) - PI));
          continue;
        }
        const d = Math.abs(bot - shared);
        if (d > maxAngularDiff) {
          maxAngularDiff = d;
          worstAt = a;
        }
      }
      expect(
        maxAngularDiff,
        `center ${c}: |bot-shared| ${maxAngularDiff.toExponential(3)} at a=${worstAt} exceeds ${PARITY_EPSILON}`,
      ).toBeLessThanOrEqual(PARITY_EPSILON);
      // The -PI-centered probe includes the center itself (k=0): the exact -PI
      // boundary flip MUST be classified here (collapse class covers it).
      if (c === -PI) {
        expect(collapseClassHits).toBeGreaterThan(0);
      }
    }
  });

  it('pins the +/-PI boundary semantics explicitly (shared maps -PI -> +PI; bot passes -PI through)', () => {
    // +PI: AGREE, both +PI.
    expect(Object.is(botNormalizeAngle(PI), PI)).toBe(true);
    expect(Object.is(sharedNormalizeAngle(PI), PI)).toBe(true);

    // -PI: DIVERGE. Bot: `-PI < -PI` is false -> passes -PI through.
    // Shared: mod chain lands on -PI, explicit map lifts it to +PI
    // (ArcCalculation.ts:6-7). Same angle, opposite sign bit.
    expect(Object.is(botNormalizeAngle(-PI), -PI)).toBe(true);
    expect(Object.is(sharedNormalizeAngle(-PI), PI)).toBe(true);

    // Exact odd NEGATIVE multiples of PI wrap to -PI (bot) vs +PI (shared).
    // (-3PI, -5PI are exact floats whose loop arithmetic stays Sterbenz-exact
    // down to -PI.)
    for (const a of [-3 * PI, -5 * PI]) {
      expect(Object.is(botNormalizeAngle(a), -PI)).toBe(true);
      expect(Object.is(sharedNormalizeAngle(a), PI)).toBe(true);
    }
    // Exact odd POSITIVE multiples of PI: AGREE on +PI.
    for (const a of [3 * PI, 5 * PI]) {
      expect(Object.is(botNormalizeAngle(a), PI)).toBe(true);
      expect(Object.is(sharedNormalizeAngle(a), PI)).toBe(true);
    }

    // +/-2PI (and further even multiples): AGREE on exact 0.
    for (const a of [TWO_PI, -TWO_PI, 4 * PI, -4 * PI]) {
      expect(Object.is(botNormalizeAngle(a), 0)).toBe(true);
      expect(Object.is(sharedNormalizeAngle(a), 0)).toBe(true);
    }

    // 0 and -0: AGREE mathematically; the -0 SIGN BIT diverges (bot is a
    // passthrough, shared's mod chain yields +0). Harmless — cos/sin and all
    // consumers treat +0 === -0 (loose === says equal; only Object.is
    // separates them).
    expect(Object.is(botNormalizeAngle(0), 0)).toBe(true);
    expect(Object.is(sharedNormalizeAngle(0), 0)).toBe(true);
    expect(Object.is(botNormalizeAngle(-0), -0)).toBe(true);
    expect(Object.is(sharedNormalizeAngle(-0), 0)).toBe(true);
    expect(botNormalizeAngle(-0) === 0).toBe(true); // === cannot see the sign bit

    // Denormal: bot passes through, shared absorbs to +0. Gameplay-neutral
    // (both are "the zero angle") — documented, not fixed.
    expect(Object.is(botNormalizeAngle(5e-324), 5e-324)).toBe(true);
    expect(Object.is(sharedNormalizeAngle(5e-324), 0)).toBe(true);
  });

  it('pins ulp-neighbors of +/-PI exactly (where the wrap direction is decided)', () => {
    // The four floats adjacent to +/-PI (all measured, deterministic):
    // shared's modulo chain collapses every one of them to exactly +PI;
    // bot stays on its side of the boundary. As ANGLES they are <= ~2 ulps
    // apart; as raw floats they can be 2PI apart (sign flip).
    const belowPi = 3.1415926535897927; // nextafter(PI, 0) — in range
    expect(botNormalizeAngle(belowPi)).toBe(belowPi); // passthrough
    expect(sharedNormalizeAngle(belowPi)).toBe(PI); // collapse to +PI

    const abovePi = 3.1415926535897936; // nextafter(PI, 4) — out of range
    expect(botNormalizeAngle(abovePi)).toBe(-belowPi); // wraps to one ulp above -PI
    expect(sharedNormalizeAngle(abovePi)).toBe(PI); // collapse to +PI

    const belowMinusPi = -3.1415926535897936; // nextafter(-PI, -4) — out of range
    expect(botNormalizeAngle(belowMinusPi)).toBe(belowPi); // wraps to one ulp below +PI
    expect(sharedNormalizeAngle(belowMinusPi)).toBe(PI); // collapse to +PI

    const aboveMinusPi = -3.1415926535897927; // nextafter(-PI, 0) — in range
    expect(botNormalizeAngle(aboveMinusPi)).toBe(aboveMinusPi); // passthrough
    expect(sharedNormalizeAngle(aboveMinusPi)).toBe(PI); // collapse to +PI
  });

  it('pins non-finite behavior: shared returns a deterministic safe 0; bot propagates NaN and HANGS on +/-Infinity', () => {
    // NaN — safe to call the uncapped replica: both loop comparisons are
    // false for NaN, so it exits immediately and returns NaN (garbage
    // propagation: NaN aim angles would poison downstream dx/dy/aim math).
    expect(Number.isNaN(botNormalizeAngle(NaN))).toBe(true);
    // Shared guard (ArcCalculation.ts:3): deterministic safe 0.
    expect(sharedNormalizeAngle(NaN)).toBe(0);

    // +/-Infinity — the uncapped replica must NOT be called: the loop never
    // terminates. Proven without hanging, in two steps:
    // (1) IEEE-754 identity: subtracting the finite 2PI leaves Infinity, so
    //     the loop body cannot make progress — non-termination is structural.
    expect(Infinity - TWO_PI).toBe(Infinity);
    expect(-Infinity + TWO_PI).toBe(-Infinity);
    // (2) The capped verbatim replica confirms the loop still has Infinity
    //     after 1e6 iterations (it would run forever).
    const pos = botNormalizeAngleCapped(Infinity, 1_000_000);
    expect(pos.hitCap).toBe(true);
    expect(pos.iterations).toBe(1_000_000);
    expect(pos.value).toBe(Infinity);
    const neg = botNormalizeAngleCapped(-Infinity, 1_000_000);
    expect(neg.hitCap).toBe(true);
    expect(neg.iterations).toBe(1_000_000);
    expect(neg.value).toBe(-Infinity);
    // Shared guard: deterministic safe 0 for both.
    expect(sharedNormalizeAngle(Infinity)).toBe(0);
    expect(sharedNormalizeAngle(-Infinity)).toBe(0);
  });

  it('characterizes large multiples: bot terminates with linearly-growing loop error; shared stays exact', () => {
    // The uncapped replica IS called for these finite magnitudes (it
    // terminates), but 1e7 is the ceiling: ~1.6M iterations (~2ms). Beyond it
    // the loop cost grows linearly (measured, NOT executed here: 1e9 needs
    // ~159M iterations / ~0.4s and its accumulated error is 2.46 rad — the
    // bot result is wrong by more than it is right; shared is exact).
    const cases: Array<{ magnitude: number; iterations: number; maxDiff: number }> = [
      { magnitude: 1e3, iterations: 159, maxDiff: 2.9e-12 }, // measured 2.31e-12
      { magnitude: 1e4, iterations: 1592, maxDiff: 1.1e-10 }, // measured 8.92e-11
      { magnitude: 1e5, iterations: 15915, maxDiff: 1.3e-8 }, // measured 1.05e-8
      { magnitude: 1e6, iterations: 159155, maxDiff: 1.7e-6 }, // measured 1.39e-6
      { magnitude: 1e7, iterations: 1591549, maxDiff: 1.9e-4 }, // measured 1.54e-4
    ];
    let prevDiff = 0;
    for (const { magnitude, iterations, maxDiff } of cases) {
      for (const a of [magnitude, -magnitude]) {
        const bot = botNormalizeAngle(a); // replica — finite, terminates
        const shared = sharedNormalizeAngle(a);
        const diff = Math.abs(bot - shared);
        // Error band: the loop error is deterministic, so a tight upper cap
        // plus a lower floor (>0) fails loud if EITHER implementation's
        // arithmetic changes in either direction.
        expect(diff, `|bot-shared| at a=${a}: ${diff.toExponential(3)}`).toBeGreaterThan(maxDiff / 3);
        expect(diff, `|bot-shared| at a=${a}: ${diff.toExponential(3)}`).toBeLessThanOrEqual(maxDiff);
        // Loop symmetry: bot(-a) === -bot(a) (the loop adds where it subtracts).
        expect(bot).toBe(-botNormalizeAngle(-a));
        // Both stay in range — the drift is positional error, not range escape.
        expect(bot).toBeGreaterThanOrEqual(-PI);
        expect(bot).toBeLessThanOrEqual(PI);
        expect(shared).toBeGreaterThanOrEqual(-PI);
        expect(shared).toBeLessThanOrEqual(PI);
      }
      // Iteration count from the verbatim capped replica (cap never hit —
      // asserted — so the count is the real loop's).
      const capped = botNormalizeAngleCapped(magnitude, iterations + 1000);
      expect(capped.hitCap).toBe(false);
      expect(capped.iterations).toBe(iterations);
      // The divergence class: error grows monotonically with magnitude.
      const diff = Math.abs(botNormalizeAngle(magnitude) - sharedNormalizeAngle(magnitude));
      expect(diff).toBeGreaterThan(prevDiff);
      prevDiff = diff;
    }
  });

  it('is deterministic (pure, no hidden state — safe to gate ticket 06 on)', () => {
    const probes = [0.3, -0.3, PI, -PI, PI + 0.5, -PI - 0.5, 12.345, -98.765, NaN];
    for (const a of probes) {
      const b1 = botNormalizeAngle(a);
      const b2 = botNormalizeAngle(a);
      const s1 = sharedNormalizeAngle(a);
      const s2 = sharedNormalizeAngle(a);
      expect(Object.is(b1, b2)).toBe(true);
      expect(Object.is(s1, s2)).toBe(true);
    }
  });
});
