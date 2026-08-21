/**
 * World-entity rendering — destructibles, chests, exits.
 *
 * Each function body is byte-identical to the original
 * `EntityRendererLifecycle` method, with `this.` → `lifecycle.`. Behavior is
 * provably preserved by construction (no texture/scale/position/tint changes).
 */
import Phaser from 'phaser';
import type { DestructibleState, ChestState, ExitState } from '../types.js';
import { CHEST_TIER_COLORS, DESTRUCTIBLE_TYPE_LIGHT } from '../types.js';
import { createEntitySprite, hasEntitySprite } from './EntityTypes.js';
import type { EntityRendererLifecycle } from './EntityRendererLifecycle.js';

/**
 * Warm base material tints for breakable destructibles, keyed by entity type, so
 * players can spot at a glance what they can destroy. Each reddens toward
 * DESTRUCTIBLE_DAMAGE_TINT and fades as HP drops (live damage feedback).
 * Indestructible walls/crates (type 2) instead keep the cool INDESTRUCTIBLE_TINT.
 */
const DESTRUCTIBLE_BASE_TINT: Record<number, number> = {
  0: 0xe6a23c, // crate  — warm amber (breakable loot)
  1: 0xff7a45, // barrel — explosive orange
  3: 0xc8a06e, // breakable wall — brown
};
const DESTRUCTIBLE_DAMAGE_TINT = 0xff4040;

const INDESTRUCTIBLE_TINT = 0xbbbbcc;

/**
 * Map-redesign ticket 07 / DEC-006: live indestructible entities tint with
 * their district's identity-sheet wall tint. The lookup is injected once at
 * map load (GameSceneSetup, from the server-authored `sectorTypes` grid) —
 * null on demo-TMX maps keeps the legacy global grey.
 */
let sectorWallTintLookup: ((worldX: number, worldY: number) => number) | null = null;

/** Inject the per-district wall tint lookup (called once when mapData lands). */
export function setSectorWallTintLookup(
  lookup: ((worldX: number, worldY: number) => number) | null,
): void {
  sectorWallTintLookup = lookup;
}

/** The district wall tint for a world position (global-grey fallback). */
function districtWallTint(worldX: number, worldY: number): number {
  return sectorWallTintLookup ? sectorWallTintLookup(worldX, worldY) : INDESTRUCTIBLE_TINT;
}

/** Linear blend between two packed 0xRRGGBB colours (t in [0,1]). */
function lerpColor(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 0xff;
  const ag = (a >> 8) & 0xff;
  const ab = a & 0xff;
  const r = Math.round(ar + (((b >> 16) & 0xff) - ar) * t);
  const g = Math.round(ag + (((b >> 8) & 0xff) - ag) * t);
  const bl = Math.round(ab + ((b & 0xff) - ab) * t);
  return (r << 16) | (g << 8) | bl;
}

/**
 * A breakable destructible's tint at the given HP fraction: its warm base
 * material, reddening below 60% HP (full red-ish at 0).
 */
function destructibleTint(type: number, hpPct: number): number {
  const base = DESTRUCTIBLE_BASE_TINT[type] ?? 0xffffff;
  const t = Math.min(1, Math.max(0, (0.6 - hpPct) / 0.6));
  return lerpColor(base, DESTRUCTIBLE_DAMAGE_TINT, t);
}

/** Pulsing tint used while a chest is opening. */
function pulseTint(sprite: Phaser.GameObjects.Sprite): void {
  const t = (Math.sin(performance.now() / 150) + 1) / 2;
  const r = Math.floor(0xff * (1 - t) + 0xff * t);
  const g = Math.floor(0xaa * (1 - t) + 0xff * t);
  sprite.setTint((r << 16) | (g << 8) | 0);
}

/* ── Destructible ───────────────────────────────────────── */

export function addDestructible(
  lifecycle: EntityRendererLifecycle,
  key: string,
  d: DestructibleState,
): void {
  // Juice-pass-1 ticket 06 — feed the primed-fire effect FIRST (a late joiner
  // can receive an already-primed barrel in its initial snapshot, so the
  // onAdd must carry it, not just onChange). Server-state driven; no-op for
  // everything that is not a primed barrel.
  lifecycle.vfx.barrelFuse.syncPrimed(key, d);
  if (lifecycle.entities.has(key)) return;
  // Map-polish ticket 08 — RENDER OWNERSHIP: converted light props (wire type
  // 4, hydrated by ticket 07) never enter the generic destructible sprite
  // path. Their fixture art lives in the `lightProps` atlas and is owned by
  // `LightPropRenderer` (the campfire precedent: fixture sprites are
  // placement-owned) — the fallback here would resolve to a bogus
  // 'crate_small' from the `game` atlas and double-render under the fixture.
  // A sprite-less registry record (the ExplosionEntityVisual pattern) keeps
  // the entity tracked so the destroy→light-off chain can read its tile.
  if (d.type === DESTRUCTIBLE_TYPE_LIGHT) {
    lifecycle.entities.set(key, { type: 'light-prop', x: d.x, y: d.y });
    return;
  }
  const isWall = d.type === 3;
  const fallback = lifecycle.resolver.destructibleTexture(d.type);

  // Breakable walls ARE the single render element: one live entity sprite that
  // carries the server-authoritative autotiled art (texture + rotation + flip
  // from the `map_border_walls` layer) AND the damage feedback. They are no
  // longer baked into the static map layer, so there is no duplicate underneath.
  let textureKey: string;
  let rotation: number;
  let flipH: boolean;
  let flipV: boolean;
  if (isWall) {
    const ts = lifecycle.mapRenderer?.getTileSize() ?? 128;
    const gridX = Math.floor(d.x / ts);
    const gridY = Math.floor(d.y / ts);
    const wv = lifecycle.mapRenderer?.getWallVisualAt(gridX, gridY);
    textureKey = lifecycle.resolver.safeTexture(
      wv?.textureKey ?? d.textureKey ?? fallback,
      fallback,
    );
    rotation = wv ? (wv.rotation * Math.PI) / 180 : d.rotation;
    flipH = wv ? wv.flipH : d.flipH;
    flipV = wv ? wv.flipV : d.flipV;
    lifecycle.wallEntityPositions.set(key, { gridX, gridY });
  } else {
    const resolved = lifecycle.resolver.resolveEntityVisual(d.x, d.y, d.textureKey, fallback);
    textureKey = lifecycle.resolver.safeTexture(resolved.textureKey, fallback);
    rotation = d.rotation;
    flipH = d.flipH;
    flipV = d.flipV;
  }

  const sprite = createEntitySprite(lifecycle.scene, d.x, d.y, textureKey, {
    rotation,
    flipH,
    flipV,
    depth: 5,
  });
  if (!sprite) return;

  const hpPct = d.maxHp > 0 ? d.hp / d.maxHp : 1;
  if (d.type === 2) {
    // Indestructible wall/crate — the district's identity-sheet wall tint
    // (ticket 07; cool blue-grey global fallback), no damage feedback.
    sprite.setTint(districtWallTint(d.x, d.y));
  } else {
    // Crate, barrel and breakable wall all share a warm "destructible" material
    // (distinct per type) that reddens with HP, so players can spot — and read
    // the health of — anything they can break. Alpha stays at 1 (opaque); the
    // tint is the sole damage signal.
    sprite.setTint(destructibleTint(d.type, hpPct));
  }
  sprite.setAlpha(1);

  lifecycle.entities.set(key, { sprite, type: 'destructible' });
}

export function removeDestructible(lifecycle: EntityRendererLifecycle, key: string): void {
  lifecycle.prevDestructibleHp.delete(key);
  lifecycle.wallEntityPositions.delete(key);
  lifecycle.vfx.destruction.onRemove(key);
  // Juice-pass-1 ticket 06 — the primed fire must never outlive the entity:
  // the server removed this destructible (fuse detonation, second hit, chain),
  // so its fire stops HERE (the "ghost arms" bug-class guard).
  lifecycle.vfx.barrelFuse.onRemove(key);
  lifecycle.removeEntity(key);
}

export function updateDestructible(
  lifecycle: EntityRendererLifecycle,
  key: string,
  d: DestructibleState,
): void {
  // Juice-pass-1 ticket 06 — the priming hit lands as a schema change
  // (primed=false → true); feed the effect before any sprite-early-return so
  // the escalation is purely server-state driven.
  lifecycle.vfx.barrelFuse.syncPrimed(key, d);
  const prevHp = lifecycle.prevDestructibleHp.get(key);
  if (prevHp != null && d.hp < prevHp && !d.isDestroyed) {
    const e = lifecycle.entities.get(key);
    if (hasEntitySprite(e)) {
      lifecycle.vfx.destruction.spawn({
        kind: 'shake',
        key,
        sprite: e.sprite as Phaser.GameObjects.Sprite,
      });
    }
  }
  lifecycle.prevDestructibleHp.set(key, d.hp);
  const e = lifecycle.entities.get(key);
  if (!hasEntitySprite(e)) return;
  if (d.isDestroyed) {
    e.sprite.setAlpha(1);
  } else {
    const hpPct = d.maxHp > 0 ? d.hp / d.maxHp : 1;
    e.sprite.setAlpha(1);
    // Breakable destructibles keep their warm material and redden as they near
    // collapse; indestructibles (type 2) keep their fixed cool tint.
    if (d.type !== 2) {
      (e.sprite as Phaser.GameObjects.Sprite).setTint(destructibleTint(d.type, hpPct));
    }
  }
}

/**
 * Re-evaluate `getWallVisualAt()` for every tracked wall entity and patch the
 * sprite's texture, rotation, and flip. Called from `setMapRenderer()` — the
 * moment `mapData` arrives and the `map_border_walls` visual layer becomes
 * available. Wall entities created before that moment fall back to
 * `wall_damaged`; this corrects them to the server-authoritative autotiled art.
 */
export function refreshWallVisuals(lifecycle: EntityRendererLifecycle): void {
  if (!lifecycle.mapRenderer) return;
  const fallback = lifecycle.resolver.destructibleTexture(3);
  for (const [key, pos] of lifecycle.wallEntityPositions) {
    const visual = lifecycle.entities.get(key);
    if (!hasEntitySprite(visual)) {
      lifecycle.wallEntityPositions.delete(key);
      continue;
    }
    const wv = lifecycle.mapRenderer.getWallVisualAt(pos.gridX, pos.gridY);
    if (!wv) continue;
    const sprite = visual.sprite as Phaser.GameObjects.Sprite;
    const textureKey = lifecycle.resolver.safeTexture(wv.textureKey, fallback);
    if (lifecycle.scene.textures.get('game').has(textureKey)) {
      sprite.setTexture('game', textureKey);
    }
    sprite.setRotation((wv.rotation * Math.PI) / 180);
    sprite.setScale(wv.flipH ? -1 : 1, wv.flipV ? -1 : 1);
  }
}

/* ── Chest ──────────────────────────────────────────────── */

export function addChest(lifecycle: EntityRendererLifecycle, key: string, c: ChestState): void {
  if (lifecycle.entities.has(key)) return;
  const { textureKey } = lifecycle.resolver.resolveEntityVisual(c.x, c.y, c.textureKey, 'chest');
  const actualKey = lifecycle.resolver.safeTexture(textureKey, 'crate');
  const color = CHEST_TIER_COLORS[c.tier] ?? 0x8b4513;
  const sprite = createEntitySprite(lifecycle.scene, c.x, c.y, actualKey, {
    rotation: c.rotation,
    flipH: c.flipH,
    flipV: c.flipV,
    depth: 5,
  });
  if (!sprite) return;
  sprite.setTint(color);
  lifecycle.entities.set(key, { sprite, type: 'chest' });
}

export function removeChest(lifecycle: EntityRendererLifecycle, key: string): void {
  lifecycle.removeEntity(key);
}

export function updateChest(lifecycle: EntityRendererLifecycle, key: string, c: ChestState): void {
  const e = lifecycle.entities.get(key);
  if (!hasEntitySprite(e)) return;
  if (c.state === 1) {
    // Opening: keep the chest fully opaque (per ruling — no transparency
    // progression). The yellow↔green pulse tint is the visual feedback that
    // opening is in progress; the progress timer lives on the interaction
    // prompt (`InteractionDetector`).
    pulseTint(e.sprite as Phaser.GameObjects.Sprite);
  }
}

/* ── Exit ───────────────────────────────────────────────── */

export function addExit(lifecycle: EntityRendererLifecycle, key: string, e: ExitState): void {
  if (lifecycle.entities.has(key)) return;
  const openKey =
    e.textureKey && lifecycle.scene.textures.get('game').has(e.textureKey)
      ? e.textureKey
      : 'door_open';
  const closedKey = lifecycle.resolver.safeTexture('door_closed', 'crate');
  const texKey = e.active ? lifecycle.resolver.safeTexture(openKey, 'door_open') : closedKey;
  const sprite = createEntitySprite(lifecycle.scene, e.x, e.y, texKey, {
    rotation: e.rotation,
    flipH: e.flipH,
    flipV: e.flipV,
    depth: 4,
  });
  if (!sprite) return;
  if (e.active) {
    sprite.setTint(0x44ffaa);
  } else {
    sprite.setAlpha(0.4);
  }
  lifecycle.entities.set(key, { sprite, type: 'exit', active: e.active });
}

export function removeExit(lifecycle: EntityRendererLifecycle, key: string): void {
  lifecycle.removeEntity(key);
}

export function updateExit(lifecycle: EntityRendererLifecycle, key: string, e: ExitState): void {
  const ent = lifecycle.entities.get(key);
  if (!hasEntitySprite(ent)) {
    addExit(lifecycle, key, e);
    return;
  }
  ent.sprite.setPosition(e.x, e.y);
  ent.active = e.active;
  const s = ent.sprite as Phaser.GameObjects.Sprite;
  const openKey =
    e.textureKey && lifecycle.scene.textures.get('game').has(e.textureKey)
      ? e.textureKey
      : 'door_open';
  const closedKey = lifecycle.resolver.safeTexture('door_closed', 'crate');
  const texKey = e.active ? lifecycle.resolver.safeTexture(openKey, 'door_open') : closedKey;
  if (s.frame.name !== texKey && lifecycle.scene.textures.get('game').has(texKey)) {
    s.setTexture('game', texKey);
  }
  if (e.active) {
    s.setTint(0x44ffaa);
    s.setAlpha(1);
  } else {
    s.clearTint();
    s.setAlpha(0.4);
  }
}

/* ── Misc helpers ───────────────────────────────────────── */

export function getDestructiblePosition(
  lifecycle: EntityRendererLifecycle,
  key: string,
): { x: number; y: number } | null {
  const e = lifecycle.entities.get(key);
  if (hasEntitySprite(e)) return { x: e.sprite.x, y: e.sprite.y };
  // Ticket 08: light props carry no sprite — the record itself holds the
  // server-authoritative position the removal handler needs for the dust
  // cloud + the tile-keyed light-off hook.
  if (e && e.type === 'light-prop') return { x: e.x, y: e.y };
  return null;
}

/**
 * Whether the tracked destructible is a converted light prop (ticket 08).
 * Read by `DestructibleStateHandlers.onDestructibleRemove` BEFORE removal:
 * light props are NON-SOLID (their tile is EMPTY, ticket 07), so the handler
 * must skip `mapRenderer.clearGridCell` for them — the call would not only
 * pointlessly rewrite an already-walkable cell but also paint the dark
 * clear-rect over the tile's baked floor art in the base render texture.
 */
export function isLightPropEntity(lifecycle: EntityRendererLifecycle, key: string): boolean {
  const e = lifecycle.entities.get(key);
  return e !== undefined && e.type === 'light-prop';
}

export function getChestPosition(
  lifecycle: EntityRendererLifecycle,
  key: string,
): { x: number; y: number } | null {
  const e = lifecycle.entities.get(key);
  if (hasEntitySprite(e)) return { x: e.sprite.x, y: e.sprite.y };
  return null;
}
