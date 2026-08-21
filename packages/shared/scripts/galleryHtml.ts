/**
 * Dev-only HTML assembly for the seed-gallery contact sheet.
 *
 * Builds a single self-contained HTML document (no external assets, no runtime
 * dependency) that lays out per-seed SVG thumbnails as a grid of cells with a
 * tile-colour legend and a marker legend.
 */
import { TileType } from '../src/enums/TileType.js';
import { TILE_COLORS, TILE_LABELS, MARKER_STYLES, formatStatLine } from './galleryRender.js';
import type { SeedStats } from './galleryRender.js';

/** One rendered map cell: its SVG, stats, and the sector type grid label. */
export interface GalleryCell {
  svg: string;
  stats: SeedStats;
  typeSummary: string;
}

/**
 * Escape the handful of characters that are unsafe in HTML text/attributes.
 *
 * @param value - the raw string
 * @returns the HTML-escaped string
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Build the tile-colour legend row.
 *
 * @returns an HTML fragment listing each tile type and its colour swatch
 */
function buildTileLegend(): string {
  const items = (Object.keys(TILE_LABELS) as unknown[] as TileType[]).map((t) => {
    const tile = Number(t) as TileType;
    return (
      `<span class="legend-item"><span class="swatch" style="background:${TILE_COLORS[tile]}"></span>` +
      `${escapeHtml(TILE_LABELS[tile])}</span>`
    );
  });
  return `<div class="legend"><strong>Tiles:</strong> ${items.join('')}</div>`;
}

/**
 * Build the marker legend row.
 *
 * @returns an HTML fragment listing each marker category and its colour
 */
function buildMarkerLegend(): string {
  const items = Object.values(MARKER_STYLES).map(
    (m) =>
      `<span class="legend-item"><span class="dot" style="background:${m.color}"></span>${escapeHtml(m.label)}</span>`,
  );
  return `<div class="legend"><strong>Markers:</strong> ${items.join('')}</div>`;
}

/**
 * Build one gallery cell (thumbnail + stat line + sector-type summary).
 *
 * @param cell - the rendered cell data
 * @returns an HTML fragment for a single contact-sheet cell
 */
function buildCell(cell: GalleryCell): string {
  return (
    `<figure class="cell">${cell.svg}` +
    `<figcaption><div class="stat">${escapeHtml(formatStatLine(cell.stats))}</div>` +
    `<div class="types">${escapeHtml(cell.typeSummary)}</div></figcaption></figure>`
  );
}

/**
 * Assemble the full self-contained contact-sheet HTML document.
 *
 * @param cells - the rendered per-seed cells, in display order
 * @param title - the page title / heading
 * @returns a complete HTML document string
 */
export function buildGalleryHtml(cells: GalleryCell[], title: string): string {
  const cellHtml = cells.map(buildCell).join('\n');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 16px; background: #0d1117; color: #c9d1d9;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  h1 { font-size: 16px; margin: 0 0 8px; }
  .legend { margin: 4px 0; font-size: 11px; line-height: 1.8; }
  .legend-item { display: inline-flex; align-items: center; margin-right: 12px; white-space: nowrap; }
  .swatch { display: inline-block; width: 12px; height: 12px; margin-right: 4px;
    border: 1px solid #30363d; }
  .dot { display: inline-block; width: 10px; height: 10px; margin-right: 4px;
    border-radius: 50%; border: 1px solid #000; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px;
    margin-top: 12px; }
  .cell { margin: 0; background: #161b22; border: 1px solid #30363d; border-radius: 6px;
    padding: 8px; }
  .cell svg { width: 100%; height: auto; display: block; image-rendering: pixelated;
    border: 1px solid #30363d; }
  figcaption { margin-top: 6px; }
  .stat { font-size: 10px; color: #8b949e; word-break: break-word; }
  .types { font-size: 9px; color: #6e7681; margin-top: 2px; word-break: break-word; }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
${buildTileLegend()}
${buildMarkerLegend()}
<div class="grid">
${cellHtml}
</div>
</body>
</html>
`;
}
