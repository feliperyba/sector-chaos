// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { SIM_TICK_DT, PLAYER, COMBAT } from '@sector-battle/shared';
import { computeSnapThreshold } from '../../types.js';
import {
  runDifferentialScenario,
  makeOpenGrid,
  makeOpenGridRect,
  setWalls,
  PRODUCTION_MAX_SPEED,
  type ScenarioResult,
} from './physics-divergence-harness.js';

/**
 * PHYSICS-DIVERGENCE REPRO (TASK-01) — the differential harness that the
 * matched-physics transition-drift-repro harness structurally CANNOT be.
 *
 * Each scenario drives the REAL server `MovementService.validateAndMove` (+ the
 * real GameSimulation movement pipeline) against the REAL client
 * `PredictionService` on an identical input stream, then reports:
 *   - peak raw per-tick |serverPos − clientLocalPos|
 *   - correction-fires-count (patches where the REAL Reconciler snapped)
 *   - peak genuine posError (after rewind-replay)
 *   - final divergence
 *
 * The failure signal for a DIVERGENT scenario is correctionFires > 0 OR
 * peakGenuinePosError >= snapThreshold. A scenario that shows 0 corrections is
 * CONFIRMED NOT to diverge through this physics seam — recorded as evidence.
 *
 * Numbers are logged for the findings report. Assertions are characterization
 * (determinism + timing + the structural findings), not pass/fail on a single
 * magic value — the measured numbers ARE the deliverable.
 */

const TILE = 128;
const HALF = PLAYER.HITBOX_WIDTH / 2; // 48
const DASH_TICKS = PLAYER.DASH_DURATION_TICKS; // 30

/** Snap a scenario's headline metrics for the report. */
function headline(label: string, r: ScenarioResult): string {
  return `[${label}] peak=${r.peakPosError.toFixed(2)}px@t${r.peakPosErrorTick} corr=${r.correctionFires} genuine=${r.peakGenuinePosError.toFixed(2)}px rawPatch=${r.peakRawPatchError.toFixed(2)}px final=${r.finalDivergence.toFixed(2)}px steady=${r.steadyStateDivergence.toFixed(2)}px@t${r.steadyStateTick} thr=${r.snapThreshold.toFixed(1)} ticks=${r.totalTicks}`;
}

// ════════════════════════════════════════════════════════════════════════════
// PHASE 2 — REPRODUCE: the 10 mandated scenarios.
// ════════════════════════════════════════════════════════════════════════════

describe('physics-divergence-repro — 10 scenarios', () => {
  // 1. Sustained walk, open field, localhost.
  it('1. sustained walk open field localhost — constant +X, ~0 latency', async () => {
    const r = await runDifferentialScenario({
      grid: makeOpenGrid(20),
      tileSize: TILE,
      spawn: { x: 1280, y: 1280 },
      durationSec: 1.0,
      latencySec: 0,
      directionAt: () => ({ dx: 1, dy: 0 }),
    });
    console.log(headline('1.open-walk-localhost', r));
    // No divergence expected: validateAndMove ≡ simulatePhysicsStepInto for walk.
    expect(r.correctionFires).toBe(0);
    expect(r.peakGenuinePosError).toBeLessThan(0.5);
  });

  // 2. Sustained walk, open field, 150ms RTT.
  it('2. sustained walk open field 150ms RTT — constant +X', async () => {
    const r = await runDifferentialScenario({
      grid: makeOpenGrid(20),
      tileSize: TILE,
      spawn: { x: 1280, y: 1280 },
      durationSec: 1.2,
      latencySec: 0.075,
      directionAt: () => ({ dx: 1, dy: 0 }),
    });
    console.log(headline('2.open-walk-150ms', r));
    // Reconciler absorbs the latency lag via rewind-replay → 0 genuine corrections.
    expect(r.correctionFires).toBe(0);
    expect(r.peakGenuinePosError).toBeLessThan(0.5);
  });

  // 2b. Sustained walk @ 30fps (renderDt = 2× SIM_TICK_DT) — the user reports
  // the stutter reproduces at 30fps too. Characterize the cadence interaction.
  it('2b. sustained walk open field 150ms RTT @ 30fps render rate', async () => {
    const r = await runDifferentialScenario({
      grid: makeOpenGrid(20),
      tileSize: TILE,
      spawn: { x: 1280, y: 1280 },
      durationSec: 1.2,
      latencySec: 0.075,
      renderDt: 1 / 30,
      directionAt: () => ({ dx: 1, dy: 0 }),
    });
    console.log(headline('2b.open-walk-150ms-30fps', r));
    expect(r.correctionFires).toBe(0);
  });

  // 2c. Sustained walk @ 165Hz (user's desktop refresh).
  it('2c. sustained walk open field 150ms RTT @ 165Hz render rate', async () => {
    const r = await runDifferentialScenario({
      grid: makeOpenGrid(20),
      tileSize: TILE,
      spawn: { x: 1280, y: 1280 },
      durationSec: 1.2,
      latencySec: 0.075,
      renderDt: 1 / 165,
      directionAt: () => ({ dx: 1, dy: 0 }),
    });
    console.log(headline('2c.open-walk-150ms-165Hz', r));
    expect(r.correctionFires).toBe(0);
  });

  // 3. Walk INTO a wall and hold — settle against a solid tile.
  it('3. walk into wall and hold — settle against INDESTRUCTIBLE_WALL', async () => {
    // Spawn 2 tiles left of a wall column. Wall at gridX=10 (x∈[1280,1408]).
    // Spawn center (1056, 1280) [tile (8,10) center]. +X walks into the wall.
    const grid = makeOpenGrid(20);
    setWalls(grid, [
      [10, 9],
      [10, 10],
      [10, 11],
    ]);
    const r = await runDifferentialScenario({
      grid,
      tileSize: TILE,
      spawn: { x: 1056, y: 1280 },
      durationSec: 1.2,
      latencySec: 0,
      directionAt: () => ({ dx: 1, dy: 0 }),
    });
    console.log(headline('3.walk-into-wall', r));
    // Server + client use the same MTV tile algorithm → expect ~0 divergence.
    expect(r.correctionFires).toBe(0);
  });

  // 4. Slide along a wall — shallow angle into a wall.
  it('4. slide along wall — shallow angle into wall (slide in Y)', async () => {
    // Wall to the +X side; input dx=1, dy=0.5 → X clamped, Y slides.
    const grid = makeOpenGrid(20);
    setWalls(grid, [
      [10, 9],
      [10, 10],
      [10, 11],
      [10, 12],
    ]);
    const r = await runDifferentialScenario({
      grid,
      tileSize: TILE,
      spawn: { x: 1152, y: 768 },
      durationSec: 1.2,
      latencySec: 0,
      directionAt: () => ({ dx: 1, dy: 0.5 }),
    });
    console.log(headline('4.slide-along-wall', r));
    expect(r.correctionFires).toBe(0);
  });

  // 5. Acceleration ramp from standstill — release→hold (capture accel overshoot).
  it('5. acceleration ramp from standstill — 0→+X hold', async () => {
    const r = await runDifferentialScenario({
      grid: makeOpenGrid(20),
      tileSize: TILE,
      spawn: { x: 1280, y: 1280 },
      durationSec: 0.6,
      latencySec: 0,
      directionAt: () => ({ dx: 1, dy: 0 }),
    });
    console.log(headline('5.accel-ramp', r));
    // The ramp is where maxDistance rejection would bite IF the cap were 430.
    // Production cap is 1290 → no rejection → 0 divergence.
    expect(r.correctionFires).toBe(0);
    expect(r.peakGenuinePosError).toBeLessThan(0.5);
  });

  // 6. Dash in open field (edge-triggered DASH, full duration).
  it('6. dash open field localhost — DASH edge, full duration', async () => {
    const r = await runDifferentialScenario({
      grid: makeOpenGrid(30),
      tileSize: TILE,
      spawn: { x: 1280, y: 1280 },
      durationSec: 1.5,
      latencySec: 0,
      directionAt: () => ({ dx: 1, dy: 0 }),
      // Single DASH edge ~5 frames in (after a brief walk to build velocity).
      dashEdgeAt: (_t, frameIndex) => frameIndex === 5,
    });
    console.log(headline('6.dash-open', r));
    console.log(
      `[6.dash-open] serverEnd.x=${r.serverEnd.x.toFixed(1)} clientEnd.x=${r.clientEnd.x.toFixed(1)} dashTicks=${DASH_TICKS}`,
    );
    // NET-21 FIXED: the client now mirrors the server's MOVE-before-DASH
    // within-tick order (the dash-arrival step moves at walk speed; dash-speed
    // movement begins on the next step) and the step8 dash-end tick alignment
    // (velocity zeroes on the step where the dash has powered
    // DASH_DURATION_TICKS dash-speed steps). Pre-fix this scenario fired ~7
    // corrections / ~20.67px genuine (snapped at the 16px localhost threshold);
    // post-fix it must hold 0 corrections / <16px genuine across the dash window.
    expect(r.correctionFires).toBe(0);
    expect(r.peakGenuinePosError).toBeLessThan(16);
  });

  // 7. Dash into a wall.
  it('7. dash into wall — DASH toward INDESTRUCTIBLE_WALL', async () => {
    const grid = makeOpenGrid(30);
    setWalls(grid, [
      [14, 9],
      [14, 10],
      [14, 11],
    ]);
    const r = await runDifferentialScenario({
      grid,
      tileSize: TILE,
      spawn: { x: 1280, y: 1280 },
      durationSec: 1.5,
      latencySec: 0,
      directionAt: () => ({ dx: 1, dy: 0 }),
      dashEdgeAt: (_t, frameIndex) => frameIndex === 5,
    });
    console.log(headline('7.dash-into-wall', r));
    // NET-21 FIXED: same dash tick-alignment parity as scenario 6, but into a
    // wall (dash velocity clamped by the shared MTV collision path — unchanged
    // by NET-21). Pre-fix ~6 corrections / ~20.50px genuine; post-fix 0 / <16px.
    expect(r.correctionFires).toBe(0);
    expect(r.peakGenuinePosError).toBeLessThan(16);
  });

  // 8. Speed power-up pickup mid-walk — mySpeed changes between patches.
  it('8. speed powerup mid-walk — server speed ×1.5, client lags 1 patch', async () => {
    // Server walk speed jumps to 1.5× at tick 20; the client sees the new speed
    // only when the patch carrying it arrives (1-patch + latency stale).
    const boosted = PLAYER.BASE_SPEED * 1.5;
    const r = await runDifferentialScenario({
      grid: makeOpenGrid(30),
      tileSize: TILE,
      spawn: { x: 1280, y: 1280 },
      durationSec: 1.5,
      latencySec: 0.075,
      directionAt: () => ({ dx: 1, dy: 0 }),
      serverSpeedAt: (tick) => (tick >= 20 ? boosted : PLAYER.BASE_SPEED),
    });
    console.log(headline('8.speed-powerup', r));
    console.log(`[8.speed-powerup] boosted=${boosted} base=${PLAYER.BASE_SPEED}`);
    // NET-23 FIXED: the replay now integrates the unacked window with the
    // SERVER-AUTHORITATIVE speed (the patch's `speed` at the acked tick), not
    // each record's stale rec.speed. So the rewind-replay reconstructs the
    // SERVER's boosted trajectory, the genuine error reveals the true desync,
    // and the threshold gate fires a CLEAN correction at the speed-change
    // boundary that snaps the client onto the server's boosted trajectory.
    //
    // Pre-fix: the stale rec.speed replay masked the desync → corr=0, the
    // client under-predicted through the whole staleness window, and a
    // PERSISTENT ~35.83px offset remained for the rest of the match (never
    // converged, never corrected). Post-fix: the offset CONVERGES — the
    // steady-state GENUINE error (what the gate sees) drops back under the
    // snap threshold after the boundary correction, proving the desync is no
    // longer masked.
    // (a) the offset converges to < computeSnapThreshold(rtt) within a bounded
    // number of patches AND no visible snap is introduced (correctionOffset
    // smooths the snap into a ~100ms glide).
    expect(r.steadyStateGenuinePosError).toBeLessThan(r.snapThreshold);
    // Corrections are bounded + one-time (the speed-change boundary transient),
    // NOT continuous — a handful of clean convergence snaps, then steady-state
    // holds 0 corrections.
    expect(r.correctionFires).toBeLessThanOrEqual(3);
    // The correction at the boundary reveals the true desync (the masking is
    // gone) — peak genuine error is now proportional to the speed delta × the
    // staleness window, instead of being hidden at ~0.
    expect(r.peakGenuinePosError).toBeGreaterThan(1);
  });

  // 9. Stagger applied mid-walk — isStaggered toggles between patches.
  it('9. stagger mid-walk — server staggered at tick 20, client lags 1 patch', async () => {
    const r = await runDifferentialScenario({
      grid: makeOpenGrid(30),
      tileSize: TILE,
      spawn: { x: 1280, y: 1280 },
      durationSec: 1.5,
      latencySec: 0.075,
      directionAt: () => ({ dx: 1, dy: 0 }),
      serverStaggeredAt: (tick) => tick >= 20 && tick <= 50,
    });
    console.log(headline('9.stagger', r));
    console.log(`[9.stagger] staggerPenalty=${COMBAT.STAGGER_MOVE_SPEED_PENALTY}`);
    // NET-23 FIXED: the replay now seeds isStaggered from the patch's status
    // flag (previously hardcoded false), so STAGGER_MOVE_SPEED_PENALTY is
    // applied to the replay's effective speed for the whole window. The
    // stagger's transient desync (the client walked at full speed through the
    // staleness window while the server was slowed) is now revealed + corrected
    // at the stagger boundary, and because stagger is TRANSIENT (ends at t50),
    // the offset fully self-heals — final divergence converges to ~0.
    // Pre-fix: ~50.17px transient that self-healed only when stagger ended
    // (corr=0 throughout, the desync invisible to the gate).
    expect(r.steadyStateGenuinePosError).toBeLessThan(r.snapThreshold);
    expect(r.correctionFires).toBeLessThanOrEqual(3);
    expect(r.peakGenuinePosError).toBeGreaterThan(1);
  });

  // 10. Corner nesting — walk into a tile corner (4-corner hitbox vs AABB).
  it('10. corner nesting — walk diagonally into a wall corner', async () => {
    // Two walls forming an inner corner the player walks diagonally into.
    const grid = makeOpenGrid(20);
    setWalls(grid, [
      [11, 10],
      [10, 11],
    ]);
    const r = await runDifferentialScenario({
      grid,
      tileSize: TILE,
      spawn: { x: 1088, y: 1088 },
      durationSec: 1.2,
      latencySec: 0,
      directionAt: () => ({ dx: 1, dy: 1 }), // diagonal into the corner
    });
    console.log(headline('10.corner-nesting', r));
    expect(r.correctionFires).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// PHASE 3 — HYPOTHESES (ranked, falsifiable). One variable changed per probe.
// ════════════════════════════════════════════════════════════════════════════

describe('physics-divergence-repro — 5 hypotheses (confirm/eliminate)', () => {
  // The dash scenario is the divergence carrier. Reuse its shape for the
  // maxDistance and dash-end probes (the ones predicted to affect dash).
  const dashOpts = {
    grid: makeOpenGrid(30),
    tileSize: TILE,
    spawn: { x: 1280, y: 1280 } as { x: number; y: number },
    durationSec: 1.5,
    latencySec: 0,
    directionAt: () => ({ dx: 1, dy: 0 }),
    dashEdgeAt: (_t: number, frameIndex: number) => frameIndex === 5,
  };

  // H1 — maxDistance rejection: would fire if maxSpeed were BASE_SPEED (430).
  // Production uses 1290 → never fires. Probe: set maxSpeedOverride=430 and
  // confirm dash now REJECTS moves (divergence explodes) → proves the gate is
  // what protects production, and that it's correctly sized at 1290.
  it('H1. maxDistance gate — maxSpeed=430 (test cfg) explodes dash divergence; production 1290 holds', async () => {
    const rProd = await runDifferentialScenario({ ...dashOpts });
    const rTest = await runDifferentialScenario({
      ...dashOpts,
      maxSpeedOverride: PLAYER.BASE_SPEED, // 430 — the test-suite config
    });
    console.log(`[H1.maxDistance] prod(1290): corr=${rProd.correctionFires} genuine=${rProd.peakGenuinePosError.toFixed(2)} | test(430): corr=${rTest.correctionFires} genuine=${rTest.peakGenuinePosError.toFixed(2)} peakRaw=${rTest.peakRawPatchError.toFixed(1)}`);
    console.log(`[H1.maxDistance] PRODUCTION_MAX_SPEED=${PRODUCTION_MAX_SPEED} (= base*mult*1.5)`);
    // The 430 cap rejects dash moves (dash v=860 > maxDist=430/60*1.1=7.88) →
    // the server FREEZES during dash while the client advances → huge divergence.
    expect(rTest.peakGenuinePosError).toBeGreaterThan(rProd.peakGenuinePosError);
  });

  // H2 — tile-collision algorithm mismatch: predicted wall divergence only.
  // Both paths use the same MTV algorithm in non-enriched mode (verified by
  // reading resolveSimple vs ClientCollisionService). The wall scenarios (3/4/10)
  // already show 0 corrections → collision is NOT the cause. This test pins it.
  it('H2. tile-collision — wall scenarios show 0 corrections (algorithms match)', async () => {
    const grid = makeOpenGrid(20);
    setWalls(grid, [
      [10, 9],
      [10, 10],
      [10, 11],
    ]);
    const r = await runDifferentialScenario({
      grid,
      tileSize: TILE,
      spawn: { x: 1056, y: 1280 },
      durationSec: 1.2,
      latencySec: 0.075,
      directionAt: () => ({ dx: 1, dy: 0 }),
    });
    console.log(`[H2.tile-collision] walk-into-wall 150msRTT: corr=${r.correctionFires} genuine=${r.peakGenuinePosError.toFixed(2)}`);
    expect(r.correctionFires).toBe(0);
  });

  // H3 — bounds clamp cross-axis: PRIOR to NET-22, ClientCollisionService.
  // clampBounds clamped BOTH X and Y against mapWidth AND mapHeight. Latent on
  // the SQUARE production map (mapWidth===mapHeight=10240). Probed with a WIDE
  // non-square map (rows < cols → mapHeight < mapWidth): walking +X, the client
  // clamped X to mapHeight-size (wrong, tighter) instead of mapWidth-size →
  // 312px genuine divergence / 42 correction fires.
  //
  // NET-22 FIX (ADR-0014 addendum): clampBounds now clamps each axis against
  // its OWN extent (X vs maxCols*tileSize, Y vs maxRows*tileSize), matching the
  // server's per-axis MovementService.clampValue. The probe is repurposed as a
  // REGRESSION GATE pinning the fixed 0-correction / 0-genuine bar on the
  // non-square map (and remains a no-op guarantee on the square production map
  // where mapWidth===mapHeight).
  it('H3. bounds clamp cross-axis — 0 corrections on wide non-square maps (NET-22 fixed)', async () => {
    // cols=20 (mapWidth=2560), rows=12 (mapHeight=1536). Spawn at x=1300, +X.
    // Server clamps X → mapWidth-48 = 2512. Client (post-NET-22) clamps X →
    // mapWidth-48 = 2512 too. Pre-fix the client clamped X → min(mapWidth,
    // mapHeight)-48 = 1536-48 = 1488 → player stopped ~1024px short.
    const grid = makeOpenGridRect(20, 12);
    const mapWidth = 20 * TILE; // 2560
    const mapHeight = 12 * TILE; // 1536
    const r = await runDifferentialScenario({
      grid,
      tileSize: TILE,
      spawn: { x: 1300, y: 700 },
      durationSec: 1.2,
      latencySec: 0,
      directionAt: () => ({ dx: 1, dy: 0 }),
    });
    console.log(`[H3.bounds-clamp] wide non-square(20x12) +X: corr=${r.correctionFires} genuine=${r.peakGenuinePosError.toFixed(1)} serverEnd.x=${r.serverEnd.x.toFixed(0)} clientEnd.x=${r.clientEnd.x.toFixed(0)} | mapWidth=${mapWidth} mapHeight=${mapHeight}`);
    console.log(`[H3.bounds-clamp] production map SQUARE (80x80, mapWidth===mapHeight=10240) → fix is a no-op there`);
    // NET-22: each axis clamps against its own extent → client matches server
    // exactly on the non-square map. Pre-fix: corr=42 genuine=312px.
    expect(r.correctionFires).toBe(0);
    expect(r.peakGenuinePosError).toBeLessThan(0.5);
  });

  // H4 — dash-end handling: divergence USED TO appear only in dash scenarios
  // (6/7), concentrated around the dash start/end. NET-21 brought the dash
  // lifecycle onto the parity surface; this probe now pins the post-fix bar:
  // 0 corrections and genuine < snapThreshold at every tick (the divergence is
  // absorbed by the correction model without a snap). The per-tick band is
  // still logged for characterization (any residual >1px ticks must stay under
  // the snap threshold so the gate does not fire).
  it('H4. dash-end — 0 corrections, genuine < threshold across the dash window (NET-21 fixed)', async () => {
    const r = await runDifferentialScenario({ ...dashOpts });
    // Find the tick-band where per-tick error > 1px (the residual divergence
    // window — expected to be at most a single start-tick + end-tick transient).
    const band: number[] = [];
    for (let i = 0; i < r.perTickPosError.length; i++) {
      if (r.perTickPosError[i]! > 1) band.push(i + 1);
    }
    const bandStr = band.length
      ? `${band[0]}..${band[band.length - 1]} (${band.length} ticks)`
      : 'none';
    console.log(`[H4.dash-end] divergence band=ticks ${bandStr} | peak=${r.peakPosError.toFixed(2)}@t${r.peakPosErrorTick} | dashStart~t6 dashEnd~t${6 + DASH_TICKS}`);
    // NET-21: the dash window is absorbed without a snap — 0 corrections and
    // genuine error below the snap threshold at every tick.
    expect(r.correctionFires).toBe(0);
    expect(r.peakGenuinePosError).toBeLessThan(r.snapThreshold);
    // Any residual >1px per-tick error must stay under the snap threshold so
    // the correction gate never fires (provably absorbed, no snap).
    expect(r.peakPosError).toBeLessThan(r.snapThreshold);
  });

  // H5 — speed/stagger staleness: divergence tracks the patch boundary at which
  // the client's mySpeed/isStaggered lags the server. Scenarios 8/9 establish
  // the magnitude; this confirms it scales with the speed delta. NET-23 split:
  // a SMALL speed delta (+10%) stays under the snap threshold → tolerated (0
  // corrections, no visible snap); a LARGE delta (+100%) crosses it → the
  // unmasked replay fires a clean correction that converges the position.
  it('H5. speed staleness — divergence scales with the speed delta', async () => {
    const base = PLAYER.BASE_SPEED;
    const small = await runDifferentialScenario({
      grid: makeOpenGrid(30),
      tileSize: TILE,
      spawn: { x: 1280, y: 1280 },
      durationSec: 1.5,
      latencySec: 0.075,
      directionAt: () => ({ dx: 1, dy: 0 }),
      serverSpeedAt: (tick) => (tick >= 20 ? base * 1.1 : base),
    });
    const large = await runDifferentialScenario({
      grid: makeOpenGrid(30),
      tileSize: TILE,
      spawn: { x: 1280, y: 1280 },
      durationSec: 1.5,
      latencySec: 0.075,
      directionAt: () => ({ dx: 1, dy: 0 }),
      serverSpeedAt: (tick) => (tick >= 20 ? base * 2.0 : base),
    });
    console.log(`[H5.speed-staleness] +10%% speed: genuine=${small.peakGenuinePosError.toFixed(2)} corr=${small.correctionFires} steadyGen=${small.steadyStateGenuinePosError.toFixed(2)} | +100%% speed: genuine=${large.peakGenuinePosError.toFixed(2)} corr=${large.correctionFires} steadyGen=${large.steadyStateGenuinePosError.toFixed(2)}`);
    // Divergence still scales with the speed delta (the underlying signal H5
    // confirmed is unchanged): the +100% genuine error exceeds the +10% one.
    expect(large.peakGenuinePosError).toBeGreaterThan(small.peakGenuinePosError);
    // NET-23: BOTH cases now converge in the steady state (the replay no longer
    // masks the desync — steady-state genuine error drops back under threshold
    // after the boundary transient). The +10% case TOLERATES (stays under
    // threshold → 0 corrections, no snap); the +100% case ELIMINATES via a
    // clean correction.
    expect(small.steadyStateGenuinePosError).toBeLessThan(small.snapThreshold);
    expect(large.steadyStateGenuinePosError).toBeLessThan(large.snapThreshold);
    // The +100% case crosses the threshold intentionally with a clean correction
    // (no longer masked → the gate fires + converges). The +10% case stays
    // below threshold (tolerated residual, no correction).
    expect(large.correctionFires).toBeGreaterThanOrEqual(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// HARNESS QUALITIES — determinism + ≤2s timing (diagnose Phase 1 "iterate").
// ════════════════════════════════════════════════════════════════════════════

describe('physics-divergence-repro — harness qualities', () => {
  it('DETERMINISTIC: same scenario run twice → identical per-tick series', async () => {
    const opts = {
      grid: makeOpenGrid(20),
      tileSize: TILE,
      spawn: { x: 1280, y: 1280 } as { x: number; y: number },
      durationSec: 0.8,
      latencySec: 0.075,
      directionAt: () => ({ dx: 1, dy: 0 }),
      dashEdgeAt: (_t: number, i: number) => i === 5,
    };
    const a = await runDifferentialScenario(opts);
    const b = await runDifferentialScenario(opts);
    expect(b.peakPosError).toBe(a.peakPosError);
    expect(b.correctionFires).toBe(a.correctionFires);
    expect(b.perTickPosError).toEqual(a.perTickPosError);
  });

  it('FAST: full 10-scenario matrix reference (single representative, <500ms)', async () => {
    const start = performance.now();
    await runDifferentialScenario({
      grid: makeOpenGrid(20),
      tileSize: TILE,
      spawn: { x: 1280, y: 1280 },
      durationSec: 1.5,
      latencySec: 0.075,
      directionAt: () => ({ dx: 1, dy: 0 }),
      dashEdgeAt: (_t, i) => i === 5,
    });
    const elapsed = performance.now() - start;
    console.log(`[FAST] single representative scenario: ${elapsed.toFixed(0)}ms (matrix of ~15 < 2s)`);
    expect(elapsed).toBeLessThan(500);
  });

  it('computeSnapThreshold sanity — 0ms=16, 150ms=28, 600ms+=64', () => {
    expect(computeSnapThreshold(0)).toBe(16);
    expect(computeSnapThreshold(150)).toBe(28);
    expect(computeSnapThreshold(600)).toBe(64);
  });
});

// Re-export SIM_TICK_DT for the report's reference to the determinism anchor.
void SIM_TICK_DT;
