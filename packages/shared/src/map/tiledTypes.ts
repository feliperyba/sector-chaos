import { TileType } from '../enums/TileType.js';
import { TrapType } from '../enums/TrapType.js';
import { WeaponTier } from '../enums/WeaponTier.js';
import { WeaponType } from '../enums/WeaponType.js';

export interface TileColliderRect {
  type: 'rect';
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TileColliderPoly {
  type: 'polygon';
  points: Array<{ x: number; y: number }>;
}

export type TileCollider = TileColliderRect | TileColliderPoly;

export interface TileSpriteDef {
  id: number;
  imagePath: string;
  tileType: TileType;
  colliders: TileCollider[];
}

export interface TileVisual {
  spriteId: number;
  rotation: 0 | 90 | 180 | 270;
  flipH: boolean;
  flipV: boolean;
  /**
   * Lazily-built, position-specific cache of this tile's colliders pre-
   * transformed into world-space polygons (`colliders[i]` → `polygons[i]`).
   * Built once on first collision check and reused every tick thereafter,
   * avoiding per-tick trig for static geometry. Undefined until first use (or
   * when the visual has no colliders). Lives on the visual because each cell's
   * visual object is at a fixed grid position, so the baked-in translation is
   * position-correct.
   */
  cachedWorldPolygons?: Array<Array<{ x: number; y: number }>>;
}

export interface WeaponPlacement {
  gridX: number;
  gridY: number;
  weaponType: WeaponType;
  tier?: WeaponTier;
  textureKey: string;
  rotation: number;
  flipH: boolean;
  flipV: boolean;
}

export interface TrapPlacementTiled {
  gridX: number;
  gridY: number;
  trapType: TrapType;
  textureKey: string;
  rotation: number;
  flipH: boolean;
  flipV: boolean;
}

export interface DestructiblePlacement {
  gridX: number;
  gridY: number;
  tileType: TileType;
  textureKey: string;
  rotation: number;
  flipH: boolean;
  flipV: boolean;
}

export interface ChestPlacement {
  gridX: number;
  gridY: number;
  textureKey: string;
  rotation: number;
  flipH: boolean;
  flipV: boolean;
}

export interface ExitPlacement {
  gridX: number;
  gridY: number;
  textureKey: string;
  rotation: number;
  flipH: boolean;
  flipV: boolean;
}

/**
 * The light-prop kind discriminator. The client resolves the full visual tuning
 * (palette RGB, corePower, haloFrac, specPower, radius, intensity, cookie
 * index, flicker) from this single value — keeping the wire payload minimal.
 * See `docs/specs/lighting-system.md` "Map-gen light data contract".
 *
 * Ticket 08 (A4): added `fireplace`, `brazier`, `lantern` — the three fire-source
 * kinds the audit found MISSING ENTIRELY (no kind, no placer weight, no palette
 * entry, no prop, no anim). Each inherits the radius/diffuseness conventions
 * from ticket 07 (wider + softer + dimmer absolute; radii in tiles):
 *   - `fireplace` ~320px (2.5 tiles) — large, indoor, slow roar. Reuses the
 *     `campfire` sprite (the fireplace read relies on wall-adjacent indoor
 *     PLACEMENT in ticket 10, not sprite distinction per REVIEW item B2).
 *   - `brazier`  ~240px (1.875 tiles) — medium, junction/plaza, steady-medium.
 *     Distinct procedural sprite (dark-fantasy medieval bowl-of-coals).
 *   - `lantern`  ~140px (1.09 tiles) — small, corridor, very steady. Distinct
 *     procedural sprite (enclosed flame behind glass).
 *
 * Map-redesign ticket 04 (DEC-002/005): added `beacon` — the hero-landmark
 * destination light. Theme-colored via the per-placement `color` override
 * (the sector type's identity hue — hue=theme, value=tier, map-polish
 * ticket 03), radius ≥ 512 via the `radius` override, slow pulse
 * via the `pulse` flag; the per-map placements are appended by the map
 * enrichment from `MapData.landmarks` (NOT the sconce placer). Emits no flame
 * flicker (a beacon breathes, it does not gutter).
 *
 * Lighting is cosmetic-only (GDD `docs/GDD.md:210` forbids fog of war): these
 * placements carry no gameplay semantics, only a visual hint.
 */
export type LightKind =
  | 'torch'
  | 'campfire'
  | 'candle'
  | 'biome-glow'
  | 'barrel-fire'
  | 'fireplace'
  | 'brazier'
  | 'lantern'
  | 'beacon';

/**
 * The flame-bearing subset of {@link LightKind} — kinds that have a real fire
 * (a multi-octave flicker + a flame sprite anim). Ticket 08 (A4): extended with
 * `fireplace`, `brazier`, `lantern` (each gets its own flicker profile +
 * sprite). Excludes `biome-glow` (a steady magical glow, not a flame) and
 * `barrel-fire` (barrels are inert until they explode — the explosion is a
 * single pulse, not a flicker; no steady-state barrel-fire flame).
 *
 * This lives in the shared package so both the client flicker-config table
 * (`TorchFlicker.FLICKER_PROFILES`) and the client prop-resolver
 * (`LightPropResolver.LIGHT_PROP_ANIMS`) reference the canonical flame-kind
 * set. The client-only `'fire-trap'` dynamic kind is appended in
 * `TorchFlicker.FlickerFlameKind`.
 */
export type FlameKind = 'torch' | 'campfire' | 'candle' | 'fireplace' | 'brazier' | 'lantern';

/**
 * Placement PROVENANCE for a {@link LightPlacementTiled} — which motivated
 * anchor emitted it (map-polish ticket 07). `kind` alone CANNOT discriminate
 * the light-prop entity conversion set: doorway, route-mid and dark-gap fill
 * sconces all draw from the same sconce-kind mix, so the exemption list
 * ("beacons + corridor passages ONLY") needs the anchor that produced the
 * placement:
 *
 *   - `'doorway'` — corridor-passage sconce PAIRS (Anchor B, derived from
 *     `mapData.connections`). **EXEMPT** — stays baked static (owner ruling).
 *   - `'route'` / `'fill'` / `'poi-pool'` / `'crystal'` — **CONVERT**: each
 *     hydrates as a `'light'` destructible entity at its tile
 *     (`LIGHT_PROP_ENTITY_ANCHORS`).
 *   - `'campfire'` — 1:1 on an existing crate entity; keeps its existing
 *     backing (no light-prop entity).
 *   - beacons carry NO anchor — they stay kind-identified and baked (exempt).
 *
 * Pure label emitted by the existing zero-RNG geometry passes / isolated
 * salted streams (ADR-0035): zero new RNG draws, so placements stay
 * byte-identical per seed.
 */
export type LightAnchor = 'doorway' | 'route' | 'fill' | 'poi-pool' | 'crystal' | 'campfire';

/**
 * The anchors whose placements convert to `'light'` destructible entities
 * (map-polish ticket 07) — everything EXCEPT the exemptions: doorway sconces
 * (corridor-passage carve-out) and campfires (already entities via their
 * crate tiles). Beacons are kind-identified and never carry an anchor.
 */
export const LIGHT_PROP_ENTITY_ANCHORS: ReadonlySet<LightAnchor> = new Set([
  'route',
  'fill',
  'poi-pool',
  'crystal',
]);

/**
 * Whether a placement hydrates as a `'light'` destructible entity (ticket 07):
 * a convertible anchor. Exempt placements (beacons — no anchor; doorway
 * sconces; campfires) return false and stay baked/already-backed.
 */
export function isLightPropEntityPlacement(placement: LightPlacementTiled): boolean {
  return placement.anchor !== undefined && LIGHT_PROP_ENTITY_ANCHORS.has(placement.anchor);
}

/**
 * The BAKED-exemption data table (map-polish ticket 09) — the placements that
 * stay static light data FOREVER, never hydrating any destructible entity.
 * This is the owner's carve-out encoded as data ("minus the beacons and
 * corridor passages"), and it is the audit gate's exemption reference:
 *
 *   - `LIGHT_BAKED_EXEMPT_KINDS` — kind-identified exemptions (beacons: the
 *     hero/fortress/minor markers; they never carry an `anchor`).
 *   - `LIGHT_BAKED_EXEMPT_ANCHORS` — anchor-identified exemptions (the
 *     corridor-passage doorway sconce pairs, Anchor B / `mapData.connections`
 *     derived).
 *
 * NOTHING else is baked-exempt. Campfires are NOT in this table — they are
 * entity-backed (their crate tiles), i.e. backed by a NON-light destructible
 * rather than baked; the no-unbacked-lights audit
 * (`auditLightPropBacking`, server) checks that crate backing separately.
 * The authoritative per-light-type exemption inventory is the map-polish
 * research digest `D-destructible-light-props.md` §1 exemption table.
 */
export const LIGHT_BAKED_EXEMPT_KINDS: ReadonlySet<LightKind> = new Set(['beacon']);

export const LIGHT_BAKED_EXEMPT_ANCHORS: ReadonlySet<LightAnchor> = new Set(['doorway']);

/**
 * Whether a placement is in the BAKED exemption set (ticket 09) — stays static
 * light data, requires no backing destructible entity of any kind, and must
 * NEVER hydrate a `'light'` entity (the audit gate's over-conversion guard).
 * Exactly `kind ∈ LIGHT_BAKED_EXEMPT_KINDS` OR
 * `anchor ∈ LIGHT_BAKED_EXEMPT_ANCHORS`; nothing else qualifies.
 */
export function isBakedExemptLightPlacement(placement: LightPlacementTiled): boolean {
  return (
    LIGHT_BAKED_EXEMPT_KINDS.has(placement.kind) ||
    (placement.anchor !== undefined && LIGHT_BAKED_EXEMPT_ANCHORS.has(placement.anchor))
  );
}

/**
 * A deterministic, server-emitted light-prop placement in tile-grid coords.
 *
 * Mirrors the sibling `*Placement` shapes (grid coords + sprite transform +
 * type discriminator) so it slots into `TiledEntityPlacements` with no
 * friction. The client converts grid → world px at light-setup time:
 * `worldX = gridX * tileSize + tileSize/2` (the same formula `MapRenderer`
 * uses for the siblings).
 *
 * All randomness is resolved server-side at gen time; the wire payload is
 * fully determined by the map seed (isolated RNG stream, see LightPlacer).
 */
export interface LightPlacementTiled {
  gridX: number;
  gridY: number;
  kind: LightKind;
  /**
   * OPTIONAL placement PROVENANCE (map-polish ticket 07) — which motivated
   * anchor emitted this placement. Discriminates the light-prop entity
   * conversion set where `kind` cannot (doorway/route/fill share the sconce
   * kind mix): `LIGHT_PROP_ENTITY_ANCHORS` placements hydrate as `'light'`
   * destructible entities; `anchor: 'doorway'` and campfires stay baked /
   * already-backed; beacons carry no anchor (kind-identified). Zero RNG —
   * the label rides the existing geometry passes (ADR-0035). Serialized in
   * the one-shot `mapData` payload (PIPELINE_VERSION 6 shape change).
   */
  anchor?: LightAnchor;
  /**
   * OPTIONAL per-placement light color override (linear RGB, `[0,1]`). When set,
   * the packer (`LightPacker.packLights`) + the prop renderer
   * (`LightPropRenderer.spawn`) use THIS color instead of the kind's palette
   * color — so two placements of the same `kind` can carry different hues. The
   * menu diorama uses this for its 2-tone system: every WARM fixture is forced
   * to one campfire-orange (tone 1) + every `biome-glow` crystal carries its
   * variant's signature hue (tone 2). In-game map-gen placements NEVER set this
   * (the server emits `{ gridX, gridY, kind, ... }` with no color), so they
   * fall through to `LightPalette[kind].color` unchanged — zero gameplay
   * regression. Cosmetic-only.
   */
  color?: readonly [number, number, number];
  /** OPTIONAL atlas frame for the visible prop sprite; if omitted, pure light. */
  textureKey?: string;
  rotation: number;
  flipH: boolean;
  flipV: boolean;
  /**
   * OPTIONAL ambient-scatter flag (ticket 17). When true this placement is a
   * light-only "fill" mood light (the prototype's `remaining` loop,
   * `prototype.js:604-614`), NOT a motivated fixture: no visible prop sprite is
   * spawned for it, and the client budget trims it FIRST (lowest priority) when
   * the on-screen count exceeds the ≤80 target. Cosmetic-only — mood, not
   * vision. Defaults to false (omitted by the existing per-prop placer).
   */
  isScatter?: boolean;
  /**
   * OPTIONAL per-placement light RADIUS override (world px). When set, the
   * packer (`LightPacker.packLights`) uses THIS radius instead of
   * `HERO_LIGHT_OVERRIDES[kind]?.radius` — so the menu diorama can tighten
   * support radii menu-locally WITHOUT touching the shared gameplay hero
   * config. In-game map-gen placements NEVER set this (server emits none) →
   * zero gameplay regression. Cosmetic-only. Mirrors the `color` override
   * precedent above.
   */
  radius?: number;
  /**
   * OPTIONAL per-placement light INTENSITY override (linear, multiplied by the
   * kind's flicker). When set, the packer uses THIS base intensity instead of
   * `HERO_LIGHT_OVERRIDES[kind]?.intensity` — so the menu diorama can enforce a
   * campfire-dominant hierarchy (supports at ~50% of the hero) menu-locally
   * WITHOUT touching shared gameplay config. In-game map-gen placements NEVER
   * set this → zero gameplay regression. Cosmetic-only.
   */
  intensity?: number;
  /**
   * OPTIONAL slow-breath PULSE flag. When true, the packer folds a slow sine
   * (`~0.4Hz`, amplitude ~±18%, per-placement phase via the grid-coord seed) on
   * top of the base intensity so the light disk breathes instead of sitting
   * flat. Used by the menu diorama's `biome-glow` crystals (otherwise excluded
   * from `FLICKER_KINDS` → perfectly steady, the scene's most obvious
   * stillness). In-game map-gen placements NEVER set this → zero gameplay
   * regression. Cosmetic-only.
   */
  pulse?: boolean;
}

export interface TiledEntityPlacements {
  weapons: WeaponPlacement[];
  spawnPoints: { gridX: number; gridY: number }[];
  traps: TrapPlacementTiled[];
  destructibles: DestructiblePlacement[];
  chests: ChestPlacement[];
  powerups: Array<{
    gridX: number;
    gridY: number;
    textureKey: string;
    rotation: number;
    flipH: boolean;
    flipV: boolean;
  }>;
  exits: ExitPlacement[];
  /**
   * Deterministic light-prop placements (torches, campfires, etc.) added by the
   * `LightPlacer`. Cosmetic-only — carries no gameplay semantics. Wired through
   * the one-shot `mapData` Colyseus message (NOT per-tick schema).
   */
  lightPlacements: LightPlacementTiled[];
}

export interface TileSpriteAtlas {
  sprites: TileSpriteDef[];
}

export interface TileColliderData {
  atlas: TileSpriteAtlas;
  visuals: TileVisual[][];
  tileSize: number;
}

export interface EnrichedMapData {
  grid: TileType[][];
  visualLayers: TiledMapLayer[];
  atlas: TileSpriteAtlas;
  width: number;
  height: number;
  tileSize: number;
  seed: number;
  entities: TiledEntityPlacements;
  /**
   * Map-redesign ticket 05 (DEC-005 #5) — the hue-discipline enforcement
   * record: discretionary biome crystals dropped at map-build time because
   * their sector would have exceeded the ≤3-active-light-hue-families-per-
   * viewport gate (the beacon/minor/sconce layers are never dropped).
   * Server-authoritative placement metadata for the benchmark generation
   * manifest; NOT sent to clients (the enforced `lightPlacements` are).
   */
  lightingEnforcements?: Array<{
    sectorRow: number;
    sectorCol: number;
    droppedKind: LightKind;
    droppedAt: { gridX: number; gridY: number };
    families: Array<'warm' | 'green' | 'teal' | 'blue' | 'violet'>;
  }>;
}

export interface TiledMapLayer {
  name: string;
  cells: (TileVisual | null)[][];
}

export function emptyTileVisual(): TileVisual {
  return { spriteId: -1, rotation: 0, flipH: false, flipV: false };
}

/**
 * Select the canonical {@link TileVisual} for one grid cell from a stack of
 * visual layers — the SINGLE source of truth for the "which visual represents
 * this tile" predicate, shared by the server's `buildMergedVisuals` (pre-merge
 * at map load) and the client's `ClientCollisionService.findCellVisual`
 * (per-query at collision time). Both collision paths MUST resolve a tile to
 * the same visual or the local player's prediction diverges from the
 * authoritative server position (the netcode stutter root cause).
 *
 * Rule: the LAST layer (in array order) carrying a cell with `spriteId >= 0`
 * wins. Layer order is load-bearing — `[floor, decoration, wall_fill,
 * map_border_walls, interactive_layer]` (SeedMapAdapter) — so walls/interactive
 * override the floor/decoration/fill beneath them (the ticket-13 `wall_fill`
 * under-layer is EMPTY-type and always shadowed by the wall cell above it).
 * The floor layer paints an EMPTY-type,
 * zero-collider cell under EVERY tile (FloorSpriteSelector.select); a
 * first-wins rule would return that floor cell for any tile that also has a
 * wall cell, and the enriched resolver would then short-circuit on the floor's
 * empty colliders — the client would predict straight through grid-marked
 * walls the server blocks. See collision-divergence.test.ts.
 *
 * Returns `null` when no layer carries a usable cell; callers treat
 * `null` / `spriteId < 0` identically (AABB fallback or skip).
 */
export function selectTileVisual(
  layers: readonly TiledMapLayer[],
  gridX: number,
  gridY: number,
): TileVisual | null {
  let best: TileVisual | null = null;
  for (const layer of layers) {
    const cell = layer.cells[gridY]?.[gridX];
    if (cell && cell.spriteId >= 0) best = cell;
  }
  return best;
}

export function createSiegeWallSpriteDef(tileSize: number): TileSpriteDef {
  return {
    id: -1,
    imagePath: 'coffin',
    tileType: TileType.INDESTRUCTIBLE_WALL,
    colliders: [{ type: 'rect', x: 0, y: 0, width: tileSize, height: tileSize }],
  };
}
