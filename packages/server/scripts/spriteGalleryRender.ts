/**
 * Rendering helpers for the sprite-faithful gallery (dev-only).
 *
 * Pure, dependency-free functions that turn an {@link EnrichedMapData} (the full
 * SeedMapAdapter pipeline output) into:
 *  - a sprite-path-coloured SVG thumbnail for the contact sheet (Output A),
 *  - a PNG-based per-cell composite for the detail page (Output B),
 *  - a colour legend, and per-seed stat summaries.
 *
 * The KEY difference from the legacy gallery: cells are coloured by the resolved
 * sprite imagePath (the topmost non-empty visual layer's art), NOT by TileType,
 * so the full visual variety the player sees becomes legible at a glance.
 */
import {
  TileType,
  buildCompositeGrid,
  SECTOR_TILE_SIZE,
  TILE_PIXEL_SIZE,
  type MapData,
  type EnrichedMapData,
  type TiledMapLayer,
  type TileVisual,
} from '@sector-battle/shared';
import {
  SPRITE_COLOURS,
  FAMILY_LABELS,
  FAMILY_ORDER,
  VOID_COLOUR,
  FALLBACK_COLOUR,
  colourForImagePath,
  type ColourFamily,
} from './spriteGalleryColors.js';

/**
 * Layer priority for the topmost-wins flatten. Matches the load-bearing order
 * documented in SeedMapAdapter: interactive > walls > decoration > floor.
 */
const LAYER_PRIORITY = ['interactive_layer', 'map_border_walls', 'decoration', 'floor'] as const;

/** Marker categories overlaid on the grid, with colour + glyph. */
export const MARKER_STYLES = {
  spawn: { color: '#39d353', label: 'spawn' },
  chest: { color: '#ffd700', label: 'chest' },
  exit: { color: '#00e5ff', label: 'exit' },
  weapon: { color: '#ff5cf0', label: 'weapon spawn' },
} as const;

/** Per-seed statistics summarised under each thumbnail + on stdout. */
export interface SeedStats {
  seed: number;
  openSpacePct: number;
  spawnCount: number;
  chestCount: number;
  weaponSpawnCount: number;
  lootCount: number;
}

/** One rendered contact-sheet cell. */
export interface SpriteGalleryCell {
  svg: string;
  stats: SeedStats;
}

/** Index the visual layers of an enriched map by name for fast lookup. */
function indexLayers(enriched: EnrichedMapData): Map<string, TiledMapLayer> {
  const layers = new Map<string, TiledMapLayer>();
  for (const l of enriched.visualLayers) layers.set(l.name, l);
  return layers;
}

/** Flatten the 4 visual layers into one grid of resolved sprite imagePaths;
 *  topmost non-null (spriteId >= 0) cell wins, in LAYER_PRIORITY order. */
export function flattenLayers(enriched: EnrichedMapData): (string | null)[][] {
  const layers = indexLayers(enriched);
  const result: (string | null)[][] = [];
  for (let r = 0; r < enriched.height; r++) {
    const row: (string | null)[] = [];
    for (let c = 0; c < enriched.width; c++) {
      let imagePath: string | null = null;
      for (const name of LAYER_PRIORITY) {
        const layer = layers.get(name);
        const cell = layer?.cells[r]?.[c];
        if (cell && cell.spriteId >= 0) {
          const sprite = enriched.atlas.sprites[cell.spriteId];
          if (sprite) {
            imagePath = sprite.imagePath;
            break;
          }
        }
      }
      row.push(imagePath);
    }
    result.push(row);
  }
  return result;
}

/** Collect the distinct imagePaths present in a flattened grid (for legend annotation). */
export function collectPresentPaths(flattened: (string | null)[][]): Set<string> {
  const present = new Set<string>();
  for (const row of flattened) {
    for (const ip of row) if (ip) present.add(ip);
  }
  return present;
}

/** Compute the per-seed stat summary (reimplemented — no sibling-script dependency). */
export function computeStats(map: MapData): SeedStats {
  const grid = buildCompositeGrid(map.sectors);
  let empty = 0;
  let total = 0;
  for (const row of grid) {
    for (const tile of row) {
      total++;
      if (tile === TileType.EMPTY) empty++;
    }
  }
  const chestCount = map.lootPlacements.filter((l) => l.type === 'CHEST').length;
  const weaponSpawnCount = map.lootPlacements.filter((l) => l.type === 'WEAPON_SPAWN').length;
  return {
    seed: map.seed,
    openSpacePct: total === 0 ? 0 : (empty / total) * 100,
    spawnCount: map.spawnPoints.length,
    chestCount,
    weaponSpawnCount,
    lootCount: map.lootPlacements.length,
  };
}

/** Format a SeedStats as a single stdout / caption line. */
export function formatStatLine(stats: SeedStats): string {
  const pct = stats.openSpacePct.toFixed(1);
  return (
    `seed ${stats.seed}: open ${pct}% | spawns ${stats.spawnCount} | ` +
    `chests ${stats.chestCount} | weaponSpawns ${stats.weaponSpawnCount} | loot ${stats.lootCount}`
  );
}

/** Convert a world-pixel position to a composite-grid tile coordinate. */
function toTile(pos: { x: number; y: number }): { col: number; row: number } {
  return {
    col: Math.floor(pos.x / TILE_PIXEL_SIZE),
    row: Math.floor(pos.y / TILE_PIXEL_SIZE),
  };
}

/** Render one map to a sprite-path-coloured SVG thumbnail (Output A): each cell
 *  filled by its resolved imagePath colour, sector-grid lines, and markers. */
export function renderContactSvg(
  flattened: (string | null)[][],
  map: MapData,
  tilePx: number,
): string {
  const sideTiles = flattened.length;
  const sidePx = sideTiles * tilePx;
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${sidePx} ${sidePx}" ` +
      `width="${sidePx}" height="${sidePx}" shape-rendering="crispEdges">`,
  );

  for (let r = 0; r < sideTiles; r++) {
    const row = flattened[r]!;
    for (let c = 0; c < row.length; c++) {
      const ip = row[c];
      const color = ip ? colourForImagePath(ip) : VOID_COLOUR;
      parts.push(
        `<rect x="${c * tilePx}" y="${r * tilePx}" width="${tilePx}" height="${tilePx}" fill="${color}"/>`,
      );
    }
  }

  // Faint sector-grid lines (every SECTOR_TILE_SIZE tiles).
  const sectorsPerSide = sideTiles / SECTOR_TILE_SIZE;
  for (let s = 0; s <= sectorsPerSide; s++) {
    const p = s * SECTOR_TILE_SIZE * tilePx;
    parts.push(
      `<line x1="${p}" y1="0" x2="${p}" y2="${sidePx}" stroke="#7fb0ff" stroke-opacity="0.35" stroke-width="1"/>`,
    );
    parts.push(
      `<line x1="0" y1="${p}" x2="${sidePx}" y2="${p}" stroke="#7fb0ff" stroke-opacity="0.35" stroke-width="1"/>`,
    );
  }

  const marker = (pos: { x: number; y: number }, color: string) => {
    const { col, row } = toTile(pos);
    const cx = col * tilePx + tilePx / 2;
    const cy = row * tilePx + tilePx / 2;
    const radius = Math.max(1.4, tilePx * 0.42);
    parts.push(
      `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="${color}" stroke="#000" stroke-opacity="0.5" stroke-width="0.5"/>`,
    );
  };
  for (const loot of map.lootPlacements) {
    if (loot.type === 'CHEST') marker(loot.position, MARKER_STYLES.chest.color);
    else if (loot.type === 'WEAPON_SPAWN') marker(loot.position, MARKER_STYLES.weapon.color);
  }
  for (const exit of map.exits) marker(exit.position, MARKER_STYLES.exit.color);
  for (const spawn of map.spawnPoints)
    marker({ x: spawn.x, y: spawn.y }, MARKER_STYLES.spawn.color);

  parts.push('</svg>');
  return parts.join('');
}

/** Escape the characters unsafe in HTML text/attributes. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Build the colour legend grouped by family. Present imagePaths are marked (●)
 *  so realised variety stands out from future-only entries. */
export function buildColourLegendHtml(present: Set<string>): string {
  const sections = FAMILY_ORDER.map((family: ColourFamily) => {
    const entries = SPRITE_COLOURS.filter((e) => e.family === family);
    const items = entries
      .map((e) => {
        const seen = present.has(e.imagePath);
        const dot = seen ? '<span class="seen">●</span>' : '<span class="unseen">○</span>';
        return (
          `<span class="legend-item"><span class="swatch" style="background:${e.colour}"></span>` +
          `${dot}${escapeHtml(e.imagePath)}</span>`
        );
      })
      .join('');
    return `<div class="legend"><strong>${escapeHtml(FAMILY_LABELS[family])}:</strong> ${items}</div>`;
  });
  const fallback =
    `<div class="legend"><strong>Other:</strong>` +
    `<span class="legend-item"><span class="swatch" style="background:${FALLBACK_COLOUR}"></span>unknown sprite</span>` +
    `<span class="legend-item"><span class="swatch" style="background:${VOID_COLOUR}"></span>void (no sprite)</span></div>`;
  return sections.join('\n') + '\n' + fallback;
}

/** Assemble the full self-contained contact-sheet HTML document (Output A). */
export function buildContactHtml(
  cells: SpriteGalleryCell[],
  legendHtml: string,
  title: string,
): string {
  const cellHtml = cells
    .map(
      (cell) =>
        `<figure class="cell">${cell.svg}` +
        `<figcaption><div class="stat">${escapeHtml(formatStatLine(cell.stats))}</div></figcaption></figure>`,
    )
    .join('\n');
  const markerLegend = Object.values(MARKER_STYLES)
    .map(
      (m) =>
        `<span class="legend-item"><span class="dot" style="background:${m.color}"></span>${escapeHtml(m.label)}</span>`,
    )
    .join('');
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
  h2 { font-size: 13px; margin: 16px 0 4px; color: #8b949e; }
  .legend { margin: 4px 0; font-size: 11px; line-height: 1.9; }
  .legend-item { display: inline-flex; align-items: center; margin-right: 10px; white-space: nowrap; }
  .swatch { display: inline-block; width: 12px; height: 12px; margin-right: 4px;
    border: 1px solid #30363d; }
  .seen { color: #39d353; margin: 0 2px; font-size: 9px; }
  .unseen { color: #484f58; margin: 0 2px; font-size: 9px; }
  .dot { display: inline-block; width: 10px; height: 10px; margin-right: 4px;
    border-radius: 50%; border: 1px solid #000; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px;
    margin-top: 12px; }
  .cell { margin: 0; background: #161b22; border: 1px solid #30363d; border-radius: 6px;
    padding: 8px; }
  .cell svg { width: 100%; height: auto; display: block; image-rendering: pixelated;
    border: 1px solid #30363d; }
  figcaption { margin-top: 6px; }
  .stat { font-size: 10px; color: #8b949e; word-break: break-word; }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
${legendHtml}
<div class="legend"><strong>Markers:</strong> ${markerLegend}</div>
<div class="legend">● = sprite present in these maps &nbsp; ○ = defined for future use</div>
<div class="grid">
${cellHtml}
</div>
</body>
</html>
`;
}

/** Resolve the relative PNG URL for a sprite imagePath from the detail file. */
function pngUrlFor(imagePath: string): string {
  // Weapons live under Items/; everything else under environment/.
  if (imagePath.startsWith('weapon_') || imagePath.startsWith('shield_')) {
    return `../../game-assets/Items/${imagePath}.png`;
  }
  return `../../game-assets/environment/${imagePath}.png`;
}

/** Render one map as a PNG-based HTML composite (Output B): each non-null cell
 *  in each layer becomes a positioned div, composited floor→decoration→walls→
 *  interactive z-order, with rotation/flip transforms (transform-origin: center). */
export function renderPngDetailSection(
  enriched: EnrichedMapData,
  map: MapData,
  tilePx: number,
): string {
  const layers = indexLayers(enriched);
  const sidePx = enriched.width * tilePx;
  const cellDivs: string[] = [];

  for (const layerName of ['floor', 'decoration', 'map_border_walls', 'interactive_layer']) {
    const layer = layers.get(layerName);
    if (!layer) continue;
    const z =
      layerName === 'floor'
        ? 1
        : layerName === 'decoration'
          ? 2
          : layerName === 'map_border_walls'
            ? 3
            : 4;
    for (let r = 0; r < enriched.height; r++) {
      const row = layer.cells[r];
      if (!row) continue;
      for (let c = 0; c < enriched.width; c++) {
        const cell: TileVisual | null = row[c] ?? null;
        if (!cell || cell.spriteId < 0) continue;
        const sprite = enriched.atlas.sprites[cell.spriteId];
        if (!sprite) continue;
        const url = pngUrlFor(sprite.imagePath);
        const sx = cell.flipH ? -1 : 1;
        const sy = cell.flipV ? -1 : 1;
        const transform = `rotate(${cell.rotation}deg) scaleX(${sx}) scaleY(${sy})`;
        cellDivs.push(
          `<div style="position:absolute;left:${c * tilePx}px;top:${r * tilePx}px;` +
            `width:${tilePx}px;height:${tilePx}px;z-index:${z};` +
            `background-image:url('${url}');background-size:100% 100%;` +
            `transform:${transform};transform-origin:center;` +
            `image-rendering:pixelated"></div>`,
        );
      }
    }
  }

  // Faint sector grid overlay (drawn above tiles, below markers).
  const gridLines: string[] = [];
  const sectorsPerSide = enriched.width / SECTOR_TILE_SIZE;
  for (let s = 0; s <= sectorsPerSide; s++) {
    const p = s * SECTOR_TILE_SIZE * tilePx;
    gridLines.push(
      `<div style="position:absolute;left:${p}px;top:0;width:1px;height:${sidePx}px;background:#7fb0ff;opacity:0.25;z-index:5"></div>`,
    );
    gridLines.push(
      `<div style="position:absolute;left:0;top:${p}px;width:${sidePx}px;height:1px;background:#7fb0ff;opacity:0.25;z-index:5"></div>`,
    );
  }

  // Markers (highest z so they sit above the composited tiles).
  const markers: string[] = [];
  const addMarker = (pos: { x: number; y: number }, color: string) => {
    const { col, row } = toTile(pos);
    markers.push(
      `<div style="position:absolute;left:${col * tilePx + tilePx / 2 - tilePx / 3}px;` +
        `top:${row * tilePx + tilePx / 3}px;width:${(tilePx * 2) / 3}px;height:${(tilePx * 2) / 3}px;` +
        `border-radius:50%;background:${color};border:1px solid #000;opacity:0.9;z-index:9"></div>`,
    );
  };
  for (const loot of map.lootPlacements) {
    if (loot.type === 'CHEST') addMarker(loot.position, MARKER_STYLES.chest.color);
    else if (loot.type === 'WEAPON_SPAWN') addMarker(loot.position, MARKER_STYLES.weapon.color);
  }
  for (const exit of map.exits) addMarker(exit.position, MARKER_STYLES.exit.color);
  for (const spawn of map.spawnPoints)
    addMarker({ x: spawn.x, y: spawn.y }, MARKER_STYLES.spawn.color);

  const stats = computeStats(map);
  return (
    `<section class="map-detail"><h2>seed ${enriched.seed} — ${enriched.width}×${enriched.height}</h2>` +
    `<div class="stat">${escapeHtml(formatStatLine(stats))}</div>` +
    `<div class="board" style="position:relative;width:${sidePx}px;height:${sidePx}px;background:${VOID_COLOUR}">` +
    `${cellDivs.join('')}${gridLines.join('')}${markers.join('')}</div></section>`
  );
}

/** Assemble the full PNG-based detail HTML document (Output B). */
export function buildPngDetailHtml(sections: string[], title: string): string {
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
  h1 { font-size: 16px; margin: 0 0 12px; }
  .map-detail { margin: 0 0 24px; }
  h2 { font-size: 13px; margin: 0 0 4px; }
  .board { border: 1px solid #30363d; overflow: hidden; }
  .stat { font-size: 10px; color: #8b949e; margin-bottom: 6px; }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
${sections.join('\n')}
</body>
</html>
`;
}
