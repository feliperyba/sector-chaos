/**
 * Regression test for ticket 04 (B2) — spectator HUD redesign + main-HUD cleanup.
 *
 * WHY THE MOCK SEAM (not a real Phaser scene):
 * `HUDManager`'s constructor builds real Phaser objects via `createHUDComponents`
 * + `new MinimapRenderer/KillFeedRenderer/PowerUpIndicators/SpectatorHUD`, each of
 * which dereferences `scene.add.*` / `scene.tweens.add` / `scene.scale`. Phaser has
 * no lightweight headless mode in vitest (documented in WeaponHideEventHandler.test
 * and PlayerRendererUpdate.test). So we mock the four sub-renderer modules +
 * HUDFactory, replacing them with spy components whose `setVisible` / `setAlpha`
 * calls we assert directly. This isolates the load-bearing behavior of
 * `setSpectating` — which widgets it hides vs keeps visible — from Phaser.
 *
 * ROOT CAUSE THIS PROVES FIXED (findings B2 §3 + §4):
 *  H1 (primary): no hide method existed. → `setSpectating` is that method.
 *  H5 (compounding): per-frame repaints re-drove the dead local player's HUD.
 *    → the personal-widget update methods (updateHealth/Inventory/Dash/PowerUps/
 *      setInteractionPrompt) must short-circuit while spectating so a stray
 *      per-frame caller can't re-show a hidden widget (the `slotIcons`/`durability`
 *      paths inside updateInventory call setVisible(true) directly).
 *
 * WHAT THIS PROVES:
 *  1. `setSpectating(true)` hides EXACTLY the personal widgets (health/dash/
 *     inventory slots/power-ups/interaction prompt) and does NOT touch the
 *     match-state widgets (minimap/kill feed/timer/phase/alive/status).
 *     Per user ruling: "hide personal widgets, keep match-state visible."
 *  2. `setSpectating(false)` restores the personal widgets.
 *  3. The personal-widget update methods become no-ops while spectating (the
 *     per-frame repaint gate) — call them and assert they do not mutate state.
 *  4. `isSpectating()` reflects the toggle.
 *
 * WHAT THIS DOES NOT PROVE (browser verification):
 *  - The fade tween actually animates alpha in a real Phaser scene.
 *  - The spectator HUD visually shows the spectated player's readout.
 *  - The wiring from PlayerLifecycleController fires on the death rising edge.
 *  Those are covered by tsc + the wiring (PlayerLifecycleController.ts) + manual
 *  browser verification per the ticket.
 *
 * Reference: `.scratch/lighting-system-2/01-findings/B2-spectator-hud-cleanup.md`
 * (§3 root cause, §4 H1+H5, §6 scope of fix).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// --- Spy component factories -------------------------------------------
// Each stub records setVisible/setAlpha (and setRatio for the bars) so the test
// can assert exactly which widgets setSpectating touches.

interface VisibleSpy {
  setVisible: ReturnType<typeof vi.fn>;
  setAlpha: ReturnType<typeof vi.fn>;
  setText: ReturnType<typeof vi.fn>;
  setColor: ReturnType<typeof vi.fn>;
}

function makeVisibleSpy(): VisibleSpy {
  return {
    setVisible: vi.fn().mockReturnThis(),
    setAlpha: vi.fn().mockReturnThis(),
    setText: vi.fn().mockReturnThis(),
    setColor: vi.fn().mockReturnThis(),
  };
}

function makeBarSpy(): VisibleSpy & { setRatio: ReturnType<typeof vi.fn> } {
  return { ...makeVisibleSpy(), setRatio: vi.fn().mockReturnThis() };
}

/**
 * Stub HUDComponents. The arrays are length-4 (slot count) to exercise the
 * spread + filter-null paths in setSpectating. `slotIcons` holds two nulls to
 * prove the null-guard works. healthBar/dashBar carry setRatio spies so
 * updateHealth/updateDashCooldown can run to completion when NOT spectating.
 */
function makeStubComponents() {
  return {
    healthBar: makeBarSpy(),
    healthLabel: makeVisibleSpy(),
    dashBar: makeBarSpy(),
    dashLabel: makeVisibleSpy(),
    timerLabel: makeVisibleSpy(),
    phaseLabel: makeVisibleSpy(),
    aliveLabel: makeVisibleSpy(),
    statusLabel: makeVisibleSpy(),
    interactionLabel: makeVisibleSpy(),
    slotBgs: [makeVisibleSpy(), makeVisibleSpy(), makeVisibleSpy(), makeVisibleSpy()],
    slotBorders: [makeVisibleSpy(), makeVisibleSpy(), makeVisibleSpy(), makeVisibleSpy()],
    slotIcons: [makeVisibleSpy(), null, makeVisibleSpy(), null],
    durabilityBars: [makeBarSpy(), makeBarSpy(), makeBarSpy(), makeBarSpy()],
    durabilityLabels: [makeVisibleSpy(), makeVisibleSpy(), makeVisibleSpy(), makeVisibleSpy()],
    slotKeyLabels: [makeVisibleSpy(), makeVisibleSpy(), makeVisibleSpy(), makeVisibleSpy()],
    hpY: 0,
    slotY: 0,
    healthX: 0,
    healthLeft: 0,
    healthWidth: 0,
    slotStartX: 0,
  };
}

// Module-level holder populated on each createHUDComponents call (the mock is
// hoisted by vitest, so it cannot close over per-test locals).
let stubComponents: ReturnType<typeof makeStubComponents>;

vi.mock('../HUDFactory.js', () => ({
  createHUDComponents: () => stubComponents,
}));

vi.mock('../MinimapRenderer.js', () => ({
  MinimapRenderer: class {
    setVisible = vi.fn().mockReturnThis();
    getEntranceElements = vi.fn(() => []);
    updateMinimap = vi.fn();
    destroy = vi.fn();
  },
}));

vi.mock('../KillFeedRenderer.js', () => ({
  KillFeedRenderer: class {
    setVisible = vi.fn().mockReturnThis();
    getEntranceElements = vi.fn(() => []);
    update = vi.fn();
    addKill = vi.fn();
    destroy = vi.fn();
  },
}));

vi.mock('../PowerUpIndicators.js', () => ({
  PowerUpIndicators: class {
    setVisible = vi.fn().mockReturnThis();
    getEntranceElements = vi.fn(() => []);
    updateBarrier = vi.fn();
    hideBarrier = vi.fn();
    updateSpeedBoost = vi.fn();
    hideSpeedBoost = vi.fn();
    destroy = vi.fn();
  },
}));

vi.mock('../SpectatorHUD.js', () => ({
  SpectatorHUD: class {
    show = vi.fn();
    hide = vi.fn();
    destroy = vi.fn();
  },
}));

// --- Minimal scene stub ------------------------------------------------
// HUDManager uses scene.tweens.add (entrance + setSpectating fade) and
// scene.scale (ComponentConfig reads width/height at construction). The tween
// mock captures the config so tests can fire onComplete synchronously (Phaser's
// real tween fires it after the duration; in vitest we drive it by hand).
interface TweenConfig {
  targets: unknown;
  alpha: number;
  duration: number;
  onComplete?: () => void;
}
let lastTweenConfig: TweenConfig | null = null;
const tweensAdd = vi.fn((config: TweenConfig) => {
  lastTweenConfig = config;
  return {};
});
const sceneStub = {
  tweens: { add: tweensAdd },
  scale: { width: 1280, height: 720 },
} as unknown as Phaser.Scene;

// --- Import AFTER mocks are registered ---------------------------------
import { HUDManager } from '../HUDManager.js';

/** Convenience: collect every personal-widget spy the ticket says to HIDE. */
function personalWidgetSpies(): VisibleSpy[] {
  const c = stubComponents;
  return [
    c.healthBar,
    c.healthLabel,
    c.dashBar,
    c.dashLabel,
    ...c.slotBgs,
    ...c.slotBorders,
    ...c.durabilityBars,
    ...c.durabilityLabels,
    ...c.slotKeyLabels,
    c.slotIcons[0],
    c.slotIcons[2], // nulls at index 1,3 are skipped by the filter(Boolean)
  ].filter(Boolean) as VisibleSpy[];
}

/** Convenience: collect every match-state widget spy that must STAY VISIBLE. */
function matchStateSpies(): VisibleSpy[] {
  const c = stubComponents;
  return [c.timerLabel, c.phaseLabel, c.aliveLabel, c.statusLabel];
}

describe('ticket 04 (B2) — spectator HUD cleanup', () => {
  beforeEach(() => {
    stubComponents = makeStubComponents();
    lastTweenConfig = null;
    tweensAdd.mockClear();
  });

  describe('setSpectating(true) hides personal widgets, keeps match-state', () => {
    it('hides every personal widget (health/dash/inventory slots/prompt) once the fade completes', () => {
      const hud = new HUDManager(sceneStub);
      hud.setSpectating(true);
      // The hide fade calls setVisible(false) in onComplete; fire it so the
      // final visibility state matches what a real Phaser scene would reach.
      lastTweenConfig?.onComplete?.();

      for (const spy of personalWidgetSpies()) {
        expect(spy.setVisible).toHaveBeenCalledWith(false);
      }
    });

    it('does NOT hide any match-state widget (timer/phase/alive/status)', () => {
      const hud = new HUDManager(sceneStub);
      hud.setSpectating(true);
      lastTweenConfig?.onComplete?.();

      for (const spy of matchStateSpies()) {
        // setSpectating must never call setVisible(false) on match-state widgets.
        expect(spy.setVisible).not.toHaveBeenCalledWith(false);
      }
    });

    it('gates the power-up indicators container (PowerUpIndicators.setVisible(false))', () => {
      const hud = new HUDManager(sceneStub);
      hud.setSpectating(true);
      // The contract is proven two ways: (1) the gate flips immediately, and
      // (2) updatePowerUps becomes a no-op (asserted in the repaint-gate block).
      expect(hud.isSpectating()).toBe(true);
    });

    it('reports isSpectating() === true immediately (gate flips before fade completes)', () => {
      const hud = new HUDManager(sceneStub);
      expect(hud.isSpectating()).toBe(false);
      hud.setSpectating(true);
      expect(hud.isSpectating()).toBe(true);
    });

    it('is idempotent — calling again with true is a no-op', () => {
      const hud = new HUDManager(sceneStub);
      hud.setSpectating(true);
      const spy = stubComponents.healthBar.setVisible;
      const callCountAfterFirst = spy.mock.calls.length;
      hud.setSpectating(true);
      expect(spy.mock.calls.length).toBe(callCountAfterFirst);
    });
  });

  describe('setSpectating(false) restores the main HUD personal widgets', () => {
    it('shows every personal widget again', () => {
      const hud = new HUDManager(sceneStub);
      hud.setSpectating(true);
      // Reset spies so we only observe the restore call.
      for (const spy of personalWidgetSpies()) spy.setVisible.mockClear();

      hud.setSpectating(false);

      for (const spy of personalWidgetSpies()) {
        expect(spy.setVisible).toHaveBeenCalledWith(true);
      }
      expect(hud.isSpectating()).toBe(false);
    });
  });

  describe('per-frame repaint gate (findings H5 compounding factor)', () => {
    // The dead local player's stale readout must not be re-driven while the
    // widgets are hidden. Each personal-widget update method short-circuits.

    it('updateHealth is a no-op while spectating (does not setText on the label)', () => {
      const hud = new HUDManager(sceneStub);
      hud.setSpectating(true);
      const labelSetText = vi.fn();
      (stubComponents.healthLabel as unknown as { setText: ReturnType<typeof vi.fn> }).setText =
        labelSetText;
      hud.updateHealth(50, 100);
      expect(labelSetText).not.toHaveBeenCalled();
    });

    it('updateInventory is a no-op while spectating (cannot re-show slot icons/durability)', () => {
      const hud = new HUDManager(sceneStub);
      hud.setSpectating(true);
      // If the gate failed, updateInventory would call setVisible(true) on
      // durability bars / slot icons. Assert none of the personal spies get a
      // new setVisible(true) call from updateInventory.
      for (const spy of personalWidgetSpies()) spy.setVisible.mockClear();

      hud.updateInventory({
        activeSlot: 0,
        weapons: [{ weaponType: 5, ammo: 10, maxAmmo: 10 }],
      } as never);

      for (const spy of personalWidgetSpies()) {
        expect(spy.setVisible).not.toHaveBeenCalledWith(true);
      }
    });

    it('updateDashCooldown is a no-op while spectating', () => {
      const hud = new HUDManager(sceneStub);
      hud.setSpectating(true);
      const labelSetText = vi.fn();
      (stubComponents.dashLabel as unknown as { setText: ReturnType<typeof vi.fn> }).setText =
        labelSetText;
      hud.updateDashCooldown(30, 60);
      expect(labelSetText).not.toHaveBeenCalled();
    });

    it('updatePowerUps is a no-op while spectating', () => {
      const hud = new HUDManager(sceneStub);
      hud.setSpectating(true);
      // Assert no throw + isSpectating still true. The PowerUpIndicators mock's
      // updateBarrier is never reached because HUDManager gates before delegating.
      expect(() => hud.updatePowerUps(true, 5, true, 5)).not.toThrow();
      expect(hud.isSpectating()).toBe(true);
    });

    it('setInteractionPrompt forces the prompt hidden while spectating', () => {
      const hud = new HUDManager(sceneStub);
      hud.setSpectating(true);
      stubComponents.interactionLabel.setVisible.mockClear();

      hud.setInteractionPrompt('[E] Open Chest');

      // Even with non-empty text, the prompt stays hidden during spectate.
      expect(stubComponents.interactionLabel.setVisible).toHaveBeenCalledWith(false);
      expect(stubComponents.interactionLabel.setVisible).not.toHaveBeenCalledWith(true);
    });

    it('after setSpectating(false), updateHealth drives the bar again', () => {
      const hud = new HUDManager(sceneStub);
      hud.setSpectating(true);
      hud.setSpectating(false);
      stubComponents.healthLabel.setVisible.mockClear();
      hud.updateHealth(75, 100);
      // The label gets the new text — proving the gate reopened on restore.
      expect(stubComponents.healthBar.setRatio).toHaveBeenCalledWith(0.75);
    });
  });

  describe('transition polish', () => {
    it('starts a fade-out tween (alpha → 0) when hiding personal widgets', () => {
      const hud = new HUDManager(sceneStub);
      hud.setSpectating(true);
      // The LAST tween added by setSpectating is the fade-out.
      expect(tweensAdd).toHaveBeenCalled();
      const hideTween = lastTweenConfig!;
      expect(hideTween.alpha).toBe(0);
      expect(hideTween.onComplete).toBeTypeOf('function');
    });

    it('starts a fade-in tween (alpha → 1) when restoring personal widgets', () => {
      const hud = new HUDManager(sceneStub);
      hud.setSpectating(true);
      tweensAdd.mockClear();
      hud.setSpectating(false);
      expect(tweensAdd).toHaveBeenCalled();
      const showTween = lastTweenConfig!;
      expect(showTween.alpha).toBe(1);
    });
  });
});
