import Phaser from 'phaser';
import { ComponentConfig } from '../ui/ComponentConfig.js';
import { DesignTokens } from '../ui/DesignTokens.js';
import type { MinimapData } from './MinimapRenderer.js';

/**
 * Sector POI-name label rendering for the local minimap (map-redesign ticket
 * 03), extracted from MinimapRenderer for the 500-line file gate when ticket
 * 04 added landmark icons. Pure positioning/pooling logic — the label pool
 * itself is owned by MinimapRenderer (created once in `create()`).
 */

/** Label slots: current sector + up to 4 orthogonal neighbors. */
export const SECTOR_LABEL_POOL = 5;

/** Current-sector label alpha vs the dimmer adjacent labels. */
export const LABEL_ALPHA_CURRENT = 1;
export const LABEL_ALPHA_ADJACENT = 0.55;

/** Label edge clamp — keeps text inside the minimap frame. */
export const LABEL_CLAMP_PAD = 14;

/** Sector grid is 4x4 (matches SECTOR_GRID_SIZE in shared constants). */
const SECTOR_GRID = 4;

export interface SectorLabelSlot {
  text: Phaser.GameObjects.Text;
  lastString: string;
}

/** Create the pooled sector-label Text objects (one-time, at minimap boot). */
export function createSectorLabelSlots(
  scene: Phaser.Scene,
  mmLeft: number,
  mmTop: number,
): SectorLabelSlot[] {
  const slots: SectorLabelSlot[] = [];
  for (let i = 0; i < SECTOR_LABEL_POOL; i++) {
    const text = scene.add
      .text(mmLeft, mmTop, '', {
        fontSize: '10px',
        fontFamily: DesignTokens.font.family,
        color: '#f2f2f4',
        stroke: '#111118',
        strokeThickness: 3,
        align: 'center',
      })
      .setOrigin(0.5, 0.5)
      .setDepth(DesignTokens.depth.minimapBg + 5)
      .setScrollFactor(0)
      .setAlpha(0);
    slots.push({ text, lastString: '' });
  }
  return slots;
}

/**
 * Position/show the pooled sector-name labels for the player's current +
 * adjacent (orthogonal) sectors. Labels clamp into the minimap frame when a
 * sector is only partially in view; sectors fully outside are skipped. Zero
 * alloc: pooled Text objects, setText only on change.
 */
export function updateSectorLabels(
  scene: Phaser.Scene,
  sectorLabels: SectorLabelSlot[],
  data: MinimapData,
  toMMX: (wx: number) => number,
  toMMY: (wy: number) => number,
): void {
  const names = data.poiNames;
  if (!names || names.length === 0 || data.worldW <= 0) {
    for (const slot of sectorLabels) {
      if (slot.lastString !== '') {
        slot.lastString = '';
        slot.text.setText('');
      }
      slot.text.setAlpha(0);
    }
    return;
  }

  const SIZE = ComponentConfig.minimap.size;
  const sectorPx = data.worldW / SECTOR_GRID;
  const curRow = Math.floor(data.playerY / sectorPx);
  const curCol = Math.floor(data.playerX / sectorPx);

  // Current sector first, then its four orthogonal neighbors.
  const targets: Array<{ row: number; col: number; current: boolean }> = [];
  if (curRow >= 0 && curRow < SECTOR_GRID && curCol >= 0 && curCol < SECTOR_GRID) {
    targets.push({ row: curRow, col: curCol, current: true });
  }
  const ORTHO = [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ] as const;
  for (const [dr, dc] of ORTHO) {
    const row = curRow + dr;
    const col = curCol + dc;
    if (row >= 0 && row < SECTOR_GRID && col >= 0 && col < SECTOR_GRID) {
      targets.push({ row, col, current: false });
    }
  }

  // Recompute the graphics origin (same math as create(): the top-left of
  // the minimap box is (width - offsetX - size/2, offsetY)).
  const mc = ComponentConfig.minimap;
  const mmLeft = scene.scale.width - mc.offsetX - mc.size / 2;
  const mmTop = mc.offsetY;

  let slotIdx = 0;
  for (const { row, col, current } of targets) {
    if (slotIdx >= sectorLabels.length) break;
    const name = names[row]?.[col];
    if (!name) continue;
    // Skip sectors fully outside the local view.
    const x0 = toMMX(col * sectorPx);
    const y0 = toMMY(row * sectorPx);
    const x1 = toMMX((col + 1) * sectorPx);
    const y1 = toMMY((row + 1) * sectorPx);
    if (x1 <= 0 || y1 <= 0 || x0 >= SIZE || y0 >= SIZE) continue;

    const slot = sectorLabels[slotIdx]!;
    slotIdx++;
    if (slot.lastString !== name) {
      slot.lastString = name;
      slot.text.setText(name);
    }
    const cx = Phaser.Math.Clamp((x0 + x1) / 2, LABEL_CLAMP_PAD, SIZE - LABEL_CLAMP_PAD);
    const cy = Phaser.Math.Clamp((y0 + y1) / 2, LABEL_CLAMP_PAD, SIZE - LABEL_CLAMP_PAD);
    slot.text.setPosition(mmLeft + cx, mmTop + cy);
    slot.text.setAlpha(current ? LABEL_ALPHA_CURRENT : LABEL_ALPHA_ADJACENT);
  }
  for (; slotIdx < sectorLabels.length; slotIdx++) {
    const slot = sectorLabels[slotIdx]!;
    if (slot.lastString !== '') {
      slot.lastString = '';
      slot.text.setText('');
    }
    slot.text.setAlpha(0);
  }
}
