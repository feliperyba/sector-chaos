import type { AABB } from './AABBCollision.js';
import type { Vec2, MTV } from './Vec2.js';
import type { TileCollider, TileColliderRect, TileColliderPoly } from '../map/tiledTypes.js';

interface ProjRange {
  min: number;
  max: number;
}

// ── Module-level scratch ────────────────────────────────────────────────────
// JS is single-threaded: these are reused across calls. Each public method
// fully consumes its scratch outputs before any subsequent call, so the scratch
// is never aliased across a call boundary that would observe the overwrite.
//
// Arrays here grow to their high-water mark; slots are mutated in place. We
// still set `.length = n` so external callers reading `.length` see the
// logical size — slot objects at indices < n are preserved across calls.
const _scratchAABBVerts: Vec2[] = [
  { x: 0, y: 0 },
  { x: 0, y: 0 },
  { x: 0, y: 0 },
  { x: 0, y: 0 },
];
const _scratchAxes: Vec2[] = []; // grows as needed; count tracked separately
const _scratchSeen = new Set<number>();
const _scratchPolyVerts: Vec2[] = []; // colliderToPoints output
const _scratchTransformed: Vec2[] = []; // transformCollider output
const _scratchAABBProj: ProjRange = { min: 0, max: 0 };
const _scratchPolyProj: ProjRange = { min: 0, max: 0 };
const _scratchMTV: MTV = { x: 0, y: 0, depth: 0 };

export class ColliderCollision {
  /**
   * Resolve an AABB against every collider on a tile, returning the minimum
   * MTV across all colliders (or null if none overlap).
   *
   * Returns a FRESH MTV per call (when there is a hit) so callers may
   * hold the result across subsequent calls. Per-collider allocations inside
   * the loop are eliminated via scratch buffers.
   */
  static resolveEntityTileColliders(
    entity: AABB,
    tileGridX: number,
    tileGridY: number,
    tileSize: number,
    colliders: TileCollider[],
    rotation: number,
    flipH: boolean,
    flipV: boolean,
  ): MTV | null {
    let resultX = 0;
    let resultY = 0;
    let resultDepth = 0;
    let hasResult = false;

    const mtv = _scratchMTV;

    for (const collider of colliders) {
      const transformed = ColliderCollision.transformCollider(
        collider,
        tileGridX,
        tileGridY,
        tileSize,
        rotation,
        flipH,
        flipV,
      );

      if (ColliderCollision.testAABBInto(mtv, entity, transformed)) {
        if (!hasResult || mtv.depth < resultDepth) {
          resultX = mtv.x;
          resultY = mtv.y;
          resultDepth = mtv.depth;
          hasResult = true;
        }
      }
    }

    return hasResult ? { x: resultX, y: resultY, depth: resultDepth } : null;
  }

  /**
   * Build owned (non-scratch) world-space polygons for every collider on a
   * tile, transformed by flip + rotation + translation. Used to populate a
   * `TileVisual.cachedWorldPolygons` cache once at first collision so the
   * per-tick {@link resolveEntityTileColliders} path can skip the trig.
   *
   * The transform is identical to {@link transformCollider}; the result is deep-
   * copied into fresh arrays (transformCollider reuses scratch) so the cache is
   * stable across calls.
   */
  static buildWorldPolygons(
    colliders: TileCollider[],
    tileGridX: number,
    tileGridY: number,
    tileSize: number,
    rotation: number,
    flipH: boolean,
    flipV: boolean,
  ): Vec2[][] {
    const out: Vec2[][] = [];
    for (const collider of colliders) {
      const transformed = ColliderCollision.transformCollider(
        collider,
        tileGridX,
        tileGridY,
        tileSize,
        rotation,
        flipH,
        flipV,
      );
      const copy: Vec2[] = [];
      for (let i = 0; i < transformed.length; i++) {
        const p = transformed[i]!;
        copy.push({ x: p.x, y: p.y });
      }
      out.push(copy);
    }
    return out;
  }

  /**
   * Resolve an AABB against pre-transformed world-space collider polygons
   * (built once via {@link buildWorldPolygons}). Same minimum-MTV logic as
   * {@link resolveEntityTileColliders} but skips the per-call flip/rotate/translate.
   *
   * Returns a FRESH MTV per call (when there is a hit) so callers may hold the
   * result across subsequent calls.
   */
  static resolveEntityTileCollidersPolygons(entity: AABB, polygons: Vec2[][]): MTV | null {
    // Delegates through the shared loop into _scratchMTV (written only AFTER
    // the loop, so the internal per-polygon test scratch is never clobbered
    // mid-scan), then copies out into the fresh return value — the documented
    // hold-across-calls contract of this wrapper is preserved (the caller's
    // object is never a scratch).
    if (ColliderCollision.resolveEntityTileCollidersPolygonsInto(entity, polygons, _scratchMTV)) {
      return { x: _scratchMTV.x, y: _scratchMTV.y, depth: _scratchMTV.depth };
    }
    return null;
  }

  /**
   * Zero-allocation variant of {@link resolveEntityTileCollidersPolygons}
   * (`getMTVInto`/`testAABBInto` naming precedent): writes the minimum MTV
   * into the caller-owned `out` receptacle and reports whether any polygon
   * overlapped. Identical loop, identical float expressions and evaluation
   * order — the fresh-return wrapper above is a copy-out of these values.
   *
   * The per-tile enriched resolver (resolveTileCollision.ts) uses this to
   * avoid one MTV allocation per collider tile per resolve; `out` may be read
   * only while the returned boolean is true and before the next call.
   */
  static resolveEntityTileCollidersPolygonsInto(
    entity: AABB,
    polygons: Vec2[][],
    out: MTV,
  ): boolean {
    let resultX = 0;
    let resultY = 0;
    let resultDepth = 0;
    let hasResult = false;

    const mtv = _scratchMTV;

    for (let i = 0; i < polygons.length; i++) {
      if (ColliderCollision.testAABBInto(mtv, entity, polygons[i]!)) {
        if (!hasResult || mtv.depth < resultDepth) {
          resultX = mtv.x;
          resultY = mtv.y;
          resultDepth = mtv.depth;
          hasResult = true;
        }
      }
    }

    if (hasResult) {
      out.x = resultX;
      out.y = resultY;
      out.depth = resultDepth;
    }
    return hasResult;
  }

  /**
   * Transform a collider into world-space polygon points.
   *
   * Returns a reference to a module-level scratch array (`_scratchTransformed`).
   * Callers MUST consume the result before invoking this method — or any
   * method that calls it (e.g. resolveEntityTileColliders) — again, because
   * the scratch will be overwritten on the next call.
   */
  static transformCollider(
    collider: TileCollider,
    tileGridX: number,
    tileGridY: number,
    tileSize: number,
    rotation: number,
    flipH: boolean,
    flipV: boolean,
  ): Vec2[] {
    const points = ColliderCollision.colliderToPoints(collider);
    const n = points.length;
    const halfTile = tileSize / 2;
    const tileCenterX = tileGridX * tileSize + halfTile;
    const tileCenterY = tileGridY * tileSize + halfTile;
    const rad = (rotation * Math.PI) / 180;
    const cosR = Math.cos(rad);
    const sinR = Math.sin(rad);

    const out = _scratchTransformed;
    out.length = n;

    for (let i = 0; i < n; i++) {
      const p = points[i]!;
      let px = p.x;
      let py = p.y;

      if (flipH) px = tileSize - px;
      if (flipV) py = tileSize - py;

      const cx = px - halfTile;
      const cy = py - halfTile;

      const rx = cx * cosR - cy * sinR;
      const ry = cx * sinR + cy * cosR;

      let slot = out[i];
      if (slot === undefined) {
        slot = { x: 0, y: 0 };
        out[i] = slot;
      }
      slot.x = tileCenterX + rx;
      slot.y = tileCenterY + ry;
    }

    return out;
  }

  /** Even-odd point-in-polygon test against a transformed collider polygon. */
  static testPoint(px: number, py: number, polygon: Vec2[]): boolean {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const xi = polygon[i]!.x;
      const yi = polygon[i]!.y;
      const xj = polygon[j]!.x;
      const yj = polygon[j]!.y;
      if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
    return inside;
  }

  /**
   * AABB-vs-convex-polygon SAT test.
   *
   * Returns a FRESH MTV on overlap, null otherwise. Internal
   * allocations are amortised through module-level scratch — the returned
   * object is the only per-call allocation. If you don't need a fresh object
   * (e.g. you only check overlap, or consume immediately), prefer
   * `testAABBInto`.
   */
  static testAABB(entity: AABB, polygon: Vec2[]): MTV | null {
    if (!ColliderCollision.testAABBInto(_scratchMTV, entity, polygon)) return null;
    return { x: _scratchMTV.x, y: _scratchMTV.y, depth: _scratchMTV.depth };
  }

  /**
   * In-place variant of `testAABB`: writes the MTV into `out` and returns true
   * on overlap, false otherwise. No allocation in the steady state. `out` may
   * be a scratch object shared with other hot paths as long as the caller
   * consumes it before the next call into this class.
   */
  static testAABBInto(out: MTV, entity: AABB, polygon: Vec2[]): boolean {
    const aabbVerts = _scratchAABBVerts;
    aabbVerts[0]!.x = entity.x;
    aabbVerts[0]!.y = entity.y;
    aabbVerts[1]!.x = entity.x + entity.width;
    aabbVerts[1]!.y = entity.y;
    aabbVerts[2]!.x = entity.x + entity.width;
    aabbVerts[2]!.y = entity.y + entity.height;
    aabbVerts[3]!.x = entity.x;
    aabbVerts[3]!.y = entity.y + entity.height;

    const axes = _scratchAxes;
    const seen = _scratchSeen;
    const axisCount = ColliderCollision.getAxesInto(axes, seen, aabbVerts, polygon);

    let minOverlap = Infinity;
    let minAxisX = 0;
    let minAxisY = 0;
    const aabbProj = _scratchAABBProj;
    const polyProj = _scratchPolyProj;

    for (let i = 0; i < axisCount; i++) {
      const axis = axes[i]!;

      ColliderCollision.projectVerticesInto(aabbProj, aabbVerts, axis);
      ColliderCollision.projectVerticesInto(polyProj, polygon, axis);

      const overlap = Math.min(aabbProj.max - polyProj.min, polyProj.max - aabbProj.min);

      if (overlap <= 0) return false;

      if (overlap < minOverlap) {
        minOverlap = overlap;
        minAxisX = axis.x;
        minAxisY = axis.y;
      }
    }

    const aabbCenterX = entity.x + entity.width / 2;
    const aabbCenterY = entity.y + entity.height / 2;

    let polyCenterX = 0;
    let polyCenterY = 0;
    const polyLen = polygon.length;
    for (let i = 0; i < polyLen; i++) {
      polyCenterX += polygon[i]!.x;
      polyCenterY += polygon[i]!.y;
    }
    polyCenterX /= polyLen;
    polyCenterY /= polyLen;

    const dx = aabbCenterX - polyCenterX;
    const dy = aabbCenterY - polyCenterY;
    const dot = dx * minAxisX + dy * minAxisY;
    if (dot < 0) {
      minAxisX = -minAxisX;
      minAxisY = -minAxisY;
    }

    out.x = minAxisX;
    out.y = minAxisY;
    out.depth = minOverlap;
    return true;
  }

  /**
   * Convert a TileCollider to local-space polygon points.
   *
   * Returns a reference to a module-level scratch array (`_scratchPolyVerts`).
   * Callers MUST consume the result before invoking this method — or any
   * method that calls it (e.g. transformCollider) — again.
   */
  private static colliderToPoints(collider: TileCollider): Vec2[] {
    const out = _scratchPolyVerts;

    let n: number;
    if (collider.type === 'rect') {
      const r = collider as TileColliderRect;
      n = 4;
      ColliderCollision._setScratchVert(out, 0, r.x, r.y);
      ColliderCollision._setScratchVert(out, 1, r.x + r.width, r.y);
      ColliderCollision._setScratchVert(out, 2, r.x + r.width, r.y + r.height);
      ColliderCollision._setScratchVert(out, 3, r.x, r.y + r.height);
    } else {
      const poly = collider as TileColliderPoly;
      const src = poly.points;
      n = src.length;
      for (let i = 0; i < n; i++) {
        const p = src[i]!;
        ColliderCollision._setScratchVert(out, i, p.x, p.y);
      }
    }

    out.length = n;
    return out;
  }

  /**
   * Build the SAT candidate-axis set, iterating AABB and polygon edges
   * separately (no array concatenation). Clears `out` and `seen`, populates
   * `out` with unique edge normals (deduplicated by direction, treating an
   * axis and its negation as the same axis), and returns the count.
   */
  private static getAxesInto(
    out: Vec2[],
    seen: Set<number>,
    aabbVerts: Vec2[],
    polyVerts: Vec2[],
  ): number {
    seen.clear();
    let count = 0;

    // AABB edges — always 4 verts.
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      if (ColliderCollision._pushAxisIfUnique(out, seen, count, aabbVerts, i, j)) {
        count++;
      }
    }

    // Polygon edges.
    const polyLen = polyVerts.length;
    for (let i = 0; i < polyLen; i++) {
      const j = (i + 1) % polyLen;
      if (ColliderCollision._pushAxisIfUnique(out, seen, count, polyVerts, i, j)) {
        count++;
      }
    }

    out.length = count;
    return count;
  }

  /**
   * Computes the left-normal of edge (verts[i] -> verts[j]), deduplicates it
   * against already-collected axes (by direction, including negation), and
   * pushes it into `out[count]` if unique. Returns true if pushed.
   *
   * Dedup key encodes (round(nx*1e4), round(ny*1e4)) into a single number —
   * matches the precision of the previous toFixed(4) string keys without the
   * string allocation.
   */
  private static _pushAxisIfUnique(
    out: Vec2[],
    seen: Set<number>,
    count: number,
    verts: Vec2[],
    i: number,
    j: number,
  ): boolean {
    const edgeX = verts[j]!.x - verts[i]!.x;
    const edgeY = verts[j]!.y - verts[i]!.y;

    const len = Math.sqrt(edgeX * edgeX + edgeY * edgeY);
    if (len < 0.0001) return false;

    const nx = -edgeY / len;
    const ny = edgeX / len;

    // Encode (nx, ny) at toFixed(4) precision into a single safe integer key.
    // nx, ny are unit-vector components ∈ [-1, 1], so kx, ky ∈ [-10000, 10000].
    // Shift by +10000 to make them non-negative, then pack with a base > 20001
    // so the (kx, ky) pair round-trips uniquely.
    const kx = Math.round(nx * 10000);
    const ky = Math.round(ny * 10000);
    const posKey = (kx + 10000) * 20001 + (ky + 10000);
    const negKey = (-kx + 10000) * 20001 + (-ky + 10000);

    if (seen.has(posKey) || seen.has(negKey)) return false;
    seen.add(posKey);

    let slot = out[count];
    if (slot === undefined) {
      slot = { x: 0, y: 0 };
      out[count] = slot;
    }
    slot.x = nx;
    slot.y = ny;
    return true;
  }

  /**
   * Project `vertices` onto `axis`, writing the min/max projection into
   * `out`. Avoids allocating a {min, max} object per call.
   */
  private static projectVerticesInto(out: ProjRange, vertices: Vec2[], axis: Vec2): void {
    let min = Infinity;
    let max = -Infinity;
    const ax = axis.x;
    const ay = axis.y;
    for (let i = 0; i < vertices.length; i++) {
      const v = vertices[i]!;
      const proj = v.x * ax + v.y * ay;
      if (proj < min) min = proj;
      if (proj > max) max = proj;
    }
    out.min = min;
    out.max = max;
  }

  /** Helper: write (x, y) into a scratch array slot, creating it if needed. */
  private static _setScratchVert(arr: Vec2[], i: number, x: number, y: number): void {
    let slot = arr[i];
    if (slot === undefined) {
      slot = { x: 0, y: 0 };
      arr[i] = slot;
    }
    slot.x = x;
    slot.y = y;
  }
}
