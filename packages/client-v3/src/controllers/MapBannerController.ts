import Phaser from 'phaser';
import { DesignTokens } from '../ui/DesignTokens.js';
import { Label } from '../ui/components/Label.js';
import type { GameState } from './GameState.js';

/**
 * MapBannerController (map-redesign ticket 03 / DEC-001 + DEC-010) — owns the
 * two transient naming lines, both under the session's banner discipline
 * (single line, corner/phase-banner placement, fast fade, never occluding
 * combat):
 *
 * 1. Sector enter-banner — top-left corner, shown when the local (or
 *    spectated) player crosses a sector border, ≤ ~2s total lifetime.
 *    Suppressed while the local player is taking damage (the discipline
 *    rule: combat always outranks flavor).
 * 2. Map designation — centered under the phase-banner area, shown once at
 *    match start (countdown) and again on the results screen (the results
 *    line is rendered by ResultsScreen itself; this label is the in-match
 *    one).
 *
 * All strings are server-authored (`GameState.poiNames` / `.designation`
 * from the one-shot `mapData` message) — this controller renders only.
 */

/** Total enter-banner lifetime: hold + fade ≤ ~2s (DEC-001 2-second rule). */
const BANNER_HOLD_MS = 700;
const BANNER_FADE_MS = 1300;
/** Designation stays through the countdown, then fades. */
const DESIGNATION_HOLD_MS = 4500;
const DESIGNATION_FADE_MS = 900;
/**
 * Combat suppression window: a damage event on the local player within this
 * window suppresses the enter-banner entirely (banner discipline).
 */
const DAMAGE_SUPPRESS_MS = 1500;
/** Sector grid is 4x4 (matches SECTOR_GRID_SIZE in shared constants). */
const SECTOR_GRID = 4;

/**
 * Look up the POI display name covering a world position. Pure geometry —
 * the string itself is server-authored. Returns undefined when naming data
 * is absent (demo maps) or the position is off-map.
 */
export function poiNameAt(
  poiNames: ReadonlyArray<ReadonlyArray<string>> | null,
  worldW: number,
  x: number,
  y: number,
): string | undefined {
  if (!poiNames || worldW <= 0) return undefined;
  const col = Math.floor((x / worldW) * SECTOR_GRID);
  const row = Math.floor((y / worldW) * SECTOR_GRID);
  if (row < 0 || row >= SECTOR_GRID || col < 0 || col >= SECTOR_GRID) return undefined;
  return poiNames[row]?.[col] || undefined;
}

export class MapBannerController {
  private readonly scene: Phaser.Scene;
  private readonly state: GameState;
  private readonly bannerLabel: Label;
  private readonly designationLabel: Label;
  private lastRow = -1;
  private lastCol = -1;
  private bannerTween: Phaser.Tweens.Tween | null = null;
  private designationTween: Phaser.Tweens.Tween | null = null;
  /** True when match-start fired before mapData landed (see showDesignation). */
  private designationPending = false;
  private destroyed = false;

  constructor(scene: Phaser.Scene, state: GameState) {
    this.scene = scene;
    this.state = state;

    // Enter-banner: top-left corner (kill feed + minimap own the right side,
    // health/slots own the bottom). Left-aligned single line.
    this.bannerLabel = new Label(scene, 24, 88, {
      text: '',
      variant: 'caption',
      color: DesignTokens.colors.white,
      align: 'left',
      stroke: true,
    });
    this.bannerLabel.setDepth(DesignTokens.depth.hudContent);
    this.bannerLabel.setScrollFactor(0);
    this.bannerLabel.setAlpha(0);
    this.bannerLabel.setVisible(false);
    const bt = this.bannerLabel.getAt(0) as Phaser.GameObjects.Text;
    bt.setOrigin(0, 0.5);

    // Designation: centered under the status/phase-banner text (which sits
    // at height * 0.25). Same transient-line discipline.
    this.designationLabel = new Label(
      scene,
      scene.scale.width / 2,
      scene.scale.height * 0.25 + 52,
      {
        text: '',
        variant: 'body',
        color: DesignTokens.colors.amber,
        align: 'center',
        stroke: true,
      },
    );
    this.designationLabel.setDepth(DesignTokens.depth.overlay);
    this.designationLabel.setScrollFactor(0);
    this.designationLabel.setAlpha(0);
    this.designationLabel.setVisible(false);
    const dt = this.designationLabel.getAt(0) as Phaser.GameObjects.Text;
    dt.setOrigin(0.5, 0.5);
  }

  /**
   * Per-frame sector-crossing detection. Zero allocations in the steady
   * state (pure arithmetic; tween objects are created only on crossings).
   */
  update(now: number, x: number, y: number): void {
    if (this.destroyed) return;
    const worldW = this.state.mapWorldW;
    if (!this.state.poiNames || worldW <= 0) return;

    const col = Math.floor((x / worldW) * SECTOR_GRID);
    const row = Math.floor((y / worldW) * SECTOR_GRID);
    if (row < 0 || row >= SECTOR_GRID || col < 0 || col >= SECTOR_GRID) return;

    if (row === this.lastRow && col === this.lastCol) return;
    const isFirstFix = this.lastRow === -1;
    this.lastRow = row;
    this.lastCol = col;

    const name = this.state.poiNames[row]?.[col];
    if (!name) return;

    // Banner discipline: combat outranks flavor — suppress the line while
    // the local player is actively taking damage. The FIRST fix (spawn /
    // spectate target switch) shows the location so the player learns where
    // they are; later crossings are transient only.
    if (!isFirstFix && now - this.state.lastLocalDamageAt < DAMAGE_SUPPRESS_MS) return;

    this.showBanner(name);
  }

  /** Show the enter-banner line (single line, corner, ≤ ~2s, fast fade). */
  private showBanner(text: string): void {
    this.bannerTween?.remove();
    this.bannerTween = this.runTransient(this.bannerLabel, text, BANNER_HOLD_MS, BANNER_FADE_MS);
  }

  /**
   * Show the map designation at match start (phase-banner area). One line,
   * transient — held through the countdown, then faded out.
   *
   * The match-start phase change can arrive BEFORE the one-shot `mapData`
   * message (the room starts COUNTDOWN on the first join; the phase event
   * replays from the matchmaking message buffer while mapData is still in
   * flight) — in that case the call records a pending flag and
   * {@link notifyMapData} flushes it the moment the designation lands.
   */
  showDesignation(text: string | null | undefined): void {
    if (this.destroyed) return;
    if (!text) {
      this.designationPending = true;
      return;
    }
    this.designationPending = false;
    this.designationTween?.remove();
    this.designationTween = this.runTransient(
      this.designationLabel,
      text,
      DESIGNATION_HOLD_MS,
      DESIGNATION_FADE_MS,
    );
  }

  /**
   * Flush a pending designation show once the one-shot `mapData` message
   * arrives (see {@link showDesignation}). No-op when nothing is pending.
   */
  notifyMapData(designation: string | null): void {
    if (this.destroyed || !this.designationPending || !designation) return;
    this.showDesignation(designation);
  }

  /**
   * Shared transient-line behavior (banner discipline): set the text, hold
   * at full alpha, then fade out and hide. Each label owns its tween
   * independently (banner + designation can be visible simultaneously).
   */
  private runTransient(
    label: Label,
    text: string,
    holdMs: number,
    fadeMs: number,
  ): Phaser.Tweens.Tween {
    const t = label.getAt(0) as Phaser.GameObjects.Text;
    if (t.text !== text) t.setText(text);
    label.setVisible(true);
    label.setAlpha(1);
    return this.scene.tweens.add({
      targets: label,
      alpha: 0,
      delay: holdMs,
      duration: fadeMs,
      ease: 'Quad.easeIn',
      onComplete: () => {
        label.setVisible(false);
      },
    });
  }

  /** Reset crossing memory (scene restart / re-spectate). */
  reset(): void {
    this.lastRow = -1;
    this.lastCol = -1;
  }

  destroy(): void {
    this.destroyed = true;
    this.bannerTween?.remove();
    this.designationTween?.remove();
    this.bannerLabel.destroy();
    this.designationLabel.destroy();
  }
}
