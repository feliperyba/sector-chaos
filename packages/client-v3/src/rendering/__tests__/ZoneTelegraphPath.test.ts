import { describe, it, expect } from 'vitest';
import { ZONE } from '@sector-battle/shared';
import { updateZoneRenderer } from '../ZoneTelegraph.js';
import type { ZoneRenderer } from '../ZoneRenderer.js';
import type { StateSync } from '../../network/StateSync.js';
import type { MapRenderer } from '../MapRenderer.js';

/**
 * Next-circle telegraph (target ring) — code-path verification for EVERY
 * phase 1..7 (map-redesign ticket 09 / DEC-008.3 / SPEC user story 40: "I
 * want to see the next circle target before I'm forced to move").
 *
 * The browser spot-check equivalent at the data layer: the per-frame render
 * entry (`updateZoneRenderer`, wired in GameScene.update) must hand
 * `ZoneRenderer.update` a complete target circle — center AND radius — at
 * every phase, for the entire phase (≥1 phase of warning before the
 * transition lands). The server publishes the phase's target at the
 * phase-advance tick (pinned server-side in ZoneServiceLandmarkBias.test.ts
 * + zone-seed-determinism.test.ts); this test pins the client render path
 * that consumes it: StateSync.getZoneState() → updateZoneRenderer →
 * ZoneRenderer target ring.
 *
 * No Phaser: `ZoneRenderer` is stubbed with a recorder (the stub asserts the
 * exact arguments the real renderer's targetCircle branch consumes — the
 * same three values `ZoneRenderer.update` shows the ring for).
 */

/** One recorded ZoneRenderer.update call. */
interface UpdateCall {
  cx: number;
  cy: number;
  radius: number;
  targetCx?: number;
  targetCy?: number;
  targetRadius?: number;
  isOutside: boolean;
  warningActive: boolean;
}

function makeRecordingZoneRenderer(calls: UpdateCall[]): ZoneRenderer {
  return {
    setWorldBounds: () => {},
    update: (
      cx: number,
      cy: number,
      radius: number,
      targetCx?: number,
      targetCy?: number,
      targetRadius?: number,
      isOutside = false,
      warningActive = false,
    ) => {
      calls.push({ cx, cy, radius, targetCx, targetCy, targetRadius, isOutside, warningActive });
    },
    renderSiegedSectors: () => {},
    clear: () => {},
  } as unknown as ZoneRenderer;
}

function makeStubStateSync(zoneState: Record<string, number | boolean>): StateSync {
  return { getZoneState: () => zoneState, getSiegedSectors: () => [] } as unknown as StateSync;
}

function makeStubMapRenderer(): MapRenderer {
  return {
    getMapWidth: () => 10240,
    getMapHeight: () => 10240,
    getGrid: () => [],
    getTileSize: () => 128,
  } as unknown as MapRenderer;
}

const LOCAL_POS = { x: 5120, y: 5120 };
const MAP_CENTER = 5120;
const FULL_RADIUS = 5120;

/**
 * The per-phase zone states the server publishes (StateSync.getZoneState
 * shape). Mirrors the real values: phase 1 targets the full-map circle at
 * map center; phases 2..6 target the seed-selected next circle from the
 * phase-advance tick onward; phase 7 (OT) freezes at the phase 6 target
 * (GDD §8.1.1). Radii follow the production ZONE.PHASES ratios.
 */
function zoneStatesByPhase(): Array<{ phase: number; state: Record<string, number | boolean> }> {
  const states: Array<{ phase: number; state: Record<string, number | boolean> }> = [];
  let centerX = MAP_CENTER;
  let centerY = MAP_CENTER;
  let targetRadius = FULL_RADIUS;
  for (const phaseConfig of ZONE.PHASES) {
    if (phaseConfig.index >= 2 && phaseConfig.index <= 6) {
      // The seed-selected target for this phase (offset values stand in for
      // the server's selection; any in-bounds non-center value exercises the
      // same render path).
      centerX = MAP_CENTER + 137 * phaseConfig.index;
      centerY = MAP_CENTER - 91 * phaseConfig.index;
      targetRadius = FULL_RADIUS * phaseConfig.radiusRatio;
    }
    const currentRadius = phaseConfig.index === 1 ? FULL_RADIUS : targetRadius;
    states.push({
      phase: phaseConfig.index,
      state: {
        centerX,
        centerY,
        currentRadius,
        targetCenterX: centerX,
        targetCenterY: centerY,
        targetRadius,
        // phaseEndTime far in the future: not about to shrink (the stable
        // period — the ring is visible WITHOUT the warning border).
        phaseEndTime: Date.now() + 60_000,
        isTransitioningCenter: false,
      },
    });
  }
  return states;
}

describe('next-circle telegraph render path (ticket 09 / DEC-008.3)', () => {
  it('hands ZoneRenderer a complete target circle at EVERY phase (1..7)', () => {
    const calls: UpdateCall[] = [];
    for (const { phase, state } of zoneStatesByPhase()) {
      updateZoneRenderer(
        makeRecordingZoneRenderer(calls),
        makeStubStateSync(state),
        makeStubMapRenderer(),
        LOCAL_POS,
      );
      const call = calls[calls.length - 1]!;
      // The target-ring branch of ZoneRenderer.update shows the ring iff all
      // three target values are provided — undefined hides it (alpha-0 ghost
      // guard). Every phase must provide them.
      expect(call.targetCx, `phase ${phase} targetCx`).toBeDefined();
      expect(call.targetCy, `phase ${phase} targetCy`).toBeDefined();
      expect(call.targetRadius, `phase ${phase} targetRadius`).toBeDefined();
      expect(call.targetRadius!, `phase ${phase} ring radius`).toBeGreaterThan(0);
      // Passthrough fidelity: the ring renders the server's exact telegraph.
      expect(call.targetCx).toBe(state.targetCenterX);
      expect(call.targetCy).toBe(state.targetCenterY);
      expect(call.targetRadius).toBe(state.targetRadius);
      // The current ring renders too.
      expect(call.radius).toBeGreaterThan(0);
    }
    expect(calls).toHaveLength(ZONE.PHASES.length);
  });

  it('phase 1 telegraphs the full-map circle at the map center', () => {
    const calls: UpdateCall[] = [];
    const phase1 = zoneStatesByPhase()[0]!;
    updateZoneRenderer(
      makeRecordingZoneRenderer(calls),
      makeStubStateSync(phase1.state),
      makeStubMapRenderer(),
      LOCAL_POS,
    );
    const call = calls[0]!;
    expect(call.targetCx).toBe(MAP_CENTER);
    expect(call.targetCy).toBe(MAP_CENTER);
    expect(call.targetRadius).toBe(FULL_RADIUS);
  });

  it('overtime (phase 7) keeps rendering the frozen phase 6 target circle', () => {
    const states = zoneStatesByPhase();
    const phase6 = states.find((s) => s.phase === 6)!;
    const phase7 = states.find((s) => s.phase === 7)!;
    // GDD §8.1.1: OT does not shift the center — the published target is the
    // phase 6 target verbatim.
    expect(phase7.state.targetCenterX).toBe(phase6.state.targetCenterX);
    expect(phase7.state.targetRadius).toBe(phase6.state.targetRadius);
    const calls: UpdateCall[] = [];
    updateZoneRenderer(
      makeRecordingZoneRenderer(calls),
      makeStubStateSync(phase7.state),
      makeStubMapRenderer(),
      LOCAL_POS,
    );
    expect(calls[0]!.targetRadius).toBeGreaterThan(0);
    expect(calls[0]!.targetCx).toBe(phase6.state.targetCenterX);
  });

  it('raises the warning overlay when the transition is imminent (≤10s)', () => {
    const states = zoneStatesByPhase();
    const shrinking = states.find((s) => s.phase === 4)!;
    const imminent: Record<string, number | boolean> = {
      ...shrinking.state,
      currentRadius: FULL_RADIUS, // still large → shrinking toward the target
      phaseEndTime: Date.now() + 5_000, // transition in 5s
    };
    const calls: UpdateCall[] = [];
    updateZoneRenderer(
      makeRecordingZoneRenderer(calls),
      makeStubStateSync(imminent),
      makeStubMapRenderer(),
      LOCAL_POS,
    );
    expect(calls[0]!.warningActive).toBe(true);
  });

  it('renders no warning overlay during the stable period (transition far away)', () => {
    const stable = zoneStatesByPhase().find((s) => s.phase === 4)!;
    const calls: UpdateCall[] = [];
    updateZoneRenderer(
      makeRecordingZoneRenderer(calls),
      makeStubStateSync(stable.state),
      makeStubMapRenderer(),
      LOCAL_POS,
    );
    expect(calls[0]!.warningActive).toBe(false);
  });
});
