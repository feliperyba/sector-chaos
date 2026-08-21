import Phaser from 'phaser';
import type { PlayerState, KillFeedEntry } from '../types.js';
import { WEAPON_SPRITE_MAP } from '../types.js';
import { MinimapRenderer } from './MinimapRenderer.js';
import type { MinimapData } from './MinimapRenderer.js';
import { KillFeedRenderer } from './KillFeedRenderer.js';
import { PowerUpIndicators } from './PowerUpIndicators.js';
import { SpectatorHUD } from './SpectatorHUD.js';
import { DesignTokens } from '../ui/DesignTokens.js';
import { ComponentConfig } from '../ui/ComponentConfig.js';
import { TweenTracker } from '../ui/animations/TweenTracker.js';
import { createHUDComponents, type HUDComponents } from './HUDFactory.js';
import { MATCH } from '@sector-battle/shared';

const PHASE_DISPLAY: Record<number, string> = {
  0: 'Phase 1 — Waiting',
  1: 'Phase 2 — Countdown',
  2: 'Phase 3 — Active',
  3: 'Phase 4 — Zone Shrinking',
  5: 'Phase 5 — Finished',
  6: 'Phase 6 — Overtime',
  7: 'Phase 7 — Final Closure',
};

const PHASE_COLORS: Record<number, number> = {
  1: DesignTokens.colors.warmOrange,
  3: DesignTokens.colors.red,
};

export class HUDManager {
  private scene: Phaser.Scene;
  private minimapRenderer: MinimapRenderer;
  private killFeedRenderer: KillFeedRenderer;
  private powerUpIndicators: PowerUpIndicators;
  private spectatorHUD: SpectatorHUD;
  private tracker: TweenTracker;
  private c!: HUDComponents;
  private prevWeaponTypes: (number | null)[] = [null, null, null, null];
  /** Per-frame dirty-check caches — skip no-op setText/setRatio calls. */
  private _lastHealthText = '';
  private _lastDashCooldown: number | null = null;
  /**
   * Formatted dash-label string cache (perf ticket 21, kill-feed pattern) —
   * see updateDashCooldown. The raw cooldown cache above still gates the BAR.
   */
  private _lastDashLabelText = '';
  private _lastPhase: number | null = null;
  private _lastTimerText = '';
  private _lastAlive: number | null = null;
  private _lastPromptText: string | null = null;
  /**
   * Spectator-mode gate. When true the personal widgets (health/dash/inventory/
   * power-ups/interaction prompt) are hidden so the dead local player's stale
   * readout is NOT shown alongside the spectator HUD (which displays the
   * spectated player's state). Match-context widgets (minimap, kill feed,
   * timer/phase/alive, status messages) stay visible — they are useful to a
   * spectator. Per user ruling: "hide personal widgets, keep match-state visible."
   */
  private _spectating = false;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
    this.tracker = new TweenTracker(scene);
    this.c = createHUDComponents(scene, this.tracker);
    this.minimapRenderer = new MinimapRenderer(scene);
    this.killFeedRenderer = new KillFeedRenderer(scene);
    this.powerUpIndicators = new PowerUpIndicators(
      scene,
      this.c.slotY,
      this.c.slotStartX,
      ComponentConfig.slot.gap,
    );
    this.spectatorHUD = new SpectatorHUD(scene);
    this.entranceAnimation();
  }

  private entranceAnimation(): void {
    const elements = [
      ...this.minimapRenderer.getEntranceElements(),
      ...this.killFeedRenderer.getEntranceElements(),
      ...this.powerUpIndicators.getEntranceElements(),
      this.c.healthBar,
      this.c.healthLabel,
      this.c.dashBar,
      this.c.dashLabel,
      this.c.timerLabel,
      this.c.phaseLabel,
      this.c.aliveLabel,
      ...this.c.slotBgs,
      ...this.c.slotBorders,
      ...this.c.durabilityBars,
      ...this.c.durabilityLabels,
      ...this.c.slotKeyLabels,
    ];

    for (const el of elements) {
      if ('setAlpha' in el) {
        (el as Phaser.GameObjects.GameObject & { setAlpha: (a: number) => void }).setAlpha(0);
      }
    }

    const tw = this.scene.tweens.add({
      targets: elements,
      alpha: 1,
      duration: DesignTokens.duration.smooth,
      ease: DesignTokens.easing.sineOut,
    });
    this.tracker.track(tw);
  }

  // -----------------------------------------------------------------------
  // Spectator-mode lifecycle
  // -----------------------------------------------------------------------

  /**
   * Returns the current spectator-mode gate. Per-frame repaint paths gate on
   * this to avoid re-driving the dead local player's stale HUD readout while
   * it is hidden (findings B2 §2 "Per-frame repaint" + §4 H5 compounding factor).
   */
  isSpectating(): boolean {
    return this._spectating;
  }

  /**
   * Toggle spectator-mode visibility for the main HUD.
   *
   * HIDDEN (personal widgets — the dead local player's readout, replaced by the
   * SpectatorHUD's spectated-player readout):
   *   healthBar/healthLabel, dashBar/dashLabel, all inventory slot widgets
   *   (bgs/borders/icons/durability/key labels), powerUpIndicators, and the
   *   interaction prompt (the local player's chest-pickup prompt — personal).
   *
   * KEPT VISIBLE (match-state, useful to a spectator — per user ruling):
   *   minimapRenderer, killFeedRenderer, timerLabel, phaseLabel, aliveLabel,
   *   statusLabel (match-wide messages such as "Reconnected as spectator").
   *
   * The personal widgets fade out / in (per user ruling: "fade/blur/cinematic
   * so the HUD swap isn't abrupt") rather than hard-toggling. Idempotent —
   * calling with the current value is a no-op.
   */
  setSpectating(spectating: boolean): void {
    if (this._spectating === spectating) return;
    this._spectating = spectating;

    const personalWidgets: (
      | Phaser.GameObjects.GameObject
      | { setVisible: (v: boolean) => void }
    )[] = [
      this.c.healthBar,
      this.c.healthLabel,
      this.c.dashBar,
      this.c.dashLabel,
      ...this.c.slotBgs,
      ...this.c.slotBorders,
      ...this.c.durabilityBars,
      ...this.c.durabilityLabels,
      ...this.c.slotKeyLabels,
    ];
    for (const icon of this.c.slotIcons) {
      if (icon) personalWidgets.push(icon);
    }

    // Power-up indicators manage per-pill visibility internally; route through a
    // dedicated gate so they stay hidden even if updatePowerUps is called while
    // spectating (defensive — HUDUpdateService is gated, but keep the invariant).
    this.powerUpIndicators.setVisible(!spectating);

    // Fade the personal widgets (transition polish — per user ruling the HUD
    // swap should not be abrupt). On hide: tween alpha to 0 then setVisible
    // false; on show: setVisible true then tween alpha to 1. The gate flags
    // flip immediately so the per-frame repaint methods short-circuit from
    // this frame onward regardless of tween completion.
    const fadeTargets = personalWidgets.filter(
      (w): w is Phaser.GameObjects.GameObject => !!w && 'setAlpha' in w,
    );
    if (spectating) {
      this.scene.tweens.add({
        targets: fadeTargets,
        alpha: 0,
        duration: DesignTokens.duration.standard,
        ease: DesignTokens.easing.snappy,
        onComplete: () => {
          for (const w of personalWidgets) {
            if (w && 'setVisible' in w) w.setVisible(false);
          }
        },
      });
    } else {
      for (const w of personalWidgets) {
        if (w && 'setVisible' in w) w.setVisible(true);
      }
      this.scene.tweens.add({
        targets: fadeTargets,
        alpha: 1,
        duration: DesignTokens.duration.standard,
        ease: DesignTokens.easing.sineOut,
      });
    }

    // Interaction prompt is the local player's chest-pickup prompt — personal.
    // setVisible(false) keeps it suppressed for the whole spectate session; the
    // gate on setInteractionPrompt below holds it even if callers re-fire.
    this.c.interactionLabel.setVisible(spectating ? false : !!this._lastPromptText);
  }

  // -----------------------------------------------------------------------
  // State Mutations
  // -----------------------------------------------------------------------

  setStatusText(text: string, visible = true): void {
    this.c.statusLabel.setText(text);
    this.c.statusLabel.setVisible(visible);
  }

  updateHealth(health: number, maxHealth: number): void {
    // Spectate gate: the dead local player's health is stale and the bar is
    // hidden — skip the repaint so a stray caller can't re-show it.
    if (this._spectating) return;
    const text = `${health}/${maxHealth}`;
    if (text === this._lastHealthText) return;
    this._lastHealthText = text;
    const pct = maxHealth > 0 ? health / maxHealth : 0;
    this.c.healthBar.setRatio(pct);
    this.c.healthLabel.setText(text);
  }

  updateInventory(p: PlayerState): void {
    // Spectate gate: the inventory is hidden and stale — skip the repaint so a
    // stray caller can't re-show slot icons / durability bars (findings H5).
    if (this._spectating) return;
    const sc = ComponentConfig.slot;

    for (let i = 0; i < sc.count; i++) {
      const x = this.c.slotStartX + i * (sc.size + sc.gap);
      const isActive = i === p.activeSlot;
      const weapon = p.weapons?.[i];
      const hasWeapon = weapon != null && weapon.weaponType > 0;

      this.c.slotBgs[i]!.setTint(
        isActive
          ? DesignTokens.colors.darkerGray
          : hasWeapon
            ? DesignTokens.colors.darkestGray
            : DesignTokens.colors.nearBlack,
      );

      // Active slot border
      this.c.slotBorders[i]!.setAlpha(isActive ? 1 : 0);
      if (isActive) {
        this.c.slotBorders[i]!.setTint(DesignTokens.colors.amber);
      }

      const newType = hasWeapon ? weapon.weaponType : null;
      if (newType !== this.prevWeaponTypes[i]) {
        this.prevWeaponTypes[i] = newType;
        if (this.c.slotIcons[i]) {
          if (newType) {
            const sk = WEAPON_SPRITE_MAP[newType] ?? 'weapon_dagger';
            if (this.scene.textures.get('game').has(sk))
              this.c.slotIcons[i]!.setTexture('game', sk).setVisible(true);
          } else {
            this.c.slotIcons[i]!.setVisible(false);
          }
        } else if (newType) {
          const sk = WEAPON_SPRITE_MAP[newType] ?? 'weapon_dagger';
          if (this.scene.textures.get('game').has(sk)) {
            this.c.slotIcons[i] = this.scene.add
              .sprite(x, this.c.slotY - DesignTokens.spacing.sm, 'game', sk)
              .setOrigin(0.5)
              .setDisplaySize(40, 40)
              .setDepth(DesignTokens.depth.hudContent)
              .setScrollFactor(0);
          }
        }
      }

      if (hasWeapon) {
        const pct = weapon.maxAmmo > 0 ? weapon.ammo / weapon.maxAmmo : 0;
        this.c.durabilityBars[i]!.setVisible(true);
        this.c.durabilityBars[i]!.setRatio(pct, false);
        this.c.durabilityLabels[i]!.setVisible(true);
        this.c.durabilityLabels[i]!.setText(`${weapon.ammo}/${weapon.maxAmmo}`);
      } else {
        this.c.durabilityBars[i]!.setVisible(false);
        this.c.durabilityLabels[i]!.setVisible(false);
      }
    }
  }

  updateDashCooldown(cooldown: number, maxCooldown: number): void {
    // Spectate gate: the dash bar is hidden — skip the repaint.
    if (this._spectating) return;
    // Perf ticket 21 (kill-feed pattern): the raw integer cooldown changes
    // every tick, so the former raw-only dirty-check let `setText` fire ~60×/s
    // during the cooldown — each call re-rasterizes the canvas texture and
    // re-uploads it for a string that changes at most 6×/s. The BAR keeps its
    // per-tick raw gate (progress stays smooth); only the label text + its
    // color (fully determined by the string: READY=cyan, countdown=gray) gate
    // on the formatted string.
    const labelText = cooldown <= 0 ? 'READY' : `${(cooldown / 60).toFixed(1)}s`;
    if (cooldown === this._lastDashCooldown && labelText === this._lastDashLabelText) return;
    this._lastDashCooldown = cooldown;
    if (labelText !== this._lastDashLabelText) {
      this._lastDashLabelText = labelText;
      this.c.dashLabel.setText(labelText);
      this.c.dashLabel.setColor(
        cooldown <= 0 ? DesignTokens.colors.cyan : DesignTokens.colors.lighterGray,
      );
    }
    if (cooldown <= 0) {
      this.c.dashBar.setRatio(1, false);
    } else {
      const pct = maxCooldown > 0 ? 1 - cooldown / maxCooldown : 0;
      this.c.dashBar.setRatio(pct);
    }
  }

  updatePhase(phase: number): void {
    if (phase === this._lastPhase) return;
    this._lastPhase = phase;
    this.c.phaseLabel.setText(PHASE_DISPLAY[phase] ?? '');
    this.c.phaseLabel.setColor(PHASE_COLORS[phase] ?? DesignTokens.colors.amber);
  }

  updateTimer(matchTimer: number): void {
    const remaining = Math.max(0, MATCH.TARGET_DURATION - matchTimer);
    const min = Math.floor(remaining / 60);
    const sec = remaining % 60;
    const text = `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    if (text === this._lastTimerText) return;
    this._lastTimerText = text;
    this.c.timerLabel.setText(text);
  }

  updateAliveCount(count: number): void {
    if (count === this._lastAlive) return;
    this._lastAlive = count;
    this.c.aliveLabel.setText(`Alive: ${count}/64`);
  }

  addKill(entry: KillFeedEntry): void {
    this.killFeedRenderer.addKill(entry);
  }

  setInteractionPrompt(text: string): void {
    // Spectate gate: the interaction prompt is the local (dead) player's
    // chest-pickup prompt — personal, suppressed for the whole spectate session.
    if (this._spectating) {
      this.c.interactionLabel.setVisible(false);
      return;
    }
    if (text === this._lastPromptText) return;
    this._lastPromptText = text;
    this.c.interactionLabel.setText(text);
    this.c.interactionLabel.setVisible(!!text);
  }

  updatePromptPosition(x: number, y: number): void {
    this.c.interactionLabel.setPosition(x, y - 60);
  }

  update(now: number): void {
    this.killFeedRenderer.update(now);
  }

  updateMinimap(data: MinimapData): void {
    this.minimapRenderer.updateMinimap(data);
  }

  updatePowerUps(
    barrierActive: boolean,
    barrierRemaining: number,
    speedActive: boolean,
    speedRemaining: number,
  ): void {
    // Spectate gate: power-up indicators are hidden — skip the repaint so a
    // stray caller can't re-show a pill (PowerUpIndicators also gates on its
    // own containerVisible flag, this is the outer defense).
    if (this._spectating) return;
    if (barrierActive) {
      this.powerUpIndicators.updateBarrier(barrierRemaining, 10);
    } else {
      this.powerUpIndicators.hideBarrier();
    }

    if (speedActive) {
      this.powerUpIndicators.updateSpeedBoost(speedRemaining, 10);
    } else {
      this.powerUpIndicators.hideSpeedBoost();
    }
  }

  showSpectatorHUD(
    playerName: string,
    health: number,
    maxHealth: number,
    weapons: { weaponType: number }[],
    activeSlot: number,
    barrierActive = false,
    speedBoostActive = false,
  ): void {
    this.spectatorHUD.show(
      playerName,
      health,
      maxHealth,
      weapons as { id: string; weaponType: number; tier: number; ammo: number; maxAmmo: number }[],
      activeSlot,
      barrierActive,
      speedBoostActive,
    );
  }

  hideSpectatorHUD(): void {
    this.spectatorHUD.hide();
  }

  destroy(): void {
    this.tracker.dispose();
    this.minimapRenderer.destroy();
    this.killFeedRenderer.destroy();
    this.powerUpIndicators.destroy();
    this.spectatorHUD.destroy();

    const components: (Phaser.GameObjects.GameObject | null)[] = [
      this.c.healthBar,
      this.c.healthLabel,
      this.c.dashBar,
      this.c.dashLabel,
      this.c.timerLabel,
      this.c.phaseLabel,
      this.c.aliveLabel,
      this.c.statusLabel,
      this.c.interactionLabel,
    ];
    for (const c of components) {
      if (c) c.destroy();
    }

    for (const bg of this.c.slotBgs) bg.destroy();
    for (const border of this.c.slotBorders) border.destroy();
    for (const icon of this.c.slotIcons) {
      if (icon) icon.destroy();
    }
    for (const bar of this.c.durabilityBars) bar.destroy();
    for (const label of this.c.durabilityLabels) label.destroy();
    for (const label of this.c.slotKeyLabels) label.destroy();
  }
}
