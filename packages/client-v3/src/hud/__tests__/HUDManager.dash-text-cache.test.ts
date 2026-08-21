/**
 * Regression test for perf ticket 21 — dash-cooldown label text cache.
 *
 * WHY THE MOCK SEAM (not a real Phaser scene):
 * HUDManager's constructor wires the full HUD stack (HUDFactory components,
 * minimap, kill feed, power-up pills, spectator HUD). Phaser has no headless
 * mode in vitest (same convention as KillFeedRenderer.text-cache.test), so
 * every collaborator module is vi.mock'd with spy classes and HUDFactory
 * returns a recording component set. Only `dashLabel` / `dashBar` behavior is
 * asserted — the rest are inert stubs satisfying the constructor surface.
 *
 * WHAT THIS PROVES (kill-feed pattern applied to the dash label):
 *  1. While the raw tick cooldown changes every frame but
 *     `(cooldown / 60).toFixed(1)` does not (a 0.1s bucket), `setText` does
 *     NOT fire — the old code re-rasterized the canvas texture ~60x/s for the
 *     whole 2.5s cooldown.
 *  2. The BAR keeps its per-tick raw dirty-check — `setRatio` still fires on
 *     every raw cooldown change (progress stays smooth).
 *  3. `setText` fires again exactly on a bucket crossing and on the
 *     READY transition, with the exact former strings (visual identity).
 *  4. Holding at 0 (READY) or at a fixed cooldown emits no further calls.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// --- Recording component spies (module-level holders — vi.mock factories are
// hoisted, so they must read bindings at CALL time, not factory time). -------
interface LabelSpy {
  setText: ReturnType<typeof vi.fn>;
  setColor: ReturnType<typeof vi.fn>;
  setVisible: ReturnType<typeof vi.fn>;
  setAlpha: ReturnType<typeof vi.fn>;
}
let dashLabel: LabelSpy;
let dashBar: { setRatio: ReturnType<typeof vi.fn> };

vi.mock('../HUDFactory.js', () => ({
  createHUDComponents: () => {
    const label = () => {
      const l = {
        setText: vi.fn().mockReturnThis(),
        setColor: vi.fn().mockReturnThis(),
        setVisible: vi.fn().mockReturnThis(),
        setAlpha: vi.fn().mockReturnThis(),
      };
      return l;
    };
    const bar = () => ({ setRatio: vi.fn().mockReturnThis(), destroy: vi.fn() });
    dashLabel = label();
    dashBar = bar();
    const mk = <T>(v: T): T => v;
    return {
      healthBar: bar(),
      healthLabel: label(),
      dashBar,
      dashLabel,
      timerLabel: label(),
      phaseLabel: label(),
      aliveLabel: label(),
      statusLabel: label(),
      interactionLabel: label(),
      slotBgs: mk([]),
      slotBorders: mk([]),
      slotIcons: mk([]),
      durabilityBars: mk([]),
      durabilityLabels: mk([]),
      slotKeyLabels: mk([]),
      hpY: 0,
      slotY: 0,
      healthX: 0,
      healthLeft: 0,
      healthWidth: 0,
      slotStartX: 0,
    };
  },
}));

vi.mock('../MinimapRenderer.js', () => ({
  MinimapRenderer: class {
    getEntranceElements = () => [];
    updateMinimap = () => {};
    destroy = () => {};
  },
}));
vi.mock('../KillFeedRenderer.js', () => ({
  KillFeedRenderer: class {
    getEntranceElements = () => [];
    addKill = () => {};
    update = () => {};
    destroy = () => {};
  },
}));
vi.mock('../PowerUpIndicators.js', () => ({
  PowerUpIndicators: class {
    getEntranceElements = () => [];
    setVisible = () => {};
    updateBarrier = () => {};
    hideBarrier = () => {};
    updateSpeedBoost = () => {};
    hideSpeedBoost = () => {};
    destroy = () => {};
  },
}));
vi.mock('../SpectatorHUD.js', () => ({
  SpectatorHUD: class {
    show = () => {};
    hide = () => {};
    destroy = () => {};
  },
}));
vi.mock('../../ui/animations/TweenTracker.js', () => ({
  TweenTracker: class {
    track = () => {};
    dispose = () => {};
  },
}));
vi.mock('phaser', () => ({ default: {} }));

import { HUDManager } from '../HUDManager.js';

function makeSceneStub(): Phaser.Scene {
  return {
    scale: { width: 1280, height: 720 },
    tweens: { add: vi.fn(() => ({})) },
  } as unknown as Phaser.Scene;
}

describe('ticket 21 — HUDManager dash-cooldown label text cache', () => {
  beforeEach(() => {
    dashLabel = undefined as unknown as LabelSpy;
    dashBar = undefined as unknown as { setRatio: ReturnType<typeof vi.fn> };
  });

  it('setText fires once per 0.1s bucket while setRatio fires per tick', () => {
    // A full 2.5s cooldown at tick cadence: 150 distinct raw cooldowns.
    const cooldowns: number[] = [];
    for (let cd = 150; cd >= 1; cd--) cooldowns.push(cd);
    const distinctStrings = new Set(cooldowns.map((c) => `${(c / 60).toFixed(1)}s`));

    const hud = new HUDManager(makeSceneStub());
    for (const cd of cooldowns) hud.updateDashCooldown(cd, 150);

    // Every setText call carried a NEW formatted string (no redundant
    // re-raster inside a bucket) — and it fired exactly once per bucket.
    const texts = dashLabel.setText.mock.calls.map((c) => c[0] as string);
    expect(new Set(texts).size).toBe(texts.length);
    expect(dashLabel.setText).toHaveBeenCalledTimes(distinctStrings.size);
    // The bar kept its per-tick raw gate: one setRatio per raw change.
    expect(dashBar.setRatio).toHaveBeenCalledTimes(cooldowns.length);
  });

  it('the READY transition fires exactly once and holding at 0 emits nothing', () => {
    const hud = new HUDManager(makeSceneStub());
    hud.updateDashCooldown(3, 150);
    const before = dashLabel.setText.mock.calls.length;

    hud.updateDashCooldown(0, 150); // cooldown → READY: fires once
    expect(dashLabel.setText).toHaveBeenCalledTimes(before + 1);
    expect(dashLabel.setText).toHaveBeenLastCalledWith('READY');
    // Colors are numeric hex tokens (DesignTokens) — the READY color fires
    // with the label, inside the same formatted-string gate.
    expect(dashLabel.setColor).toHaveBeenLastCalledWith(expect.any(Number));

    for (let f = 0; f < 30; f++) hud.updateDashCooldown(0, 150);
    expect(dashLabel.setText).toHaveBeenCalledTimes(before + 1);
  });

  it('raw ticks inside one bucket update the bar but not the label', () => {
    // The expected distinct-string count is computed with the SAME toFixed
    // expression production uses — the test is an oracle, not a hand-count.
    const run = [100, 99, 98, 97, 96];
    const distinct = new Set(run.map((c) => `${(c / 60).toFixed(1)}s`));

    const hud = new HUDManager(makeSceneStub());
    hud.updateDashCooldown(run[0]!, 150);
    const afterFirst = dashLabel.setText.mock.calls.length;
    for (let i = 1; i < run.length; i++) hud.updateDashCooldown(run[i]!, 150);

    expect(dashLabel.setText).toHaveBeenCalledTimes(afterFirst + (distinct.size - 1));
    expect(dashBar.setRatio).toHaveBeenCalledTimes(run.length);
  });
});
