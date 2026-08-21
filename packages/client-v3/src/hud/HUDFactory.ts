/**
 * HUDFactory — constructs all HUD visual components.
 *
 * Design principles (from research):
 * - NO backing panels — bars/slots stand alone with dark tracks only
 * - Minimal elements — every pixel earns its place
 * - Lower position — closer to screen edge
 * - Health + Dash side by side at bottom; weapon slots above
 */
import Phaser from 'phaser';
import { DesignTokens } from '../ui/DesignTokens.js';
import { ComponentConfig } from '../ui/ComponentConfig.js';
import { Label } from '../ui/components/Label.js';
import { ProgressBar } from '../ui/components/ProgressBar.js';
import { TweenTracker } from '../ui/animations/TweenTracker.js';

export interface HUDComponents {
  healthBar: ProgressBar;
  healthLabel: Label;
  dashBar: ProgressBar;
  dashLabel: Label;
  timerLabel: Label;
  phaseLabel: Label;
  aliveLabel: Label;
  statusLabel: Label;
  interactionLabel: Label;
  slotBgs: Phaser.GameObjects.NineSlice[];
  slotBorders: Phaser.GameObjects.NineSlice[];
  slotIcons: (Phaser.GameObjects.Sprite | null)[];
  durabilityBars: ProgressBar[];
  durabilityLabels: Label[];
  slotKeyLabels: Label[];
  hpY: number;
  slotY: number;
  healthX: number;
  healthLeft: number;
  healthWidth: number;
  slotStartX: number;
}

export function createHUDComponents(scene: Phaser.Scene, _tracker: TweenTracker): HUDComponents {
  const { width, height } = scene.scale;
  const hb = ComponentConfig.healthBar;
  const db = ComponentConfig.dashBar;
  const sc = ComponentConfig.slot;

  // Stacked vertical layout — lower position near screen edge
  const bottomMargin = DesignTokens.spacing.sm;
  const barGap = DesignTokens.spacing.sm;
  const dashY = height - bottomMargin - db.height / 2;
  const hpY = dashY - db.height / 2 - barGap - hb.height / 2;
  const slotY = hpY - hb.height / 2 - DesignTokens.spacing.lg - sc.size / 2;

  const cx = width / 2;
  const healthX = cx - hb.width / 2;
  const healthLeft = healthX;

  const slotClusterW = sc.count * sc.size + (sc.count - 1) * sc.gap;
  const slotStartX = cx - slotClusterW / 2 + sc.size / 2;

  // --- Health bar (top, wider) ---
  const healthBar = new ProgressBar(scene, healthX, hpY, {
    width: hb.width,
    height: hb.height,
    fillColor: DesignTokens.colors.positive,
    trackColor: DesignTokens.colors.nearBlack,
    animated: true,
    gradient: true,
    ghostBar: true,
    flashOnDamage: true,
    lowHealthThreshold: 0.25,
    segments: true,
    cornerRadius: 4,
  });
  healthBar.setDepth(DesignTokens.depth.hudContent);
  healthBar.setScrollFactor(0);
  healthBar.setRatio(1, false);

  // --- Health text overlay ---
  const healthLabel = new Label(scene, cx, hpY, {
    text: '100/100',
    variant: 'body',
    color: DesignTokens.colors.ink,
    align: 'center',
    stroke: true,
  });
  healthLabel.setDepth(DesignTokens.depth.hudContent + 2);
  healthLabel.setScrollFactor(0);
  const hlText = healthLabel.getAt(0) as Phaser.GameObjects.Text;
  hlText.setOrigin(0.5, 0.5);

  // --- Dash bar (below health, same width, thinner) ---
  const dashBar = new ProgressBar(scene, healthX, dashY, {
    width: db.width,
    height: db.height,
    fillColor: DesignTokens.colors.blue,
    trackColor: DesignTokens.colors.nearBlack,
    animated: true,
    cornerRadius: 3,
  });
  dashBar.setDepth(DesignTokens.depth.hudContent);
  dashBar.setScrollFactor(0);
  dashBar.setRatio(1, false);

  // --- Dash text overlay (numeric countdown or READY) ---
  const dashLabel = new Label(scene, cx, dashY, {
    text: 'READY',
    variant: 'caption',
    color: DesignTokens.colors.cyan,
    align: 'center',
    stroke: true,
  });
  dashLabel.setDepth(DesignTokens.depth.hudContent + 2);
  dashLabel.setScrollFactor(0);
  const dlText = dashLabel.getAt(0) as Phaser.GameObjects.Text;
  dlText.setOrigin(0.5, 0.5);

  // --- Inventory slots ---
  const slotBgs: Phaser.GameObjects.NineSlice[] = [];
  const slotBorders: Phaser.GameObjects.NineSlice[] = [];
  const slotIcons: (Phaser.GameObjects.Sprite | null)[] = [];
  const durabilityBars: ProgressBar[] = [];
  const durabilityLabels: Label[] = [];
  const slotKeyLabels: Label[] = [];

  for (let i = 0; i < sc.count; i++) {
    const x = slotStartX + i * (sc.size + sc.gap);

    // Tier border (outer frame)
    const border = scene.add.nineslice(
      x,
      slotY,
      'ui',
      'panel-border',
      sc.size,
      sc.size,
      DesignTokens.nineSlice.panelBorder.left,
      DesignTokens.nineSlice.panelBorder.right,
      DesignTokens.nineSlice.panelBorder.top,
      DesignTokens.nineSlice.panelBorder.bottom,
    );
    border.setTint(DesignTokens.colors.darkestGray);
    border.setAlpha(0);
    border.setDepth(DesignTokens.depth.hudBg + 1);
    border.setScrollFactor(0);
    border.setOrigin(0.5);
    slotBorders.push(border);

    // Slot background
    const bg = scene.add.nineslice(
      x,
      slotY,
      'ui',
      'panel',
      sc.size,
      sc.size,
      DesignTokens.nineSlice.panel.left,
      DesignTokens.nineSlice.panel.right,
      DesignTokens.nineSlice.panel.top,
      DesignTokens.nineSlice.panel.bottom,
    );
    bg.setTint(DesignTokens.colors.nearBlack);
    bg.setDepth(DesignTokens.depth.hudBg);
    bg.setScrollFactor(0);
    bg.setOrigin(0.5);
    slotBgs.push(bg);
    slotIcons.push(null);

    // Durability bar
    const durBar = new ProgressBar(
      scene,
      x - ComponentConfig.durabilityBar.width / 2,
      slotY + sc.size / 2 - DesignTokens.spacing.lg,
      {
        width: ComponentConfig.durabilityBar.width,
        height: ComponentConfig.durabilityBar.height,
        fillColor: DesignTokens.colors.positive,
        trackColor: DesignTokens.colors.darkestGray,
        animated: false,
        gradient: true,
      },
    );
    durBar.setDepth(DesignTokens.depth.hudContent + 1);
    durBar.setScrollFactor(0);
    durBar.setVisible(false);
    durabilityBars.push(durBar);

    const durLabel = new Label(scene, x, slotY + DesignTokens.spacing.md, {
      text: '',
      variant: 'caption',
      color: DesignTokens.colors.lighterGray,
      align: 'center',
      stroke: true,
    });
    durLabel.setDepth(DesignTokens.depth.hudContent + 2);
    durLabel.setScrollFactor(0);
    durLabel.setVisible(false);
    const durText = durLabel.getAt(0) as Phaser.GameObjects.Text;
    durText.setOrigin(0.5, 0.5);
    durabilityLabels.push(durLabel);

    const keyLabel = new Label(
      scene,
      x - sc.size / 2 + DesignTokens.spacing.sm,
      slotY - sc.size / 2 + DesignTokens.spacing.sm,
      {
        text: String(i + 1),
        variant: 'caption',
        color: DesignTokens.colors.lightGray,
        stroke: true,
      },
    );
    keyLabel.setDepth(DesignTokens.depth.hudContent + 2);
    keyLabel.setScrollFactor(0);
    const klt = keyLabel.getAt(0) as Phaser.GameObjects.Text;
    klt.setOrigin(0.5, 0.5);
    slotKeyLabels.push(keyLabel);
  }

  // --- Timer ---
  const timerY = DesignTokens.spacing.huge + DesignTokens.spacing.massive;
  const timerLabel = new Label(scene, width / 2, timerY, {
    text: '00:00',
    variant: 'subtitle',
    color: DesignTokens.colors.ink,
    align: 'center',
    stroke: true,
  });
  timerLabel.setDepth(DesignTokens.depth.hudContent);
  timerLabel.setScrollFactor(0);
  const timerText = timerLabel.getAt(0) as Phaser.GameObjects.Text;
  timerText.setOrigin(0.5, 0.5);

  // --- Phase label ---
  const phaseY = timerY + DesignTokens.font.size.xxl + DesignTokens.spacing.lg;
  const phaseLabel = new Label(scene, width / 2, phaseY, {
    text: '',
    variant: 'body',
    color: DesignTokens.colors.amber,
    align: 'center',
    stroke: true,
  });
  phaseLabel.setDepth(DesignTokens.depth.hudContent);
  phaseLabel.setScrollFactor(0);
  const phaseText = phaseLabel.getAt(0) as Phaser.GameObjects.Text;
  phaseText.setOrigin(0.5, 0.5);

  // --- Alive count ---
  const aliveY = phaseY + DesignTokens.font.size.md + DesignTokens.spacing.md;
  const aliveLabel = new Label(scene, width / 2, aliveY, {
    text: '',
    variant: 'caption',
    color: DesignTokens.colors.lighterGray,
    align: 'center',
    stroke: true,
  });
  aliveLabel.setDepth(DesignTokens.depth.hudContent);
  aliveLabel.setScrollFactor(0);
  const aliveText = aliveLabel.getAt(0) as Phaser.GameObjects.Text;
  aliveText.setOrigin(0.5, 0.5);

  // --- Status text ---
  const statusLabel = new Label(scene, width / 2, height * 0.25, {
    text: '',
    variant: 'subtitle',
    color: DesignTokens.colors.amber,
    align: 'center',
    stroke: true,
  });
  statusLabel.setDepth(DesignTokens.depth.overlay);
  statusLabel.setScrollFactor(0);
  statusLabel.setVisible(false);
  const statusText = statusLabel.getAt(0) as Phaser.GameObjects.Text;
  statusText.setOrigin(0.5, 0.5);

  // --- Interaction prompt ---
  const interactionLabel = new Label(scene, 0, 0, {
    text: '',
    variant: 'body',
    color: DesignTokens.colors.goldenOrange,
    align: 'center',
    stroke: true,
  });
  interactionLabel.setDepth(DesignTokens.depth.floating);
  interactionLabel.setVisible(false);
  const intText = interactionLabel.getAt(0) as Phaser.GameObjects.Text;
  intText.setOrigin(0.5, 0.5);

  return {
    healthBar,
    healthLabel,
    dashBar,
    dashLabel,
    timerLabel,
    phaseLabel,
    aliveLabel,
    statusLabel,
    interactionLabel,
    slotBgs,
    slotBorders,
    slotIcons,
    durabilityBars,
    durabilityLabels,
    slotKeyLabels,
    hpY,
    slotY,
    healthX,
    healthLeft,
    healthWidth: hb.width,
    slotStartX,
  };
}
