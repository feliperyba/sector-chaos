import Phaser from 'phaser';
import { DesignTokens } from '../ui/DesignTokens.js';
import { ComponentConfig } from '../ui/ComponentConfig.js';
import { Button } from '../ui/components/Button.js';
import { Label } from '../ui/components/Label.js';
import { TweenTracker } from '../ui/animations/TweenTracker.js';
import {
  TABLE_WIDTH,
  ROW_HEIGHT,
  MAX_VISIBLE,
  createResultsRow,
  formatResultsTime,
  playPopInAnimation,
} from './ResultsRowBuilder.js';
import { createResultsButtons } from './ResultsButtons.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ResultsMode = 'matchEnd' | 'death';

export interface PlacementData {
  playerId: string;
  placement: number;
  kills: number;
  damageDealt: number;
  damageTaken: number;
  survivalTimeMs: number;
  weaponsUsed: number;
  itemsCollected: number;
  name: string;
}

export interface DeathInfo {
  aliveCount: number;
  matchTimerMs: number;
  killCount: number;
  onReturnToTitle: () => void;
  onSpectate: () => void;
}

// ---------------------------------------------------------------------------
// Layout Constants
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// ResultsScreen — Component-driven results with MVC architecture
// ---------------------------------------------------------------------------

export class ResultsScreen {
  private scene: Phaser.Scene;
  private myId: string;
  private container: Phaser.GameObjects.Container;
  private tracker: TweenTracker;

  // --- Component references ---
  private bgOverlay: Phaser.GameObjects.Rectangle | null = null;
  private headerLabel: Label | null = null;
  private winnerLabel: Label | null = null;
  private headerRow: Phaser.GameObjects.Container | null = null;
  private dataRows: Phaser.GameObjects.Container[] = [];

  // --- State ---
  private mode: ResultsMode = 'matchEnd';
  private scrollOffset = 0;
  private totalRows = 0;
  private tableBaseY = 0;
  private _visible = false;
  private onDismiss: (() => void) | null = null;
  private autoScrollTimer: Phaser.Time.TimerEvent | null = null;
  private dismissTimer: Phaser.Time.TimerEvent | null = null;
  private escKey: Phaser.Input.Keyboard.Key | null = null;

  // --- Buttons ---
  private returnButton: Button | null = null;
  private spectateButton: Button | null = null;

  constructor(scene: Phaser.Scene, myId: string) {
    this.scene = scene;
    this.myId = myId;
    this.container = scene.add
      .container(0, 0)
      .setDepth(DesignTokens.depth.overlay)
      .setScrollFactor(0)
      .setVisible(false);
    this.tracker = new TweenTracker(scene);
    if (scene.input.keyboard) {
      this.escKey = scene.input.keyboard.addKey('ESC');
    }
  }

  get isVisible(): boolean {
    return this._visible;
  }

  // -----------------------------------------------------------------------
  // Show Results — matchEnd mode
  // -----------------------------------------------------------------------

  show(
    placements: PlacementData[],
    winnerName: string,
    onDismiss: () => void,
    designation?: string,
  ): void;
  // -----------------------------------------------------------------------
  // Show Results — death mode
  // -----------------------------------------------------------------------
  show(
    placements: PlacementData[],
    winnerName: string,
    onDismiss: () => void,
    mode: 'death',
    deathInfo?: DeathInfo,
  ): void;
  // -----------------------------------------------------------------------
  // Implementation
  // -----------------------------------------------------------------------
  show(
    placements: PlacementData[],
    winnerName: string,
    onDismiss: () => void,
    modeOrDesignation?: 'death' | string,
    deathInfo?: DeathInfo,
  ): void {
    this.clear();
    const isDeathMode = modeOrDesignation === 'death';
    // Map-redesign ticket 03 (DEC-010) — the map designation line under the
    // header ("RINGROAD • SPIRE • 63"), so results are memorable per match.
    const designation =
      typeof modeOrDesignation === 'string' && modeOrDesignation !== 'death'
        ? modeOrDesignation
        : undefined;
    this.mode = isDeathMode ? 'death' : 'matchEnd';
    this._visible = true;
    this.scrollOffset = 0;

    if (isDeathMode && deathInfo) {
      this.onDismiss = deathInfo.onReturnToTitle;
    } else {
      this.onDismiss = onDismiss;
    }

    const w = this.scene.scale.width;
    const h = this.scene.scale.height;

    // --- Dark overlay ---
    this.bgOverlay = this.scene.add.rectangle(
      w / 2,
      h / 2,
      w,
      h,
      DesignTokens.colors.black,
      DesignTokens.alpha.semiOverlay,
    );
    this.container.add(this.bgOverlay);

    // --- Header ---
    const headerText = isDeathMode ? 'ELIMINATED' : 'MATCH RESULTS';
    const headerColor = isDeathMode ? DesignTokens.colors.gold : DesignTokens.colors.ink;

    this.headerLabel = new Label(this.scene, w / 2, 40, {
      text: headerText,
      variant: 'title',
      color: headerColor,
      align: 'center',
    });
    this.headerLabel.setDepth(DesignTokens.depth.overlay + 1);
    const ht = this.headerLabel.getAt(0) as Phaser.GameObjects.Text;
    ht.setOrigin(0.5, 0.5);
    this.container.add(this.headerLabel);

    // --- Entrance animation for header ---
    playPopInAnimation(this.scene, this.tracker, this.headerLabel, () => !!this.headerLabel);

    // --- Map designation line (ticket 03 / DEC-010) — small centered line
    //     directly under the header; one line, never displacing the table.
    let tableY = 90;
    if (designation) {
      const designationLabel = new Label(this.scene, w / 2, 66, {
        text: designation,
        variant: 'caption',
        color: DesignTokens.colors.lighterGray,
        align: 'center',
        stroke: true,
      });
      designationLabel.setDepth(DesignTokens.depth.overlay + 1);
      const dtext = designationLabel.getAt(0) as Phaser.GameObjects.Text;
      dtext.setOrigin(0.5, 0.5);
      this.container.add(designationLabel);
    }

    // --- Winner announcement (matchEnd mode only) ---
    if (!isDeathMode) {
      this.winnerLabel = new Label(this.scene, w / 2, 90, {
        text: `${winnerName} WINS!`,
        variant: 'title',
        color: DesignTokens.colors.gold,
        align: 'center',
      });
      this.winnerLabel.setDepth(DesignTokens.depth.overlay + 1);
      const wt = this.winnerLabel.getAt(0) as Phaser.GameObjects.Text;
      wt.setOrigin(0.5, 0.5);
      this.container.add(this.winnerLabel);

      this.winnerLabel.setScale(0);
      playPopInAnimation(this.scene, this.tracker, this.winnerLabel, () => !!this.winnerLabel);
      tableY = 140;
    }

    // --- Death mode: subtitle with alive count ---
    if (isDeathMode && deathInfo) {
      const subtitleLabel = new Label(this.scene, w / 2, 90, {
        text: `#${deathInfo.aliveCount} remaining  ·  Kills: ${deathInfo.killCount}  ·  ${this.formatTime(deathInfo.matchTimerMs)}`,
        variant: 'subtitle',
        color: DesignTokens.colors.lighterGray,
        align: 'center',
        stroke: true,
      });
      subtitleLabel.setDepth(DesignTokens.depth.overlay + 1);
      const st = subtitleLabel.getAt(0) as Phaser.GameObjects.Text;
      st.setOrigin(0.5, 0.5);
      this.container.add(subtitleLabel);
      tableY = 140;
    }

    // --- Table header row ---
    const tableX = (w - TABLE_WIDTH) / 2;
    this.tableBaseY = tableY;

    this.headerRow = this.createRow(
      tableX,
      tableY,
      ['#', 'Name', 'Kills', 'Dmg Dealt', 'Dmg Taken', 'Survival', 'Weapons'],
      DesignTokens.colors.darkerGray,
      1,
      DesignTokens.colors.lighterGray,
    );
    this.container.add(this.headerRow);

    // --- Data rows ---
    const sorted = [...placements].sort((a, b) => a.placement - b.placement);
    this.totalRows = sorted.length;
    const rc = ComponentConfig.results;

    for (const p of sorted) {
      const texts = [
        `#${p.placement}`,
        p.name,
        String(p.kills),
        String(p.damageDealt),
        String(p.damageTaken),
        this.formatTime(p.survivalTimeMs),
        String(p.weaponsUsed),
      ];

      let bgColor: number = DesignTokens.colors.nearBlack;
      let bgAlpha: number = rc.rowAlpha;
      if (p.placement === 1) {
        bgColor = DesignTokens.colors.gold;
        bgAlpha = rc.medalAlpha;
      } else if (p.placement === 2) {
        bgColor = DesignTokens.colors.silver;
        bgAlpha = rc.medalAlpha;
      } else if (p.placement === 3) {
        bgColor = DesignTokens.colors.bronze;
        bgAlpha = rc.medalAlpha;
      }

      const isMe = p.playerId === this.myId;
      if (isMe) {
        bgColor = DesignTokens.colors.highlightGreen;
        bgAlpha = rc.highlightAlpha;
      }

      const row = this.createRow(
        tableX,
        tableY + (this.dataRows.length + 1) * ROW_HEIGHT,
        texts,
        bgColor,
        bgAlpha,
        isMe ? DesignTokens.colors.highlightGreen : DesignTokens.colors.ink,
      );
      this.dataRows.push(row);
      this.container.add(row);
    }

    this.updateRowVisibility();

    // --- Auto-scroll for large tables ---
    if (this.totalRows > MAX_VISIBLE) {
      this.autoScrollTimer = this.scene.time.addEvent({
        delay: 2000,
        callback: () => {
          const maxOffset = this.totalRows - MAX_VISIBLE;
          if (this.scrollOffset < maxOffset) {
            this.scrollOffset++;
            this.updateRowVisibility();
          }
        },
        loop: true,
      });
    }

    // --- Buttons ---
    const buttonsResult = createResultsButtons(
      this.scene,
      isDeathMode,
      deathInfo,
      this.container,
      w,
      h,
      () => this.dismiss(),
      () => this.hide(),
    );
    this.returnButton = buttonsResult.returnButton;
    this.spectateButton = buttonsResult.spectateButton;
    this.dismissTimer = buttonsResult.dismissTimer;

    // --- Fade in container ---
    this.container.setAlpha(0);
    this.container.setVisible(true);
    const fadeIn = this.scene.tweens.add({
      targets: this.container,
      alpha: 1,
      duration: DesignTokens.duration.smooth,
      ease: DesignTokens.easing.sineOut,
    });
    this.tracker.track(fadeIn);
  }

  // -----------------------------------------------------------------------
  // Hide / Update
  // -----------------------------------------------------------------------

  hide(): void {
    this._visible = false;
    this.container.setVisible(false);
    this.clear();
  }

  update(_delta: number): void {
    if (!this._visible) return;
    if (this.escKey && Phaser.Input.Keyboard.JustDown(this.escKey)) {
      if (this.mode === 'death') {
        this.hide();
      } else {
        this.dismiss();
      }
    }
  }

  handleScroll(deltaY: number): void {
    if (!this._visible) return;
    const maxOffset = Math.max(0, this.totalRows - MAX_VISIBLE);
    if (deltaY > 0 && this.scrollOffset < maxOffset) {
      this.scrollOffset = Math.min(this.scrollOffset + 1, maxOffset);
      this.updateRowVisibility();
    } else if (deltaY < 0 && this.scrollOffset > 0) {
      this.scrollOffset = Math.max(this.scrollOffset - 1, 0);
      this.updateRowVisibility();
    }
  }

  // -----------------------------------------------------------------------
  // Row Construction
  // -----------------------------------------------------------------------

  private createRow(
    x: number,
    y: number,
    texts: string[],
    bgColor: number,
    bgAlpha: number,
    textColor: number,
  ): Phaser.GameObjects.Container {
    return createResultsRow(this.scene, x, y, texts, bgColor, bgAlpha, textColor);
  }

  private updateRowVisibility(): void {
    for (let i = 0; i < this.dataRows.length; i++) {
      const row = this.dataRows[i]!;
      const visible = i >= this.scrollOffset && i < this.scrollOffset + MAX_VISIBLE;
      row.setVisible(visible);
      if (visible) {
        row.setPosition(row.x, this.tableBaseY + (i - this.scrollOffset + 1) * ROW_HEIGHT);
      }
    }
  }

  private formatTime(seconds: number): string {
    return formatResultsTime(seconds);
  }

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------

  private dismiss(): void {
    const cb = this.onDismiss;
    this.hide();
    cb?.();
  }

  private clear(): void {
    this.tracker.dispose();
    this.container.removeAll(true);
    this.headerLabel = null;
    this.winnerLabel = null;
    this.headerRow = null;
    this.bgOverlay = null;
    this.dataRows = [];
    this.returnButton = null;
    this.spectateButton = null;
    if (this.autoScrollTimer) {
      this.autoScrollTimer.remove();
      this.autoScrollTimer = null;
    }
    if (this.dismissTimer) {
      this.dismissTimer.remove();
      this.dismissTimer = null;
    }
    this.onDismiss = null;
  }

  destroy(): void {
    this.tracker.dispose();
    this.clear();
    this.container.destroy();
  }
}
