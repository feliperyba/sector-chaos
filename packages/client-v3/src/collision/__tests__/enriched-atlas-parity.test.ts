// @vitest-environment node
/**
 * NET-25 — Enriched-collision atlas parity probe (wayfinder:research).
 *
 * This is the Phase-1 deterministic feedback loop for the "worse near walls"
 * half of the local-player netcode-stutter symptom. It is referenced by, and
 * sits alongside, the existing per-position characterization at
 * `./collision-divergence.test.ts`. That file covers a few hand-picked cells;
 * THIS file covers the FULL real demo-map atlas cell-for-cell.
 *
 * ## Question (verbatim from the ticket)
 *
 * Does the client's `visualLayers` / `atlas` (from the `mapData` message) ever
 * resolve a tile to a different visual than the server's `enrichedGrid`
 * (`buildMergedVisuals`), so the client predicts through a wall the server
 * blocks (or vice versa)?
 *
 * ## What is already eliminated (grounding)
 *
 * NET-FINDINGS §3 H2 ELIMINATED an *algorithm* mismatch: the non-enriched
 * algorithms are line-for-line identical, and production uses the SHARED
 * `resolveTileCollisionEnriched` on BOTH sides (one algorithm). So the resolver
 * code is identical client vs server. The open question this probe closes is
 * the DATA half: does the data the resolver consults (the `visualLayers` /
 * `atlas` the client builds from the `mapData` wire payload vs the
 * `enrichedGrid` / `buildMergedVisuals` the server builds from `EnrichedMapData`)
 * ever resolve a tile to a DIFFERENT visual / collider set?
 *
 * ## The two production paths this probe mirrors
 *
 *   SERVER — `buildMergedVisuals` (`GameOrchestratorInit.ts:230-243`):
 *     for each cell (x,y): selectTileVisual(enrichedData.visualLayers, x, y)
 *                          ?? emptyTileVisual()
 *     then `CollisionService.setEnrichedGrid({ visuals: mergedVisuals, atlas })`.
 *
 *   CLIENT — `mapData` message → `MapRenderer.render(data)` stores
 *     `this.visualLayers = data.visualLayers ?? []` and `this.atlas = data.atlas`
 *     (`MapRenderer.ts:277-278`); `ClientCollisionService.findCellVisual`
 *     (`ClientCollisionService.ts:168-186`) calls
 *     `selectTileVisual(visualLayers, gx, gy)` per query.
 *
 * Both call the SAME shared `selectTileVisual` (last layer with `spriteId >= 0`
 * wins). So a cell-level disagreement can ONLY come from the DATA differing
 * between the two sides — which is exactly what this probe measures.
 *
 * ## Verdict semantics
 *
 * The probe resolves to one of two outcomes (recorded in
 * `docs/wayfinder/findings/NET-FINDINGS-enriched-atlas.md`):
 *   - PROVED ABSENT: 0 collider-set disagreements across the full atlas → the
 *     enriched-collision atlas path is RULED OUT for "worse near walls".
 *   - REPRODUCED: >0 collider-set disagreements → a fix ticket graduates
 *     (NET-2x, blocked-by NET-25) with the cell-level repro as its gate.
 *
 * "Agree for collision purposes" is defined strictly: two cells collide-AGREE
 * iff the shared `resolveTileCollisionEnriched` would consult the SAME collider
 * behavior for both — same resolver mode (`skip` / `aabb-fallback` / `sat`) and,
 * in `sat` mode, the same collider boxes. A purely cosmetic spriteId difference
 * with identical colliders does NOT count (recorded separately as
 * `visualDisagreements`, not `colliderDisagreements`).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  selectTileVisual,
  emptyTileVisual,
  resolveTileCollisionEnriched,
  TileType,
  MapGenerator as SharedMapGenerator,
  type EnrichedMapData,
  type TileVisual,
  type TiledMapLayer,
  type TileSpriteAtlas,
  type CollisionGridProvider,
  type AABB,
  type MTV,
} from '@sector-battle/shared';
import { ClientCollisionService } from '../ClientCollisionService.js';
import type { MapRenderer } from '../../rendering/MapRenderer.js';

// ─── Cross-package server map loaders ─────────────────────────────────────
//
// The server-side map builders (TmxParser for the demo map, SeedMapAdapter for
// procedural/seeded maps) live in packages/server. The client tsconfig has
// rootDir=src, so a static import would pull server source into the client
// typecheck program (TS6059). We mirror the physics-divergence-harness pattern:
// NON-LITERAL dynamic-import specifier + local structural types. The runtime
// module is the real server file.

interface ServerTmxParser {
  parse(tmxPath: string): EnrichedMapData;
}
interface ServerSeedMapAdapter {
  adapt(mapData: unknown, seed: number, tsxDir: string): EnrichedMapData;
}

const SERVER_BASE = '../../../../server/src';
const THIS_DIR = dirname(fileURLToPath(import.meta.url));
// packages/client-v3/src/collision/__tests__ → repo root is 5 `..` up:
//   __tests__ → collision → src → client-v3 → packages → <repo root>
// (Verified: SERVER_BASE uses 4 `..` to reach packages/server/src from the
// same depth, so one more `..` reaches the repo root that contains `tiled/`.)
const TILED_DIR = resolve(THIS_DIR, '../../../../..', 'tiled');
const DEMO_TMX = resolve(TILED_DIR, 'demo_map.tmx');

let serverLoaders: Promise<{
  TmxParser: new () => ServerTmxParser;
  SeedMapAdapter: new () => ServerSeedMapAdapter;
}> | null = null;

function loadServerLoaders(): Promise<{
  TmxParser: new () => ServerTmxParser;
  SeedMapAdapter: new () => ServerSeedMapAdapter;
}> {
  if (!serverLoaders) {
    serverLoaders = (async () => {
      const tmxMod = (await import(
        /* @vite-ignore */ `${SERVER_BASE}/infrastructure/parsers/TmxParser.ts`
      )) as { TmxParser: new () => ServerTmxParser };
      const seedMod = (await import(
        /* @vite-ignore */ `${SERVER_BASE}/infrastructure/map/SeedMapAdapter.js`
      )) as { SeedMapAdapter: new () => ServerSeedMapAdapter };
      return {
        TmxParser: tmxMod.TmxParser,
        SeedMapAdapter: seedMod.SeedMapAdapter,
      };
    })();
  }
  return serverLoaders;
}

// ─── The two production paths, faithfully replicated ───────────────────────

/**
 * Exact replica of the server's `buildMergedVisuals`
 * (`packages/server/src/application/services/GameOrchestratorInit.ts:230-243`):
 * last layer with `spriteId >= 0` wins, via the shared `selectTileVisual`.
 * Returns a dense `(TileVisual)[][]` keyed `[y][x]`.
 */
function serverBuildMergedVisuals(data: EnrichedMapData): TileVisual[][] {
  const result: TileVisual[][] = [];
  for (let y = 0; y < data.height; y++) {
    const row: TileVisual[] = [];
    for (let x = 0; x < data.width; x++) {
      row.push(selectTileVisual(data.visualLayers, x, y) ?? emptyTileVisual());
    }
    result.push(row);
  }
  return result;
}

/**
 * Exact replica of the client's per-query resolution
 * (`ClientCollisionService.findCellVisual` → `selectTileVisual`). The siege
 * override is omitted because siege walls are a RUNTIME addition (zone siege
 * phase), not part of the map-load `mapData` payload — at map load (the state
 * this probe measures) `getSiegeWallVisual` returns null for every cell on
 * both sides.
 */
function clientResolveVisual(
  clientVisualLayers: TiledMapLayer[],
  x: number,
  y: number,
): TileVisual {
  return selectTileVisual(clientVisualLayers, x, y) ?? emptyTileVisual();
}

// ─── Collider-behavior derivation (what the resolver actually consults) ────
//
// `resolveTileCollisionEnriched` (packages/shared/src/collision/resolveTileCollision.ts)
// per overlapping tile:
//   1. reads grid[gy][gx]; if EMPTY/EXIT/undefined → SKIP (no resolution).
//   2. reads provider.getVisual(gx,gy); if null OR spriteId<0 → AABB fallback
//      (full-tile solid, two-axis MTV).
//   3. else reads provider.getSprite(spriteId); if missing OR tileType===EMPTY
//      OR colliders.length===0 → SKIP (short-circuit, no resolution).
//   4. else → SAT resolve against sprite.colliders (world-space polygons).
//
// So the collision behavior a cell produces is fully determined by
// (gridTile, resolved spriteId, sprite.tileType, sprite.colliders). Two cells
// collide-AGREE iff all four match.

type ResolverMode = 'skip' | 'aabb-fallback' | 'sat';

interface ColliderBehavior {
  gridTile: TileType;
  spriteId: number; // -1 = no visual resolved
  tileType: TileType | null; // sprite.tileType, or null when no sprite
  colliderCount: number; // sprite.colliders.length, or 0
  /** Canonicalized collider boxes — identity for collider-set comparison. */
  colliderSignature: string;
  mode: ResolverMode;
}

function deriveColliderBehavior(
  gridTile: TileType,
  visual: TileVisual,
  atlas: TileSpriteAtlas,
): ColliderBehavior {
  // Step 1: the gridTile guard in the resolver.
  if (gridTile === TileType.EMPTY || gridTile === TileType.EXIT) {
    return {
      gridTile,
      spriteId: visual.spriteId,
      tileType: null,
      colliderCount: 0,
      colliderSignature: '',
      mode: 'skip',
    };
  }
  // Step 2: no visual resolved → AABB fallback (full-tile solid).
  if (visual.spriteId < 0) {
    return {
      gridTile,
      spriteId: -1,
      tileType: null,
      colliderCount: 0,
      colliderSignature: '',
      mode: 'aabb-fallback',
    };
  }
  // Step 3/4: consult the atlas sprite.
  const sprite = atlas.sprites[visual.spriteId];
  if (!sprite) {
    // Atlas lookup miss — should never happen, but if it does the resolver
    // would throw on `sprite.colliders`. Treat as a distinct (detectable) mode.
    return {
      gridTile,
      spriteId: visual.spriteId,
      tileType: null,
      colliderCount: -1,
      colliderSignature: `MISS:${visual.spriteId}`,
      mode: 'sat',
    };
  }
  if (sprite.tileType === TileType.EMPTY || sprite.colliders.length === 0) {
    return {
      gridTile,
      spriteId: visual.spriteId,
      tileType: sprite.tileType,
      colliderCount: 0,
      colliderSignature: '',
      mode: 'skip',
    };
  }
  return {
    gridTile,
    spriteId: visual.spriteId,
    tileType: sprite.tileType,
    colliderCount: sprite.colliders.length,
    colliderSignature: JSON.stringify(sprite.colliders),
    mode: 'sat',
  };
}

/** Two cells collide-AGREE iff every resolver-relevant field matches. */
function behaviorsAgree(a: ColliderBehavior, b: ColliderBehavior): boolean {
  return (
    a.mode === b.mode &&
    a.gridTile === b.gridTile &&
    a.tileType === b.tileType &&
    a.colliderCount === b.colliderCount &&
    a.colliderSignature === b.colliderSignature
  );
}

interface AtlasComparison {
  totalCells: number;
  /** Cells where the resolved spriteId differs (cosmetic OR collision-relevant). */
  visualDisagreements: number;
  /** Cells where the resolver would consult a DIFFERENT collider behavior. */
  colliderDisagreements: number;
  /** Breakdown by resolver mode (server side), for the findings report. */
  serverModeCounts: Record<ResolverMode, number>;
  /** First up-to-10 collider disagreements, with full diagnostic context. */
  sampleDisagreements: Array<{
    x: number;
    y: number;
    gridTile: TileType;
    server: ColliderBehavior;
    client: ColliderBehavior;
  }>;
}

/**
 * Compare the server's `buildMergedVisuals` output against the client's
 * `visualLayers`/`atlas` resolution, cell-for-cell. `serverData` is the
 * authoritative `EnrichedMapData`; `clientVisualLayers` / `clientAtlas` are
 * what the client holds after the `mapData` wire payload (in production these
 * are the same object graph transmitted verbatim; the caller may pass a
 * wire-roundtripped clone to test serialization fidelity).
 */
function compareAtlasPaths(
  serverData: EnrichedMapData,
  clientVisualLayers: TiledMapLayer[],
  clientAtlas: TileSpriteAtlas,
): AtlasComparison {
  const serverVisuals = serverBuildMergedVisuals(serverData);
  const totalCells = serverData.width * serverData.height;
  let visualDisagreements = 0;
  let colliderDisagreements = 0;
  const serverModeCounts: Record<ResolverMode, number> = {
    skip: 0,
    'aabb-fallback': 0,
    sat: 0,
  };
  const sampleDisagreements: AtlasComparison['sampleDisagreements'] = [];

  for (let y = 0; y < serverData.height; y++) {
    for (let x = 0; x < serverData.width; x++) {
      const gridTile = serverData.grid[y]![x]!;
      const serverVisual = serverVisuals[y]![x]!;
      const clientVisual = clientResolveVisual(clientVisualLayers, x, y);
      const serverBehavior = deriveColliderBehavior(gridTile, serverVisual, serverData.atlas);
      const clientBehavior = deriveColliderBehavior(gridTile, clientVisual, clientAtlas);

      serverModeCounts[serverBehavior.mode]++;
      if (serverVisual.spriteId !== clientVisual.spriteId) visualDisagreements++;
      if (!behaviorsAgree(serverBehavior, clientBehavior)) {
        colliderDisagreements++;
        if (sampleDisagreements.length < 10) {
          sampleDisagreements.push({
            x,
            y,
            gridTile,
            server: serverBehavior,
            client: clientBehavior,
          });
        }
      }
    }
  }

  return {
    totalCells,
    visualDisagreements,
    colliderDisagreements,
    serverModeCounts,
    sampleDisagreements,
  };
}

/**
 * Drive the REAL shared `resolveTileCollisionEnriched` on BOTH sides at a
 * sweep of wall-adjacent positions, returning the per-side resolved center.
 * This is the end-to-end confirmation: same algorithm (H2 eliminated) + same
 * data (this probe) → same resolved position. The client side uses the REAL
 * `ClientCollisionService.resolveCollision` (the exact hot path) over a stub
 * MapRenderer holding the wire data; the server side uses a provider over
 * `buildMergedVisuals` + the shared resolver + the server's per-axis center
 * clamp (`MovementService.clampValue`).
 */
function driveResolverAtWallPositions(
  data: EnrichedMapData,
  clientVisualLayers: TiledMapLayer[],
  clientAtlas: TileSpriteAtlas,
): {
  positions: number;
  maxDelta: number;
  sample: Array<{
    pos: { x: number; y: number };
    server: { x: number; y: number };
    client: { x: number; y: number };
    delta: number;
  }>;
} {
  const tileSize = data.tileSize;
  const halfW = 48; // PLAYER.HITBOX_WIDTH / 2 = 96 / 2
  const halfH = 48;

  // Collect every wall-adjacent walkable tile center — the positions where a
  // "worse near walls" divergence would manifest. A tile is wall-adjacent if
  // it is EMPTY/EXIT and at least one 4-neighbor is a non-EMPTY grid tile.
  const probes: Array<{ x: number; y: number }> = [];
  for (let y = 0; y < data.height; y++) {
    for (let x = 0; x < data.width; x++) {
      const t = data.grid[y]![x]!;
      if (t !== TileType.EMPTY && t !== TileType.EXIT) continue;
      const neighbors = [
        data.grid[y - 1]?.[x],
        data.grid[y + 1]?.[x],
        data.grid[y]?.[x - 1],
        data.grid[y]?.[x + 1],
      ];
      if (neighbors.some((n) => n !== undefined && n !== TileType.EMPTY && n !== TileType.EXIT)) {
        probes.push({ x: x * tileSize + tileSize / 2, y: y * tileSize + tileSize / 2 });
      }
    }
  }

  // SERVER path: buildMergedVisuals provider + shared resolver + per-axis clamp.
  const merged = serverBuildMergedVisuals(data);
  const serverProvider: CollisionGridProvider = {
    getVisual: (gx, gy) => merged[gy]?.[gx] ?? null,
    getSprite: (spriteId) => data.atlas.sprites[spriteId],
    getTileSize: () => tileSize,
  };
  const mtvScratch: MTV = { x: 0, y: 0, depth: 0 };
  const mapWidth = data.width * tileSize;
  const mapHeight = data.height * tileSize;

  // CLIENT path: real ClientCollisionService over a stub MapRenderer holding
  // the wire data — exactly the production client hot path.
  const stubRenderer = {
    getGrid: () => data.grid,
    getTileSize: () => tileSize,
    getAtlas: () => clientAtlas,
    getVisualLayers: () => clientVisualLayers,
    getSiegeWallVisual: () => null,
  } as unknown as MapRenderer;
  const clientService = new ClientCollisionService(stubRenderer);

  let maxDelta = 0;
  const sample: Array<{
    pos: { x: number; y: number };
    server: { x: number; y: number };
    client: { x: number; y: number };
    delta: number;
  }> = [];
  // Cap the sweep so the test stays < 2s on huge maps (the demo map is small,
  // but procedural 80×80 maps can have thousands of wall-adjacent tiles).
  const STEP = Math.max(1, Math.floor(probes.length / 400));
  let visited = 0;
  for (let i = 0; i < probes.length; i += STEP) {
    const p = probes[i]!;
    // SERVER: resolve then apply MovementService.clampValue (per-axis, center).
    const entity: AABB = { x: p.x - halfW, y: p.y - halfH, width: halfW * 2, height: halfH * 2 };
    const resolved = { x: 0, y: 0 };
    resolveTileCollisionEnriched(entity, data.grid, serverProvider, mtvScratch, resolved);
    const half = halfW;
    const sCx = Math.max(half, Math.min(resolved.x + halfW, mapWidth - half));
    const sCy = Math.max(half, Math.min(resolved.y + halfH, mapHeight - half));
    // CLIENT: real resolveCollision (center in, center out, includes clamp).
    const c = clientService.resolveCollision(p.x, p.y, halfW, halfH);
    const delta = Math.hypot(sCx - c.x, sCy - c.y);
    if (delta > maxDelta) maxDelta = delta;
    if (sample.length < 8) {
      sample.push({ pos: p, server: { x: sCx, y: sCy }, client: { x: c.x, y: c.y }, delta });
    }
    visited++;
  }

  return { positions: visited, maxDelta, sample };
}

// ─── Stub MapRenderer factory for the client path ──────────────────────────

function makeStubMapRenderer(
  grid: EnrichedMapData['grid'],
  tileSize: number,
  atlas: TileSpriteAtlas,
  visualLayers: TiledMapLayer[],
): MapRenderer {
  return {
    getGrid: () => grid,
    getTileSize: () => tileSize,
    getAtlas: () => atlas,
    getVisualLayers: () => visualLayers,
    getSiegeWallVisual: () => null,
  } as unknown as MapRenderer;
}

// ─── Deep clone simulating the Colyseus msgpack wire round-trip ────────────
//
// Production: payload.visualLayers = enrichedData.visualLayers (same ref) →
// Colyseus encodes via msgpack → bytes → wire → client decodes → fresh object
// → MapRenderer stores it. JSON parse/stringify is a conservative proxy: it
// surfaces any field that wouldn't survive a structured-clone-style encode
// (functions, undefined, symbols, sparse arrays) and produces a fresh object
// graph matching the decode side.

function wireRoundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// ===========================================================================

describe('NET-25 enriched-collision atlas parity (real demo map)', () => {
  describe('DEMO MAP (tiled/demo_map.tmx → TmxParser → EnrichedMapData)', () => {
    let enriched: EnrichedMapData;

    beforeAll(async () => {
      const { TmxParser } = await loadServerLoaders();
      enriched = new TmxParser().parse(DEMO_TMX);
    });

    it('loads the real demo map (production demo-map branch)', () => {
      // Sanity: the demo map is a real, non-trivial atlas.
      expect(enriched.width).toBeGreaterThan(0);
      expect(enriched.height).toBeGreaterThan(0);
      expect(enriched.atlas.sprites.length).toBeGreaterThan(0);
      expect(enriched.visualLayers.length).toBeGreaterThanOrEqual(1);
      // eslint-disable-next-line no-console
      console.log('[NET-25] demo map loaded:', {
        w: enriched.width,
        h: enriched.height,
        cells: enriched.width * enriched.height,
        layers: enriched.visualLayers.map((l) => l.name),
        atlasSprites: enriched.atlas.sprites.length,
      });
    });

    it('SAME-REFERENCE (production call site): 0 collider-set disagreements', () => {
      // This is the literal production case: payload.visualLayers =
      // enrichedData.visualLayers (GameRoom.ts:110), same object graph.
      const result = compareAtlasPaths(enriched, enriched.visualLayers, enriched.atlas);
      // eslint-disable-next-line no-console
      console.log('[NET-25] demo same-reference:', {
        totalCells: result.totalCells,
        visualDisagreements: result.visualDisagreements,
        colliderDisagreements: result.colliderDisagreements,
        serverModeCounts: result.serverModeCounts,
      });
      expect(result.colliderDisagreements).toBe(0);
      // Cosmetic disagreements would still be informative (not necessarily a
      // collision bug, but a data-fidelity signal worth recording).
      expect(result.sampleDisagreements).toHaveLength(0);
    });

    it('WIRE ROUND-TRIP (msgpack proxy): 0 collider-set disagreements', () => {
      const clientVisualLayers = wireRoundTrip(enriched.visualLayers);
      const clientAtlas = wireRoundTrip(enriched.atlas);
      const result = compareAtlasPaths(enriched, clientVisualLayers, clientAtlas);
      // eslint-disable-next-line no-console
      console.log('[NET-25] demo wire-roundtrip:', {
        colliderDisagreements: result.colliderDisagreements,
        visualDisagreements: result.visualDisagreements,
      });
      expect(result.colliderDisagreements).toBe(0);
      expect(result.sampleDisagreements).toHaveLength(0);
    });

    it('REAL ClientCollisionService vs server path at wall-adjacent positions (end-to-end)', () => {
      const result = driveResolverAtWallPositions(enriched, enriched.visualLayers, enriched.atlas);
      // eslint-disable-next-line no-console
      console.log('[NET-25] demo resolver sweep:', {
        positions: result.positions,
        maxDelta: result.maxDelta.toFixed(4),
        sample: result.sample.slice(0, 3),
      });
      expect(result.positions).toBeGreaterThan(0);
      // Same algorithm (H2 eliminated) + same data (cell probe above) → the
      // resolver MUST produce identical positions to sub-pixel precision.
      expect(result.maxDelta).toBeLessThan(0.5);
    });
  });

  describe('PROCEDURAL MAP (SeedMapAdapter — shipped procedural atlas)', () => {
    // Two distinct seeds to exercise different sector layouts / wall masses.
    const SEEDS = [42, 9999];

    for (const seed of SEEDS) {
      it(`seed=${seed}: 0 collider-set disagreements (same-ref + wire)`, async () => {
        const { SeedMapAdapter } = await loadServerLoaders();
        // The SHARED MapGenerator (not the server wrapper) produces the raw
        // MapData.sectors that SeedMapAdapter.adapt consumes — same path as
        // SeedMapAdapter.test.ts and the procedural branch of GameRoomMapBuilder.
        const mapData = new SharedMapGenerator().generate(seed);
        const adapter = new SeedMapAdapter();
        const enriched = adapter.adapt(mapData, seed, TILED_DIR);

        // Same-reference (production call site).
        const sameRef = compareAtlasPaths(enriched, enriched.visualLayers, enriched.atlas);
        // Wire round-trip.
        const wire = compareAtlasPaths(
          enriched,
          wireRoundTrip(enriched.visualLayers),
          wireRoundTrip(enriched.atlas),
        );
        // eslint-disable-next-line no-console
        console.log(`[NET-25] procedural seed=${seed}:`, {
          cells: sameRef.totalCells,
          layers: enriched.visualLayers.map((l) => l.name),
          sameRefCollider: sameRef.colliderDisagreements,
          sameRefVisual: sameRef.visualDisagreements,
          wireCollider: wire.colliderDisagreements,
          wireVisual: wire.visualDisagreements,
          serverModeCounts: sameRef.serverModeCounts,
        });
        expect(sameRef.colliderDisagreements).toBe(0);
        expect(wire.colliderDisagreements).toBe(0);
      });
    }
  });

  describe('harness qualities (determinism + speed)', () => {
    let demo: EnrichedMapData;

    it('DETERMINISTIC: two identical runs produce identical disagreement sets', async () => {
      const { TmxParser } = await loadServerLoaders();
      demo = new TmxParser().parse(DEMO_TMX);
      const run1 = compareAtlasPaths(demo, demo.visualLayers, demo.atlas);
      const run2 = compareAtlasPaths(demo, demo.visualLayers, demo.atlas);
      expect(run1.colliderDisagreements).toBe(run2.colliderDisagreements);
      expect(run1.visualDisagreements).toBe(run2.visualDisagreements);
      expect(run1.totalCells).toBe(run2.totalCells);
    });

    it('FAST: full demo-map cell sweep + resolver sweep completes (qualitative < 2s)', async () => {
      const { TmxParser } = await loadServerLoaders();
      const d = new TmxParser().parse(DEMO_TMX);
      const t0 = Date.now();
      compareAtlasPaths(d, d.visualLayers, d.atlas);
      driveResolverAtWallPositions(d, d.visualLayers, d.atlas);
      const elapsed = Date.now() - t0;
      // eslint-disable-next-line no-console
      console.log(`[NET-25] harness wall-clock: ${elapsed}ms`);
      // Qualitative bound — the spec's < 2s criterion. Generous to avoid CI
      // flake on a loaded machine; the measured number is logged for audit.
      expect(elapsed).toBeLessThan(2000);
    });
  });
});
