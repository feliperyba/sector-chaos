/**
 * Wall continuity GATE (map-polish ticket 13 — supersedes the ticket-12
 * characterization pins).
 *
 * Ticket 12 froze the CURRENT-defective per-seed violation counts
 * (seam 303–346 / interior 51–183 across the standard seed set). With the
 * thick-wall `wall_fill` layer + run-consistent facing landed, those pins are
 * replaced by ZERO-assertions: for the gate seed set
 * {1, 42, 12345, 0xdeadbeef, 999} there is NOT A SINGLE adjacent wall-tile
 * pair without a shared solid edge band — seam or interior — measured through
 * the REAL pipeline (`MapGenerator.generate` → `SeedMapAdapter.adapt` →
 * `map_border_walls` + `wall_fill` → fill-aware `auditWallLayerContinuity`).
 *
 * If this gate ever goes red: a facing/fill rule regressed — do NOT bump the
 * integers back up.
 */

import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { MapGenerator, TileType } from '@sector-battle/shared';
import { SeedMapAdapter } from '../SeedMapAdapter.ts';
import { auditWallLayerContinuity } from './helpers/wallContinuityAudit.ts';

const TILED_DIR = resolve(__dirname, '../../../../../../tiled');
const SEEDS = [1, 42, 12345, 0xdeadbeef, 999] as const;

const generator = new MapGenerator();
const adapter = new SeedMapAdapter();

function adaptSeed(seed: number) {
  return adapter.adapt(generator.generate(seed), seed, TILED_DIR);
}

function auditSeed(seed: number) {
  const enriched = adaptSeed(seed);
  const wallLayer = enriched.visualLayers.find((l) => l.name === 'map_border_walls')!;
  const fillLayer = enriched.visualLayers.find((l) => l.name === 'wall_fill')!;
  return {
    audit: auditWallLayerContinuity(wallLayer.cells, enriched.atlas.sprites, {
      fillCells: fillLayer.cells,
    }),
    enriched,
    fillLayer,
    wallLayer,
  };
}

describe('wall continuity gate — zero violations (ticket 13)', () => {
  for (const seed of SEEDS) {
    it(`seed ${seed}: zero seam AND zero interior continuity violations`, () => {
      const { audit } = auditSeed(seed);
      expect(
        audit.seamCount,
        `seed ${seed} seam violations: ${JSON.stringify(audit.violations.slice(0, 5))}`,
      ).toBe(0);
      expect(
        audit.interiorCount,
        `seed ${seed} interior violations: ${JSON.stringify(audit.violations.slice(0, 5))}`,
      ).toBe(0);
      expect(audit.violations).toEqual([]);
    });
  }
});

describe('wall_fill invariants per gate seed', () => {
  for (const seed of SEEDS) {
    it(`seed ${seed}: fills sit only on indestructible wall tiles and are non-empty`, () => {
      const { enriched, fillLayer } = auditSeed(seed);
      let fillCount = 0;
      for (let r = 0; r < enriched.height; r++) {
        for (let c = 0; c < enriched.width; c++) {
          const cell = fillLayer.cells[r]![c];
          if (!cell) continue;
          fillCount++;
          const tile = enriched.grid[r]![c]!;
          // A destroyed destructible wall must never leave baked fill behind.
          expect(
            tile,
            `fill cell (${r},${c}) sits on ${TileType[tile]} — fills may only cover INDESTRUCTIBLE_WALL`,
          ).toBe(TileType.INDESTRUCTIBLE_WALL);
          // The fill frame must be an EXISTING TileType.EMPTY-typed atlas frame
          // (no collision, skipped by getWallVisualAt/checkCellCollider).
          const def = enriched.atlas.sprites[cell.spriteId]!;
          expect(def.tileType).toBe(TileType.EMPTY);
          expect(cell.rotation).toBe(0);
          expect(cell.flipH).toBe(false);
          expect(cell.flipV).toBe(false);
        }
      }
      // Procedural maps are FULL of 2-thick sector seams — the layer is never empty.
      expect(fillCount).toBeGreaterThan(0);
    });
  }
});

describe('determinism (ADR 0035) — every visual layer', () => {
  it('same seed adapts to byte-identical visualLayers (all layers, incl. wall_fill)', () => {
    const a = adaptSeed(12345);
    const b = adaptSeed(12345);
    expect(a.visualLayers).toHaveLength(b.visualLayers.length);
    for (let l = 0; l < a.visualLayers.length; l++) {
      expect(a.visualLayers[l]!.name).toBe(b.visualLayers[l]!.name);
      expect(JSON.stringify(a.visualLayers[l]!.cells)).toBe(
        JSON.stringify(b.visualLayers[l]!.cells),
      );
    }
  });
});
