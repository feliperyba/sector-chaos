/**
 * Regression test for perf ticket 21 — power-up pill text cache.
 *
 * WHY THE MOCK SEAM (not a real Phaser scene):
 * `PowerUpIndicators`' constructor builds real Phaser objects via
 * `scene.add.sprite` + `new Label` (which calls `scene.add.text`), and Phaser
 * has no lightweight headless mode in vitest (same convention as
 * KillFeedRenderer.text-cache.test). We mock only the `Label` component —
 * replacing it with a spy class whose `setText` / `setAlpha` calls we count —
 * and stub the scene's `sprite` / `tweens` / `time` seams.
 *
 * WHAT THIS PROVES (kill-feed pattern applied to the pills):
 *  1. While `remaining.toFixed(1)` formats to the SAME string across frames
 *     (a 0.1s bucket), `setText` does not fire — the old code re-rasterized
 *     the canvas texture ~60x/s for an unchanged string while a power-up was
 *     active.
 *  2. `setText` fires again exactly when the formatted string changes
 *     (bucket crossing) with the NEW string — visual identity preserved.
 *  3. The expiry blink alpha is NOT cached — `setAlpha` still updates every
 *     frame under the 3s warning threshold.
 *  4. hide → re-show with an unchanged string skips the redundant re-raster
 *     (Phaser Text retains its string across visibility).
 *  5. The barrier and speed pills cache independently.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

interface LabelSpy {
  setText: ReturnType<typeof vi.fn>;
  setAlpha: ReturnType<typeof vi.fn>;
  setVisible: ReturnType<typeof vi.fn>;
}

let labelInstances: LabelSpy[];

vi.mock('../../ui/components/Label.js', () => ({
  Label: class {
    setText = vi.fn((_text: string) => undefined);
    setAlpha = vi.fn().mockReturnThis();
    setVisible = vi.fn().mockReturnThis();
    setDepth = vi.fn().mockReturnThis();
    setScrollFactor = vi.fn().mockReturnThis();
    setOrigin = vi.fn().mockReturnThis();
    getAt = vi.fn(() => ({ setOrigin: vi.fn().mockReturnThis() }));
    destroy = vi.fn();
    constructor() {
      labelInstances.push(this as unknown as LabelSpy);
    }
  },
}));

vi.mock('phaser', () => ({ default: {} }));

import { PowerUpIndicators } from '../PowerUpIndicators.js';

function makeIconStub() {
  return {
    setDisplaySize: vi.fn().mockReturnThis(),
    setTint: vi.fn().mockReturnThis(),
    setDepth: vi.fn().mockReturnThis(),
    setScrollFactor: vi.fn().mockReturnThis(),
    setVisible: vi.fn().mockReturnThis(),
    setAlpha: vi.fn().mockReturnThis(),
    setScale: vi.fn().mockReturnThis(),
    destroy: vi.fn(),
  };
}

function makeSceneStub(): Phaser.Scene {
  return {
    add: { sprite: vi.fn(() => makeIconStub()) },
    tweens: {
      add: vi.fn(() => ({})),
      killTweensOf: vi.fn(),
    },
    time: { delayedCall: vi.fn((_ms: number, cb: () => void) => ({ cb })) },
  } as unknown as Phaser.Scene;
}

describe('ticket 21 — PowerUpIndicators pill text cache', () => {
  beforeEach(() => {
    labelInstances = [];
  });

  it('setText does not fire while the formatted string is unchanged across frames', () => {
    const pills = new PowerUpIndicators(makeSceneStub(), 0, 0, 8);
    // labelInstances[0] = barrier pill (create order: barrier, then speed).
    const barrier = labelInstances[0]!;

    // 10 frames inside the same 0.1s bucket (10.00 → 10.04 all "10.0").
    for (let f = 0; f < 10; f++) pills.updateBarrier(10 + f * 0.004, 10);

    expect(barrier.setText).toHaveBeenCalledTimes(1);
    expect(barrier.setText).toHaveBeenCalledWith('10.0s');
  });

  it('setText fires again exactly when the formatted string changes', () => {
    const pills = new PowerUpIndicators(makeSceneStub(), 0, 0, 8);
    const barrier = labelInstances[0]!;

    pills.updateBarrier(10.0, 10); // "10.0s"
    pills.updateBarrier(9.96, 10); // still "10.0s" — no re-raster
    pills.updateBarrier(9.94, 10); // "9.9s" — bucket crossing fires
    pills.updateBarrier(9.9, 10); // "9.9s" — cached again

    expect(barrier.setText).toHaveBeenCalledTimes(2);
    expect(barrier.setText).toHaveBeenLastCalledWith('9.9s');
  });

  it('the expiry blink alpha still updates every frame (not cached)', () => {
    const pills = new PowerUpIndicators(makeSceneStub(), 0, 0, 8);
    const barrier = labelInstances[0]!;
    // First update runs showPill's entrance setAlpha(0); ignore it.
    pills.updateBarrier(2.6, 10);
    for (const label of labelInstances) label.setAlpha.mockClear();

    // Under EXPIRY_WARN_SECONDS (3): blink drives alpha every update.
    for (let f = 1; f <= 10; f++) pills.updateBarrier(2.5, 10);
    expect(barrier.setAlpha).toHaveBeenCalledTimes(10);
  });

  it('hide → re-show with an unchanged string skips the redundant setText', () => {
    const pills = new PowerUpIndicators(makeSceneStub(), 0, 0, 8);
    const barrier = labelInstances[0]!;

    pills.updateBarrier(7.2, 10); // "7.2s"
    pills.hideBarrier();
    // Re-activate at the exact same remaining value: the label object still
    // holds "7.2s", so the old code paid a full re-raster for a no-op.
    pills.updateBarrier(7.2, 10);

    expect(barrier.setText).toHaveBeenCalledTimes(1);
  });

  it('barrier and speed pills cache independently', () => {
    const pills = new PowerUpIndicators(makeSceneStub(), 0, 0, 8);
    const barrier = labelInstances[0]!;
    const speed = labelInstances[1]!;

    pills.updateBarrier(5.0, 10); // "5.0s"
    pills.updateSpeedBoost(5.0, 10); // "5.0s" — own pill, own cache

    expect(barrier.setText).toHaveBeenCalledTimes(1);
    expect(speed.setText).toHaveBeenCalledTimes(1);
    expect(speed.setText).toHaveBeenCalledWith('5.0s');
  });
});
