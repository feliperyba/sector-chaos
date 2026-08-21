/**
 * Sprite-faithful seed gallery (dev-only).
 *
 * Runs the FULL SeedMapAdapter sprite pipeline across a configurable set of
 * seeds and renders what the game ACTUALLY shows, so map visual quality can be
 * judged — unlike the legacy `map-gallery.ts` which paints one flat colour per
 * TileType and is therefore "structurally blind" to floor biomes, decorations,
 * wall art, and object variety.
 *
 * Outputs two self-contained HTML files (no external runtime deps; the detail
 * page references the game-assets PNGs by relative path):
 *  - `sprite-gallery.html`         — sprite-path-coloured contact sheet (Output A)
 *  - `sprite-gallery-detail.html`  — PNG-based per-cell composite for 1-3 seeds (Output B)
 *
 * Usage (from `packages/server`):
 *   pnpm sprite-gallery                      # 8 seeds starting at 0
 *   pnpm sprite-gallery --seeds 32 --start 100
 *   pnpm sprite-gallery --seed 7             # single seed (full detail render)
 *
 * Deterministic: identical seed lists produce byte-identical output (no
 * Date.now() / Math.random()). This script lives under `scripts/` which is
 * excluded from the server tsconfig `include`, so it is not typechecked by
 * `pnpm typecheck` — verify it runs via `pnpm sprite-gallery`.
 */
import { writeFileSync } from 'node:fs';
import { resolve, join, isAbsolute } from 'node:path';
import process from 'node:process';
import { MapGenerator } from '@sector-battle/shared';
import type { EnrichedMapData, MapData } from '@sector-battle/shared';
import { SeedMapAdapter } from '../src/infrastructure/map/SeedMapAdapter.ts';
import {
  flattenLayers,
  collectPresentPaths,
  computeStats,
  formatStatLine,
  renderContactSvg,
  buildColourLegendHtml,
  buildContactHtml,
  renderPngDetailSection,
  buildPngDetailHtml,
  type SpriteGalleryCell,
} from './spriteGalleryRender.js';

const TILED = resolve(import.meta.dirname, '../../../tiled');

const DEFAULT_SEED_COUNT = 8;
const DEFAULT_START_SEED = 0;
const CONTACT_TILE_PX = 4;
const DETAIL_TILE_PX = 10;
const MAX_DETAIL_SEEDS = 3;
const CONTACT_OUT = 'sprite-gallery.html';
const DETAIL_OUT = 'sprite-gallery-detail.html';

/** Parsed command-line options for the gallery run. */
interface GalleryOptions {
  count: number;
  start: number;
  singleSeed: number | null;
}

/**
 * Parse a `--flag value` style argument list into typed gallery options.
 *
 * @param argv - the raw argument list (typically `process.argv.slice(2)`)
 * @returns the parsed gallery options with defaults applied
 */
function parseArgs(argv: string[]): GalleryOptions {
  const opts: GalleryOptions = {
    count: DEFAULT_SEED_COUNT,
    start: DEFAULT_START_SEED,
    singleSeed: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case '--seeds':
        opts.count = Math.max(1, Number(value) || DEFAULT_SEED_COUNT);
        i++;
        break;
      case '--start':
        opts.start = Number(value) || 0;
        i++;
        break;
      case '--seed':
        opts.singleSeed = Number(value) || 0;
        i++;
        break;
      default:
        break;
    }
  }
  return opts;
}

/** Resolve a relative output path against cwd (parent is the script's own dir). */
function resolveOut(outPath: string): string {
  return isAbsolute(outPath) ? outPath : join(process.cwd(), outPath);
}

/** Result of running the pipeline for one seed. */
interface AdaptedSeed {
  seed: number;
  map: MapData;
  enriched: EnrichedMapData;
}

/**
 * Run the full pipeline (MapGenerator → SeedMapAdapter) for a list of seeds.
 *
 * @param seeds - the seeds to adapt
 * @returns the adapted maps, in input order
 */
function adaptSeeds(seeds: number[]): AdaptedSeed[] {
  const generator = new MapGenerator();
  const adapter = new SeedMapAdapter();
  const out: AdaptedSeed[] = [];
  for (const seed of seeds) {
    const map = generator.generate(seed);
    const enriched = adapter.adapt(map, seed, TILED);
    out.push({ seed, map, enriched });
  }
  return out;
}

/**
 * CLI entry point: parse args, run the pipeline, write both HTML files, and
 * print a per-seed stat line + closing summary.
 */
function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  const seeds =
    opts.singleSeed !== null
      ? [opts.singleSeed]
      : Array.from({ length: opts.count }, (_, i) => opts.start + i);

  const adapted = adaptSeeds(seeds);

  // ── Output A: sprite-path-coloured contact sheet ──────────────────────────
  const cells: SpriteGalleryCell[] = [];
  const present = new Set<string>();
  for (const a of adapted) {
    const flattened = flattenLayers(a.enriched);
    for (const ip of collectPresentPaths(flattened)) present.add(ip);
    const stats = computeStats(a.map);
    // eslint-disable-next-line no-console
    console.log(formatStatLine(stats));
    cells.push({ svg: renderContactSvg(flattened, a.map, CONTACT_TILE_PX), stats });
  }

  const contactTitle =
    opts.singleSeed !== null
      ? `Sprite Gallery — seed ${opts.singleSeed}`
      : `Sprite Gallery — ${cells.length} seeds from ${opts.start}`;
  const contactHtml = buildContactHtml(cells, buildColourLegendHtml(present), contactTitle);
  const contactPath = resolveOut(CONTACT_OUT);
  writeFileSync(contactPath, contactHtml, 'utf8');

  // ── Output B: PNG-based detail for 1-3 seeds ──────────────────────────────
  const detailSeeds =
    opts.singleSeed !== null ? adapted.slice(0, 1) : adapted.slice(0, MAX_DETAIL_SEEDS);
  const detailSections = detailSeeds.map((a) =>
    renderPngDetailSection(a.enriched, a.map, DETAIL_TILE_PX),
  );
  const detailTitle =
    opts.singleSeed !== null
      ? `Sprite Gallery Detail — seed ${opts.singleSeed}`
      : `Sprite Gallery Detail — seeds ${detailSeeds.map((a) => a.seed).join(', ')}`;
  const detailHtml = buildPngDetailHtml(detailSections, detailTitle);
  const detailPath = resolveOut(DETAIL_OUT);
  writeFileSync(detailPath, detailHtml, 'utf8');

  // eslint-disable-next-line no-console
  console.log(
    `\nWrote ${cells.length} map(s) to ${contactPath}\nWrote detail render to ${detailPath}`,
  );
}

main();
