/**
 * Dev-only seed-gallery preview harness.
 *
 * Renders the output of {@link MapGenerator.generate} across many seeds as a
 * single self-contained HTML contact sheet (one colour per `TileType`, faint
 * sector-grid outlines, markers for spawns / chests / exits / weapon spawns)
 * and prints a one-line stat summary per seed. This is a quality-inspection
 * instrument for the sector sub-variant revamp — it does NOT touch any
 * generator, validator, or game/runtime code and adds no runtime dependency.
 *
 * Usage (from `packages/shared`):
 *   pnpm gallery                       # 16 seeds starting at 0 -> map-gallery.html
 *   pnpm gallery --seeds 32 --start 100
 *   pnpm gallery --seed 7              # single large render of one seed
 *   pnpm gallery --type GRID_ARENA     # filter stub (sub-variants not yet impl)
 *   pnpm gallery --out my-sheet.html
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import process from 'node:process';
import { MapGenerator } from '../src/map/MapGenerator.js';
import { SectorType } from '../src/map/types.js';
import type { MapData } from '../src/map/types.js';
import { computeStats, formatStatLine, renderThumbnailSvg } from './galleryRender.js';
import { buildGalleryHtml } from './galleryHtml.js';
import type { GalleryCell } from './galleryHtml.js';

const DEFAULT_SEED_COUNT = 16;
const DEFAULT_START_SEED = 0;
const CONTACT_TILE_PX = 3;
const SINGLE_TILE_PX = 8;
const DEFAULT_OUT = 'map-gallery.html';

/** Parsed command-line options for the gallery run. */
interface GalleryOptions {
  count: number;
  start: number;
  singleSeed: number | null;
  typeFilter: SectorType | null;
  outPath: string;
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
    typeFilter: null,
    outPath: DEFAULT_OUT,
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
      case '--type':
        opts.typeFilter = parseType(value);
        i++;
        break;
      case '--out':
        if (value) opts.outPath = value;
        i++;
        break;
      default:
        break;
    }
  }

  return opts;
}

/**
 * Resolve a `--type` argument to a {@link SectorType}, or `null` if unknown.
 *
 * @param value - the raw flag value
 * @returns the matching sector type, or `null`
 */
function parseType(value: string | undefined): SectorType | null {
  if (!value) return null;
  const upper = value.toUpperCase();
  return (Object.values(SectorType) as string[]).includes(upper) ? (upper as SectorType) : null;
}

/**
 * Build a short per-sector type summary (the 4x4 type grid) for a map, e.g.
 * "GA OA MZ RR / ...". Doubles as the `--type` filter signal once
 * sub-variants exist; today it reports the sector type only.
 *
 * @param map - the generated map data
 * @returns a compact one-line sector-type grid summary
 */
function typeSummary(map: MapData): string {
  const abbr: Record<SectorType, string> = {
    [SectorType.GRID_ARENA]: 'GA',
    [SectorType.OPEN_ARENA]: 'OA',
    [SectorType.MAZE]: 'MZ',
    [SectorType.RESOURCE_RICH]: 'RR',
  };
  return map.sectors.map((row) => row.map((s) => abbr[s.type]).join(' ')).join(' / ');
}

/**
 * Whether a map contains at least one sector of the filtered type.
 *
 * @param map - the generated map data
 * @param filter - the sector type to require, or `null` for no filter
 * @returns `true` if the map passes the filter
 */
function passesTypeFilter(map: MapData, filter: SectorType | null): boolean {
  if (!filter) return true;
  return map.sectors.some((row) => row.some((s) => s.type === filter));
}

/**
 * Generate and render the requested seeds into gallery cells, printing one
 * stat line per included seed to stdout.
 *
 * @param opts - the parsed gallery options
 * @returns the rendered cells and the resolved page title
 */
function runGallery(opts: GalleryOptions): { cells: GalleryCell[]; title: string } {
  const generator = new MapGenerator();
  const cells: GalleryCell[] = [];

  const seeds =
    opts.singleSeed !== null
      ? [opts.singleSeed]
      : Array.from({ length: opts.count }, (_, i) => opts.start + i);
  const tilePx = opts.singleSeed !== null ? SINGLE_TILE_PX : CONTACT_TILE_PX;

  for (const seed of seeds) {
    const map = generator.generate(seed);
    if (!passesTypeFilter(map, opts.typeFilter)) continue;

    const stats = computeStats(map);
    // eslint-disable-next-line no-console
    console.log(formatStatLine(stats));

    cells.push({
      svg: renderThumbnailSvg(map, { tilePx }),
      stats,
      typeSummary: typeSummary(map),
    });
  }

  const filterNote = opts.typeFilter ? ` [type=${opts.typeFilter}]` : '';
  const title =
    opts.singleSeed !== null
      ? `Seed Gallery — seed ${opts.singleSeed}${filterNote}`
      : `Seed Gallery — ${cells.length} seeds from ${opts.start}${filterNote}`;

  return { cells, title };
}

/**
 * Resolve the output path against the current working directory and ensure its
 * parent directory exists.
 *
 * @param outPath - the requested output path (absolute or relative to cwd)
 * @returns the resolved absolute output path
 */
function resolveOut(outPath: string): string {
  const resolved = isAbsolute(outPath) ? outPath : join(process.cwd(), outPath);
  mkdirSync(dirname(resolved), { recursive: true });
  return resolved;
}

/**
 * CLI entry point: parse args, render the gallery, write the HTML file, and
 * print a closing summary line.
 *
 * @returns nothing; writes a file and logs to stdout
 */
function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  const { cells, title } = runGallery(opts);

  if (cells.length === 0) {
    // eslint-disable-next-line no-console
    console.log('No seeds matched the requested filter; nothing written.');
    return;
  }

  const html = buildGalleryHtml(cells, title);
  const outPath = resolveOut(opts.outPath);
  writeFileSync(outPath, html, 'utf8');

  // eslint-disable-next-line no-console
  console.log(`\nWrote ${cells.length} map(s) to ${outPath}`);
}

main();
