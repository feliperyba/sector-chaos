/**
 * Component Config — Sizing and spacing constants for specific UI components.
 *
 * Button sizes, panel padding, bar heights, touch targets, etc.
 * All values reference DesignTokens where applicable.
 *
 * @see DesignTokens.ts for base tokens
 * @see Issue #27
 */

import { spacing, nineSliceInsets } from './DesignTokens.js';

// ---------------------------------------------------------------------------
// Button Config
// ---------------------------------------------------------------------------

export const buttonConfig = {
  /** Primary action button — JOIN, START */
  primary: {
    width: 280,
    height: 64,
    sliceInset: nineSliceInsets.small,
    /** Hover scale multiplier */
    hoverScale: 1.05,
    /** Click scale multiplier */
    clickScale: 0.95,
    /** Gap between stacked buttons */
    gap: spacing.xxxl,
  },
} as const;

// ---------------------------------------------------------------------------
// Panel Config
// ---------------------------------------------------------------------------

export const panelConfig = {
  /** Standard content panel */
  standard: {
    padding: spacing.xl,
    cornerRadius: nineSliceInsets.small,
  },
  /** HUD panel background */
  hud: {
    padding: spacing.sm,
  },
} as const;

// ---------------------------------------------------------------------------
// Health Bar Config
// ---------------------------------------------------------------------------

export const healthBarConfig = {
  width: 220,
  height: 22,
  borderWidth: 2,
  get bgWidth(): number {
    return this.width + this.borderWidth * 2;
  },
  get bgHeight(): number {
    return this.height + this.borderWidth * 2;
  },
  offsetX: 20,
  offsetY: 20,
  midThreshold: 0.5,
  lowThreshold: 0.3,
} as const;

// ---------------------------------------------------------------------------
// Durability Bar Config
// ---------------------------------------------------------------------------

export const durabilityBarConfig = {
  width: 56,
  height: 4,
  /** Threshold for green → yellow */
  midThreshold: 0.5,
  /** Threshold for yellow → red */
  lowThreshold: 0.25,
} as const;

// ---------------------------------------------------------------------------
// Dash Bar Config
// ---------------------------------------------------------------------------

export const dashBarConfig = {
  width: 220,
  height: 14,
} as const;

// ---------------------------------------------------------------------------
// Inventory Slot Config
// ---------------------------------------------------------------------------

export const slotConfig = {
  size: 64,
  gap: spacing.lg,
  activeBorderWidth: 2,
  count: 4,
} as const;

// ---------------------------------------------------------------------------
// Minimap Config
// ---------------------------------------------------------------------------

export const minimapConfig = {
  /** Minimap display size (square) */
  size: 200,
  /** Border stroke width */
  borderWidth: 2,
  /** Corner offset from screen edge */
  offsetX: 20,
  offsetY: 20,
} as const;

// ---------------------------------------------------------------------------
// Spectator HUD Config
// ---------------------------------------------------------------------------

export const spectatorConfig = {
  /** Width of the spectator HUD bar */
  width: 340,
  /** Height of the spectator HUD bar */
  height: 80,
  /** Health bar inside spectator HUD */
  healthBar: {
    width: 200,
    height: 12,
  },
  /** Slot size inside spectator HUD */
  slotSize: 32,
  /** Slot gap */
  slotGap: spacing.massive,
} as const;

// ---------------------------------------------------------------------------
// Results Screen Config
// ---------------------------------------------------------------------------

export const resultsConfig = {
  /** Row background alpha for non-highlighted rows */
  rowAlpha: 0.5,
  /** Row background alpha for highlighted (player's) row */
  highlightAlpha: 0.15,
  /** Medal highlight alpha */
  medalAlpha: 0.1,
} as const;

// ---------------------------------------------------------------------------
// Composite Component Config Object
// ---------------------------------------------------------------------------

/** All component config in a single frozen object. */
export const ComponentConfig = {
  button: buttonConfig,
  panel: panelConfig,
  healthBar: healthBarConfig,
  durabilityBar: durabilityBarConfig,
  dashBar: dashBarConfig,
  slot: slotConfig,
  minimap: minimapConfig,
  spectator: spectatorConfig,
  results: resultsConfig,
} as const;
