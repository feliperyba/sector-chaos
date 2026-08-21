import { describe, it, expect } from 'vitest';
import {
  TileType,
  PLAYER,
  COMBAT,
  SIM_TICK_DT,
  simulatePhysicsStepInto,
  resolveTileCollisionEnriched,
  type TileVisual,
  type TiledMapLayer,
  type TileSpriteAtlas,
  type AABB,
  type MTV,
  type CollisionGridProvider,
  type PhysicsState,
  type PhysicsInput,
  type PhysicsConfig,
  type CollisionFn,
} from '@sector-battle/shared';
import { ClientCollisionService } from '../ClientCollisionService.js';
import type { MapRenderer } from '../../rendering/MapRenderer.js';

/**
 * DETERMINISTIC COLLISION-DIVERGENCE REPRO — the Phase 1 feedback loop for the
 * local-player netcode stutter (see NETCODE-COLLISION-MISMATCH-HANDOFF.md).
 *
 * ROOT CAUSE (confirmed by reading the code end-to-end):
 *   For any grid tile that is BOTH marked as a wall in the grid AND has a floor
 *   cell beneath it in the visual layers (which is EVERY wall tile —
 *   FloorSpriteSelector paints an EMPTY-type, zero-collider floor sprite under
 *   walls/destructibles/entities too), the client and server pick a DIFFERENT
 *   visual for that tile, so the shared enriched resolver produces a different
 *   collision result:
 *
 *     • Server `buildMergedVisuals` (GameOrchestratorInit.ts) keeps the LAST
 *       layer with spriteId >= 0 → the wall layer wins → wall sprite has
 *       colliders → SAT resolves → the player is BLOCKED.
 *
 *     • Client `ClientCollisionService.findCellVisual` returns the FIRST truthy
 *       layer cell → the FLOOR layer (index 0) wins → floor sprite has
 *       `colliders: []` → `resolveTileCollisionEnriched` line 60 short-circuits
 *       (`sprite.colliders.length === 0` → return) → NO collision is resolved →
 *       the player WALKS THROUGH the grid-marked wall.
 *
 *   The client therefore predicts ~7.17px (one tick of BASE_SPEED) past every
 *   wall the server blocks → reconErr accumulates in a sawtooth → corrections
 *   fire every ~130ms → the visible snap-back ("stutter").
 *
 * Layer order is load-bearing (SeedMapAdapter.ts:122-132, asserted in
 * SeedMapAdapter.test.ts): [floor, decoration, map_border_walls, interactive_layer].
 *
 * This test exercises the REAL client production path
 * (`ClientCollisionService.resolveCollision`) against a faithful replication of
 * the server production path (`CollisionService.resolveEnriched` +
 * `MovementService.clampValue`). The server path is replicated inline rather
 * than imported cross-package (client tsconfig rootDir=src) — but it calls the
 * EXACT shared `resolveTileCollisionEnriched` the server calls, with the exact
 * last-wins provider and the exact per-axis clamp, so any divergence is a true
 * production divergence, not a test artifact.
 */

const TILE_SIZE = 128;
const HALF_W = 48; // PLAYER.HITBOX_WIDTH  / 2 = 96 / 2
const HALF_H = 48; // PLAYER.HITBOX_HEIGHT / 2 = 96 / 2

interface Fixture {
  grid: number[][];
  atlas: TileSpriteAtlas;
  visualLayers: TiledMapLayer[];
  tileSize: number;
}

/** Floor visual: EMPTY-type, zero-collider — exactly what FloorSpriteSelector emits. */
function floorVisual(): TileVisual {
  return { spriteId: 0, rotation: 0, flipH: false, flipV: false };
}

/** Wall visual pointing at the full-tile-collider wall sprite (spriteId 1). */
function wallVisual(): TileVisual {
  return { spriteId: 1, rotation: 0, flipH: false, flipV: false };
}

/**
 * Build a 5×5 grid that is all EMPTY except a single INDESTRUCTIBLE_WALL at
 * row 2, col 3, with the production visual-layer stack: a DENSE floor underlay
 * (cell at every tile, exactly as FloorSpriteSelector.select documents), an
 * empty decoration layer, a wall layer with the wall cell at [2][3], and an
 * empty interactive layer. The atlas carries the matching floor (zero-collider)
 * and wall (full-tile-collider) sprites.
 *
 * Each call returns FRESH objects so the lazy `cachedWorldPolygons` mutation in
 * the enriched resolver can't leak between the client and server runs.
 */
function makeWallWithFloorUnderlay(): Fixture {
  const rows = 5;
  const cols = 5;
  const grid: number[][] = [];
  const floorCells: (TileVisual | null)[][] = [];
  const decorationCells: (TileVisual | null)[][] = [];
  const wallCells: (TileVisual | null)[][] = [];
  const interactiveCells: (TileVisual | null)[][] = [];
  for (let r = 0; r < rows; r++) {
    const gridRow: number[] = [];
    const floorRow: (TileVisual | null)[] = [];
    const decoRow: (TileVisual | null)[] = [];
    const wallRow: (TileVisual | null)[] = [];
    const intRow: (TileVisual | null)[] = [];
    for (let c = 0; c < cols; c++) {
      gridRow.push(0);
      // Floor underlay: a cell on EVERY tile (incl. under the wall) — production behavior.
      floorRow.push(floorVisual());
      decoRow.push(null);
      wallRow.push(null);
      intRow.push(null);
    }
    grid.push(gridRow);
    floorCells.push(floorRow);
    decorationCells.push(decoRow);
    wallCells.push(wallRow);
    interactiveCells.push(intRow);
  }
  // The single wall — in BOTH the grid and the wall visual layer, with a floor cell beneath.
  grid[2]![3] = TileType.INDESTRUCTIBLE_WALL;
  wallCells[2]![3] = wallVisual();

  const atlas: TileSpriteAtlas = {
    sprites: [
      // [0] floor: EMPTY-type, zero-collider cosmetic.
      { id: 0, imagePath: 'floor_test', tileType: TileType.EMPTY, colliders: [] },
      // [1] wall: full-tile rect collider (same shape as createSiegeWallSpriteDef).
      {
        id: 1,
        imagePath: 'wall_test',
        tileType: TileType.INDESTRUCTIBLE_WALL,
        colliders: [{ type: 'rect', x: 0, y: 0, width: TILE_SIZE, height: TILE_SIZE }],
      },
    ],
  };

  const visualLayers: TiledMapLayer[] = [
    { name: 'floor', cells: floorCells },
    { name: 'decoration', cells: decorationCells },
    { name: 'map_border_walls', cells: wallCells },
    { name: 'interactive_layer', cells: interactiveCells },
  ];

  return { grid, atlas, visualLayers, tileSize: TILE_SIZE };
}

/**
 * Same as above but WITHOUT the floor underlay — the wall layer cell is the
 * only visual at [2][3]. This is the control: when no floor cell underlies the
 * wall, the client's first-wins selection reaches the wall layer and both sides
 * agree. It isolates the divergence to the floor-underlay case.
 */
function makeWallWithoutFloorUnderlay(): Fixture {
  const f = makeWallWithFloorUnderlay();
  // Strip the floor cell at the wall tile only — leave the rest of the floor intact.
  f.visualLayers[0]!.cells[2]![3] = null;
  return f;
}

/** Open-space fixture: no walls anywhere. Both sides must trivially agree. */
function makeOpenSpace(): Fixture {
  return makeWallWithFloorUnderlay();
}

/**
 * Open-space fixture at an ARBITRARY non-square dimension (NET-22 regression).
 * Same production visual-layer stack as makeWallWithFloorUnderlay (floor
 * underlay on every tile, empty deco/wall/interactive layers) but parameterized
 * to cols×rows and with NO wall placed. Used to exercise the post-collision
 * bounds clamp on a non-square map where mapWidth !== mapHeight (the
 * cross-axis clamp bug is latent on the square production map).
 */
function makeOpenNonSquare(cols: number, rows: number): Fixture {
  const grid: number[][] = [];
  const floorCells: (TileVisual | null)[][] = [];
  const decorationCells: (TileVisual | null)[][] = [];
  const wallCells: (TileVisual | null)[][] = [];
  const interactiveCells: (TileVisual | null)[][] = [];
  for (let r = 0; r < rows; r++) {
    const gridRow: number[] = [];
    const floorRow: (TileVisual | null)[] = [];
    const decoRow: (TileVisual | null)[] = [];
    const wallRow: (TileVisual | null)[] = [];
    const intRow: (TileVisual | null)[] = [];
    for (let c = 0; c < cols; c++) {
      gridRow.push(0);
      floorRow.push(floorVisual());
      decoRow.push(null);
      wallRow.push(null);
      intRow.push(null);
    }
    grid.push(gridRow);
    floorCells.push(floorRow);
    decorationCells.push(decoRow);
    wallCells.push(wallRow);
    interactiveCells.push(intRow);
  }
  const atlas: TileSpriteAtlas = {
    sprites: [
      { id: 0, imagePath: 'floor_test', tileType: TileType.EMPTY, colliders: [] },
      {
        id: 1,
        imagePath: 'wall_test',
        tileType: TileType.INDESTRUCTIBLE_WALL,
        colliders: [{ type: 'rect', x: 0, y: 0, width: TILE_SIZE, height: TILE_SIZE }],
      },
    ],
  };
  const visualLayers: TiledMapLayer[] = [
    { name: 'floor', cells: floorCells },
    { name: 'decoration', cells: decorationCells },
    { name: 'map_border_walls', cells: wallCells },
    { name: 'interactive_layer', cells: interactiveCells },
  ];
  return { grid, atlas, visualLayers, tileSize: TILE_SIZE };
}

// ── client production path ──────────────────────────────────────────────────

function makeStubMapRenderer(f: Fixture): MapRenderer {
  return {
    getGrid: () => f.grid,
    getTileSize: () => f.tileSize,
    getAtlas: () => f.atlas,
    getVisualLayers: () => f.visualLayers,
    getSiegeWallVisual: () => null,
  } as unknown as MapRenderer;
}

/** Real ClientCollisionService.resolveCollision — the exact client hot path. */
function clientResolve(cx: number, cy: number, f: Fixture): { x: number; y: number } {
  const service = new ClientCollisionService(makeStubMapRenderer(f));
  return service.resolveCollision(cx, cy, HALF_W, HALF_H);
}

// ── server production path (replicated from CollisionService + MovementService) ─

/** Exact replica of buildMergedVisuals (GameOrchestratorInit.ts): last spriteId>=0 wins. */
function buildMergedVisuals(
  visualLayers: TiledMapLayer[],
  height: number,
  width: number,
): TileVisual[][] {
  const result: TileVisual[][] = [];
  for (let y = 0; y < height; y++) {
    const row: TileVisual[] = [];
    for (let x = 0; x < width; x++) {
      let best: TileVisual | null = null;
      for (const layer of visualLayers) {
        const cell = layer.cells[y]?.[x];
        if (cell && cell.spriteId >= 0) best = cell;
      }
      row.push(best ?? { spriteId: -1, rotation: 0, flipH: false, flipV: false });
    }
    result.push(row);
  }
  return result;
}

/**
 * Faithful server path: CollisionService.resolveEnriched (last-wins provider →
 * shared resolveTileCollisionEnriched) + MovementService.clampValue (per-axis
 * center clamp). Uses the EXACT shared resolver and the EXACT clamp formula.
 */
function serverResolve(cx: number, cy: number, f: Fixture): { x: number; y: number } {
  const { grid, atlas, visualLayers, tileSize } = f;
  const height = grid.length;
  const width = grid[0]?.length ?? 0;
  const merged = buildMergedVisuals(visualLayers, height, width);

  const entity: AABB = { x: cx - HALF_W, y: cy - HALF_H, width: HALF_W * 2, height: HALF_H * 2 };
  const mtvScratch: MTV = { x: 0, y: 0, depth: 0 };
  const provider: CollisionGridProvider = {
    getVisual: (gx, gy) => merged[gy]?.[gx] ?? null,
    getSprite: (spriteId) => atlas.sprites[spriteId],
    getTileSize: () => tileSize,
  };
  const resolved = { x: 0, y: 0 };
  resolveTileCollisionEnriched(entity, grid, provider, mtvScratch, resolved);

  // MovementService.clampValue (per-axis, center-based): Math.max(half, Math.min(v, extent - half))
  const mapWidth = width * tileSize;
  const mapHeight = height * tileSize;
  const size = HALF_W * 2;
  const half = size / 2;
  const clampedX = Math.max(half, Math.min(resolved.x + HALF_W, mapWidth - half));
  const clampedY = Math.max(half, Math.min(resolved.y + HALF_H, mapHeight - half));
  return { x: clampedX, y: clampedY };
}

describe('client-server collision divergence (root cause of netcode stutter)', () => {
  // The wall sits at grid[2][3] → world tile rect [384..512] × [256..384].
  // Player center (360, 320), half-extents 48 → AABB [312..408] × [272..368].
  // That overlaps the wall by 24px on X (and the full 96px on Y), so a correct
  // resolver pushes the player LEFT to center (336, 320).

  it('REGRESSION: wall WITH floor underlay — client and server resolve identically', () => {
    // This is the production case (FloorSpriteSelector paints floor under every
    // wall). Currently the client walks THROUGH the wall (picks the floor visual,
    // whose zero-collider short-circuits the resolver) while the server blocks.
    // Expected after fix: both block, identical centers.
    const fClient = makeWallWithFloorUnderlay();
    const fServer = makeWallWithFloorUnderlay();
    const client = clientResolve(360, 320, fClient);
    const server = serverResolve(360, 320, fServer);
    console.log('[collision-divergence] wall+floor:', { client, server, dx: client.x - server.x });
    expect(client.x).toBe(server.x);
    expect(client.y).toBe(server.y);
  });

  it('CONTROL: wall WITHOUT floor underlay — both block (already agree)', () => {
    // When no floor cell underlies the wall, the client's first-wins reaches the
    // wall layer and both sides block. This isolates the regression to the
    // floor-underlay case and confirms the harness itself is sound.
    const fClient = makeWallWithoutFloorUnderlay();
    const fServer = makeWallWithoutFloorUnderlay();
    const client = clientResolve(360, 320, fClient);
    const server = serverResolve(360, 320, fServer);
    console.log('[collision-divergence] wall no-floor:', { client, server });
    expect(client.x).toBe(server.x);
    expect(client.y).toBe(server.y);
    // And both must actually have blocked (pushed left of the input center 360).
    expect(server.x).toBeLessThan(360);
  });

  it('CONTROL: open space — both agree (no collision either side)', () => {
    // Remove the wall entirely; both sides must return the input center clamped.
    const f = makeOpenSpace();
    f.grid[2]![3] = TileType.EMPTY;
    f.visualLayers[2]!.cells[2]![3] = null;
    const client = clientResolve(360, 320, { ...f });
    const server = serverResolve(360, 320, { ...f });
    console.log('[collision-divergence] open space:', { client, server });
    expect(client.x).toBe(server.x);
    expect(client.y).toBe(server.y);
  });

  // =========================================================================
  // NET-22 — bounds-clamp cross-axis parity (non-square map regression).
  // The production demo map is SQUARE (mapWidth===mapHeight=10240), so the
  // cross-axis clamp contamination is latent there. This test exercises a WIDE
  // non-square map (mapWidth > mapHeight) to pin per-axis bounds-clamp parity
  // directly at the unit level: the client's clampBounds must clamp X against
  // mapWidth and Y against mapHeight independently, matching the server's
  // per-axis MovementService.clampValue. Pre-NET-22 the client clamped X to
  // min(mapWidth,mapHeight) → ~1024px short of the server on this probe.
  // =========================================================================
  it('NET-22: non-square map — client clamps each axis against its own extent (matches server)', () => {
    const cols = 20; // mapWidth = 2560
    const rows = 12; // mapHeight = 1536
    const fClient = makeOpenNonSquare(cols, rows);
    const fServer = makeOpenNonSquare(cols, rows);
    const mapWidth = cols * TILE_SIZE;
    const mapHeight = rows * TILE_SIZE;
    // Place the player PAST the +X map edge (center x=2600 > mapWidth=2560).
    // Server clamps X → mapWidth - HALF_W = 2512. Pre-NET-22 the client clamped
    // X → min(mapWidth,mapHeight) - HALF_W = 1488 (the cross-axis bug).
    const client = clientResolve(mapWidth + 40, 700, fClient);
    const server = serverResolve(mapWidth + 40, 700, fServer);
    console.log('[collision-divergence NET-22] non-square(20x12) +X clamp:', {
      clientX: client.x,
      serverX: server.x,
      mapWidth,
      mapHeight,
    });
    expect(client.x).toBe(server.x);
    // X clamped against mapWidth (NOT mapHeight). 2512, not 1488.
    expect(client.x).toBe(mapWidth - HALF_W);
    // Y clamps against mapHeight independently (700 is within bounds → unchanged).
    expect(client.y).toBe(server.y);
    expect(client.y).toBe(700);
  });

  it('NET-22: non-square map — Y clamps against mapHeight (not mapWidth)', () => {
    // Tall non-square map (rows > cols → mapHeight > mapWidth). Place the player
    // past the +Y edge: the client must clamp Y against mapHeight, not mapWidth.
    const cols = 12; // mapWidth = 1536
    const rows = 20; // mapHeight = 2560
    const fClient = makeOpenNonSquare(cols, rows);
    const fServer = makeOpenNonSquare(cols, rows);
    const mapWidth = cols * TILE_SIZE;
    const mapHeight = rows * TILE_SIZE;
    const client = clientResolve(700, mapHeight + 40, fClient);
    const server = serverResolve(700, mapHeight + 40, fServer);
    console.log('[collision-divergence NET-22] non-square(12x20) +Y clamp:', {
      clientY: client.y,
      serverY: server.y,
      mapWidth,
      mapHeight,
    });
    expect(client.y).toBe(server.y);
    // Y clamped against mapHeight (NOT mapWidth). 2512, not 1488.
    expect(client.y).toBe(mapHeight - HALF_H);
    expect(client.x).toBe(server.x);
    expect(client.x).toBe(700);
  });

  // =========================================================================
  // MULTI-TICK DRIFT — the un-minimised stutter scenario. The player holds
  // movement into the wall for many ticks. Both sides run the SAME verified
  // physics primitive (simulatePhysicsStepInto — proven bit-identical client vs
  // server in prior sessions); the ONLY difference is the collisionFn. So any
  // drift is purely a collision-resolution divergence. Before the fix the
  // client sailed through the wall ~7.17px/tick; after the fix it stops at the
  // same boundary as the server every tick → zero accumulated drift → no
  // sawtooth corrections → no stutter.
  // =========================================================================
  it('MULTI-TICK: holding movement into a wall — client and server stay in sync (no drift)', () => {
    const physicsConfig: PhysicsConfig = {
      acceleration: PLAYER.ACCELERATION,
      deceleration: PLAYER.DECELERATION,
      dashSpeedMultiplier: PLAYER.DASH_SPEED_MULTIPLIER,
      dashDurationTicks: PLAYER.DASH_DURATION_TICKS,
      staggerMoveSpeedPenalty: COMBAT.STAGGER_MOVE_SPEED_PENALTY,
      playerHalfW: HALF_W,
      playerHalfH: HALF_H,
      baseSpeed: PLAYER.BASE_SPEED,
    };

    const fClient = makeWallWithFloorUnderlay();
    const fServer = makeWallWithFloorUnderlay();
    // CollisionFn signature is (x, y, halfW, halfH) → {x, y}; the half-extents
    // come from physicsConfig (HALF_W/HALF_H), which the helpers already use.
    const clientFn: CollisionFn = (x, y) => clientResolve(x, y, fClient);
    const serverFn: CollisionFn = (x, y) => serverResolve(x, y, fServer);

    const mkState = (x: number, y: number): PhysicsState => ({
      x,
      y,
      vx: 0,
      vy: 0,
      speed: PLAYER.BASE_SPEED,
      isDashing: false,
      dashRemaining: 0,
      isStaggered: false,
    });
    const mkInput = (dx: number, dy: number): PhysicsInput => ({
      dx,
      dy,
      hasDash: false,
      dashDirX: 0,
      dashDirY: 0,
    });

    // Wall left edge at world x=384; player rest position against it is center
    // x = 384 - 48 = 336. Start at x=200 so the player accelerates INTO the
    // wall and presses against it for many ticks.
    const clientState = mkState(200, 320);
    const serverState = mkState(200, 320);
    const input = mkInput(1, 0); // hold right

    let maxDrift = 0;
    let driftAtContact = 0;
    let contacted = false;
    for (let tick = 0; tick < 30; tick++) {
      simulatePhysicsStepInto(clientState, input, physicsConfig, clientFn, SIM_TICK_DT);
      simulatePhysicsStepInto(serverState, input, physicsConfig, serverFn, SIM_TICK_DT);
      const drift = Math.hypot(clientState.x - serverState.x, clientState.y - serverState.y);
      if (drift > maxDrift) maxDrift = drift;
      // Once the server first touches the wall (center ≥ 336), record the drift
      // from that point on — this is exactly the band where the bug manifested.
      if (!contacted && serverState.x >= 336) contacted = true;
      if (contacted && drift > driftAtContact) driftAtContact = drift;
    }

    console.log('[collision-divergence] multi-tick:', {
      clientX: clientState.x.toFixed(2),
      serverX: serverState.x.toFixed(2),
      maxDrift: maxDrift.toFixed(3),
      driftAtContact: driftAtContact.toFixed(3),
    });

    // With the fix, collision agrees every tick → drift stays sub-pixel.
    expect(maxDrift).toBeLessThan(0.5);
    // And both must have stopped against the wall (center near 336, never past
    // the wall's left edge + half-width = 384). Before the fix the client ended
    // well past 384 (it walked through).
    expect(serverState.x).toBeLessThan(337);
    expect(clientState.x).toBeLessThan(337);
  });
});
