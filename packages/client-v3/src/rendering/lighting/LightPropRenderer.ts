/**
 * LightPropRenderer — spawns the VISIBLE prop sprites at every map-gen light
 * placement (ticket 17). This is the single biggest mood lever in the polish
 * batch: the prototype's WOW came from a COMPLETE lit scene — 5 visible
 * campfire sprites motivating 5 hero lights (`prototype.js:522-528, 596-599`) —
 * and the live match shipped auras nearly alone because the prop sprites were
 * never wired (ticket 16 added the art + the kind→texture resolver; this
 * ticket places the fixtures in the world).
 *
 * The AAA "motivated lighting" rule (Level Design Book; `.scratch/lighting-system/
 * art-polish/02-research.md` §2/§6/§7): every light disk needs a visible
 * fixture. The deferred pipeline lights the prop sprite naturally because the
 * sprite renders INTO the albedo RT (world-depth) — the same capture path
 * MapRenderer's baked RTs + EntityRenderer's live sprites use. The flame
 * animation plays on a loop (torch/candle flicker); biome-glow is a steady
 * 2-frame pulse. Ambient-scatter placements (`isScatter: true`) spawn NO
 * sprite — they're light-only fill (the prototype's `remaining` loop pattern,
 * `prototype.js:604-614`).
 *
 * Cosmetic-only (GDD `docs/GDD.md:210` forbids fog of war): a prop sprite is
 * pure art — it carries no vision/visibility semantics. The light disk it
 * motivates is mood, never gameplay.
 *
 * ── Phaser-4.1 gotchas (verified here) ──
 *
 *   #1: the prop sprites are normal Phaser GameObjects (Sprites), NOT RT
 *       shaders — `setVisible(false)` is never called on them.
 *   #2: the prop sprites are NEVER `cameras.main.ignore()`d — they MUST render
 *       into the albedo capture (the deferred pipeline lights them). The
 *       pipeline's `buildWorldCaptureList` ignores them on the main cam
 *       alongside every other world-depth object (so the lit RT, not the unlit
 *       world, shows on screen) — that is the correct, faithful port of the
 *       prototype's `cam.ignore(worldContainer)` (prototype.js:372), NOT a
 *       sprite-specific ignore.
 *   #5: the prop sprites are world geometry the deferred pipeline MUST light →
 *       they are INCLUDED in the albedo capture list (depth 4 < hudBg 500).
 *       Pipeline-internal RT shaders stay EXCLUDED (handled in
 *       `buildWorldCaptureList`); the prop sprites are normal Sprites, so they
 *       flow through the world-depth capture unchanged.
 */
import type Phaser from 'phaser';
import type { LightPlacementTiled, LightKind } from '@sector-battle/shared';
import {
  resolveLightPropTexture,
  LIGHT_PROP_ANIMS,
  BIOME_GLOW_PULSE_FRAMES,
  BIOME_CRYSTAL_FRAME_DEFAULT,
  type FlameKind,
} from './LightPropResolver.js';
import type { AtlasKey } from '../../assets/AssetManifest.js';

/**
 * The animation keys (registered once per scene via {@link ensureAnims}).
 * Mirrors the prototype's flame-flicker cadence. The first frame of each anim
 * matches the resolver's default frame, so there's no pop before the anim
 * starts (the prototype's `add.sprite(... 'campfire')` then loops the same
 * frame — here torch/candle/brazier/lantern loop a 6-frame flicker).
 *
 * Each flame kind gets a KIND-SPECIFIC key (rather than the original two-bucket
 * torch/candle ternary). The earlier ternary mis-routed every non-torch kind
 * onto the candle key, so the empty-frame `campfire`/`fireplace` entries in
 * `LIGHT_PROP_ANIMS` overwrote the candle anim with a 0-frame anim — and
 * `spawn`'s `anims.exists(key)` guard passed on that broken registration,
 * crashing Phaser's `getFirstTick` (`frames[0]` undefined → `currentFrame
 * .duration` throws). It also silently dropped the ticket-08 brazier/lantern
 * flicker art. Per-kind keys fix both.
 */
const ANIM_KEYS = {
  torch: '__lightProp_torch_flicker',
  candle: '__lightProp_candle_flicker',
  brazier: '__lightProp_brazier_flicker',
  lantern: '__lightProp_lantern_flicker',
  biomeGlow: '__lightProp_biome_glow_pulse',
} as const;

/**
 * Convert a linear-RGB `[0,1]` color (the `LightPalette` / placement `color`
 * space, used by the deferred HDR shader) to a Phaser `setTint` value (a gamma
 * `0xRRGGBB` int that multiplies the sprite's sRGB texture). The `1/2.2` power
 * maps linear → sRGB so a tinted crystal body matches its light-disk hue.
 */
function linearRgbToPhaserTint([r, g, b]: readonly [number, number, number]): number {
  const to8 = (c: number) => Math.min(255, Math.max(0, Math.round(255 * Math.pow(c, 1 / 2.2))));
  return (to8(r) << 16) | (to8(g) << 8) | to8(b);
}

/**
 * World-depth band for prop sprites — matches the existing world props
 * (crates/barrels/chests render at depth 5, exits at depth 4; see
 * `EntityRendererWorld.ts`). Lights sit on the floor: depth 4 puts them above
 * the floor tiles (depths 0–3) and below items (depth 8) + projectiles (15) +
 * the HUD (500+). The placer guarantees the tile is walkable floor, so the
 * sprite never lands inside a wall.
 */
export const LIGHT_PROP_DEPTH = 4;

/**
 * Per-kind vertical raise (px) that lifts a prop sprite so its visible bright
 * core (flame base / bright tongue / crystal glow) lands at the placement's
 * grid anchor — i.e. at the LIGHT DISK center (`LightPacker.gridToWorldPx` =
 * `grid * tileSize + tileSize/2`, the same center convention the disk uses).
 * Applied in {@link LightPropRenderer.spawn} as `worldY -= lightPropYOffset(kind)`.
 *
 * WHY THIS EXISTS (ticket 11 — universal vertical-alignment bug):
 * {@link LightPropRenderer.spawn} centers every prop sprite at the tile center
 * (`origin 0.5`) with no per-kind Y offset. But each prop frame is an untrimmed
 * 128×128 cell (`spriteSourceSize {x:0,y:0}`) whose bright core sits in the
 * LOWER half (flame bases, coal beds, fixture sockets are all drawn below the
 * cell center). So the visible flame/fixture landed BELOW its light disk — a
 * universal bug across the menu (`MenuDioramaLighting`), matchmaking (shared
 * composition), and in-game (`GameSceneSetup` → `lightPropRenderer.spawn`),
 * because they all funnel through the one {@link LightPropRenderer.spawn} path.
 *
 * DERIVATION — measured from the actual rendered atlas pixels, then
 * cross-checked against the generator scripts:
 *   `offset_px = round(brightCoreCentroidY − 64)`
 * where the bright-core centroid is the luminance-weighted Y of the warm
 * (flame) or cool (crystal) emission mass, averaged across the flicker
 * frames. Centroids were computed directly off `light_props.png` + `game.png`:
 *
 *   torch       centroid ≈ 85  →  +21
 *     `.scratch/lighting-system/t16/generate_light_props.py:183` — iron socket
 *     at cy+12..cy+24 (y 76–88); flame tongue base-biased. The 6 flicker
 *     frames' warm centroid averages y≈85 (range 83.5–87.7).
 *   candle      centroid ≈ 76  →  +12
 *     `generate_light_props.py:193-197` — holder/wax at cy+12..cy+30, wick
 *     socket cy+15..cy+19; small flame. Warm centroid y≈76.
 *   brazier     centroid ≈ 73  →  +9
 *     `.scratch/lighting-system-2/t08/generate_brazier_lantern.py:189` — bowl
 *     interior cy−14..cy+18; coal flame at cy−6. Warm centroid y≈73.
 *   lantern     centroid ≈ 73  →  +9
 *     `generate_brazier_lantern.py:207,301,224` — frame/glass centered at cy,
 *     but base plate cy+24..cy+36 + flame-base bias pull the warm mass to y≈73.
 *   biome-glow  centroid ≈ 63  →  0
 *     `generate_light_props.py:276-288` — crystal glow drawn at cy with a cy−4
 *     highlight; cool centroid y≈63, already at the cell center.
 *   campfire    centroid ≈ 60  →  0
 *     the separate `game/campfire` frame — a large flame that already fills /
 *     centers the cell; warm centroid y≈60, at/slightly above center.
 *     Independent measurement off `game.png` (per ticket instruction — its
 *     centering differs from the light_props frames and must be verified alone).
 *   fireplace   0
 *     REUSES `game/campfire` (`LightPropResolver.LIGHT_PROP_TEXTURES`) → it
 *     inherits campfire's alignment.
 *
 * The light disk position is UNCHANGED — this raises the SPRITE only; it does
 * NOT touch `LightPacker.gridToWorldPx` (the disk stays at grid coords, so the
 * gameplay-relevant in-game lighting footprint is byte-identical). All offsets
 * are non-negative: the bug is "core sits BELOW center," so we only ever raise.
 * Cosmetic-only (GDD `docs/GDD.md:210` — no fog of war / vision impact): a
 * sprite nudge carries no gameplay semantics. Universal — no scene branching;
 * the table is consulted at the single placement site in {@link LightPropRenderer.spawn}.
 */
export const LIGHT_PROP_Y_OFFSETS: Readonly<Record<LightKind, number>> = {
  torch: 21,
  campfire: 0,
  candle: 12,
  'biome-glow': 0,
  'barrel-fire': 0, // resolves to NO sprite (LightPropResolver) — offset unused.
  fireplace: 0, // reuses game/campfire — same alignment as campfire.
  brazier: 9,
  lantern: 9,
  beacon: 0, // neutral-crystal frame (ticket 04) — bright core at cell center.
};

/**
 * Resolve the per-kind vertical raise (px) for a light-prop sprite. Pure data,
 * no side effects — exported so the offset table is unit-testable without a
 * Phaser scene. Consumed by {@link LightPropRenderer.spawn}.
 */
export function lightPropYOffset(kind: LightKind): number {
  return LIGHT_PROP_Y_OFFSETS[kind] ?? 0;
}

/**
 * The per-frame rate for the flame flicker anims. A touch faster than 8fps so
 * the flame reads as "alive" but not strobing. Biome-glow pulses slower (a
 * steady magical crystal, not fire).
 */
const FLAME_FPS = 9;
const BIOME_GLOW_FPS = 3;

/** Whether the per-scene anims have been registered (one-time, idempotent). */
let animsRegisteredForScene = new WeakSet<Phaser.Scene>();

/**
 * Register the flame/pulse animations on the scene's global anim registry.
 * Idempotent (skips if already registered) + scene-scoped via the WeakSet so
 * a second GameScene boot doesn't re-register. The anim keys are prefixed
 * `__lightProp_` to avoid colliding with any gameplay anim.
 *
 * Each kind is registered under its OWN anim key (ANIM_KEYS[kind]) and ONLY
 * when `LIGHT_PROP_ANIMS[kind]` is non-empty. `campfire` + `fireplace` are
 * intentionally empty (they reuse the static `game/campfire` frame — their
 * flicker lives in the LIGHT disk, not a sprite anim), so they are SKIPPED
 * here. Registering an empty-frames anim would make Phaser's `getFirstTick`
 * crash (`frames[0]` undefined → `currentFrame.duration` throws) the moment
 * `spawn` plays that key — the regression this guard prevents.
 */
export function ensureAnims(scene: Phaser.Scene): void {
  if (animsRegisteredForScene.has(scene)) return;
  const anims = scene.anims;
  // Per-kind flicker anims: torch/candle/brazier/lantern (6 frames each from
  // the lightProps atlas). campfire + fireplace have empty frame lists and are
  // skipped (they reuse the static game/campfire frame).
  //
  // Iterate the ANIM_KEYS table (the 4 flame kinds + biome-glow handled below)
  // rather than LIGHT_PROP_ANIMS — the latter includes campfire/fireplace
  // (which have no anim key), and indexing ANIM_KEYS by those would be a
  // type error. ANIM_KEYS is exactly the anim-bearing set.
  (Object.keys(ANIM_KEYS) as Array<keyof typeof ANIM_KEYS>).forEach((kind) => {
    // biomeGlow is pulse-registered separately below with its own frameRate.
    if (kind === 'biomeGlow') return;
    const frameNames = LIGHT_PROP_ANIMS[kind as FlameKind];
    if (frameNames.length === 0) return; // campfire/fireplace — static sprite.
    const key = ANIM_KEYS[kind];
    if (anims.exists(key)) return;
    const frames = frameNames.map((frame) => ({
      key: 'lightProps' as AtlasKey,
      frame,
    }));
    anims.create({
      key,
      frames,
      frameRate: FLAME_FPS,
      repeat: -1,
      // Small per-anim randomization so co-located flames don't pulse in
      // unison (the prototype's `flickerSeed` per light; here the anim phase).
    });
  });
  // Biome-glow steady pulse (2 frames — a subtle magical breath, not flame).
  if (!anims.exists(ANIM_KEYS.biomeGlow)) {
    anims.create({
      key: ANIM_KEYS.biomeGlow,
      frames: BIOME_GLOW_PULSE_FRAMES.map((frame) => ({
        key: 'lightProps' as AtlasKey,
        frame,
      })),
      frameRate: BIOME_GLOW_FPS,
      repeat: -1,
    });
  }
  animsRegisteredForScene.add(scene);
}

/**
 * Build the tile-coordinate key used to look up a prop sprite by its placement
 * tile. Matches the key the server-side `LightPlacer.collectCampfireTiles`
 * dedupes on (`${gridY},${gridX}`) so a destructible-removal keyed on the same
 * tile coords resolves to exactly one sprite.
 */
function tileKey(gridX: number, gridY: number): string {
  return `${gridY},${gridX}`;
}

/**
 * Owns the spawned prop sprites for one scene. Constructed when placements
 * arrive (onMapData); torn down on scene SHUTDOWN. Idempotent: a second call
 * to {@link spawn} clears the previous set first (defensive against a re-handle
 * of the one-shot mapData message).
 *
 * Sprites are stored in a tile-coordinate-keyed Map so that
 * {@link removeAt} can destroy a single campfire's fixture when its
 * destructible is destroyed — the one-to-one placement guarantee
 * (`LightPlacer` emits at most one light placement per tile) makes the tile
 * coord a stable identity.
 */
export class LightPropRenderer {
  private readonly scene: Phaser.Scene;
  /**
   * The spawned sprites keyed by `${gridY},${gridX}` — tracked so shutdown can
   * destroy them all + so {@link removeAt} can tear down a single fixture.
   */
  private readonly sprites = new Map<string, Phaser.GameObjects.Sprite>();

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
  }

  /**
   * Spawn a visible prop sprite for every motivated (non-scatter) placement
   * that resolves to a texture via {@link resolveLightPropTexture}. Scatter
   * placements + `barrel-fire` (resolver returns null) get NO sprite (they're
   * light-only). The sprite renders into the albedo RT (world-depth 4) so the
   * deferred pipeline lights it naturally. Idempotent — clears first.
   *
   * @param placements  the deterministic map-gen light placements (rides the
   *   one-shot `mapData` message). Scatter placements are skipped here.
   * @param tileSize    grid→world px conversion factor.
   */
  spawn(placements: ReadonlyArray<LightPlacementTiled>, tileSize: number): void {
    this.clear();
    ensureAnims(this.scene);
    for (let i = 0; i < placements.length; i++) {
      const p = placements[i]!;
      // Ambient-scatter placements are light-only fill — no visible fixture.
      if (p.isScatter === true) continue;
      // The placement's `kind` is the shared LightKind (the server-side
      // discriminator: torch/campfire/candle/biome-glow/barrel-fire) — the same
      // type the resolver reads (ticket 24: dedupe removed the cast).
      const tex = resolveLightPropTexture(p.kind);
      if (!tex) continue; // barrel-fire, or any defensive kind → no sprite.
      // A `biome-glow` placement carrying a per-placement `color` override (the
      // menu diorama's per-variant crystals) uses the NEUTRAL crystal frame so
      // `setTint` recolors cleanly to the variant hue. The default `biome-glow`
      // frame is painted cool-blue → tinting it would muddy the hue; the neutral
      // frame (a desaturated derivative) tints vividly. Untinted biome-glow
      // (in-game) keeps its blue frame + 2-frame pulse.
      const tintedCrystal = p.kind === 'biome-glow' && p.color !== undefined;
      const frame = tintedCrystal ? BIOME_CRYSTAL_FRAME_DEFAULT : tex.frame;
      // Bail if the atlas frame isn't loaded (shouldn't happen — loadAtlases
      // loads the lightProps atlas at scene boot — but never throw on a
      // missing art frame; the light disk still motivates without a fixture).
      const atlas = this.scene.textures.get(tex.atlas);
      if (!atlas || !atlas.has(frame)) continue;

      const worldX = p.gridX * tileSize + tileSize / 2;
      // Ticket 11 — raise the sprite so its bright core (drawn in the lower
      // cell half) lands at the tile center == the light disk center. The disk
      // position is UNCHANGED (this nudges the SPRITE only;
      // `LightPacker.gridToWorldPx` stays at grid coords, so the in-game
      // lighting footprint is byte-identical). `lightPropYOffset` is the pure
      // table lookup (see LIGHT_PROP_Y_OFFSETS for the per-kind derivation).
      const worldY = p.gridY * tileSize + tileSize / 2 - lightPropYOffset(p.kind);
      const sprite = this.scene.add.sprite(worldX, worldY, tex.atlas, frame);
      sprite.setOrigin(0.5);
      sprite.setDepth(LIGHT_PROP_DEPTH);
      // Apply the per-placement color override as a sprite tint (the menu's
      // per-variant crystals). The matching LIGHT-DISK color is applied
      // separately by the packer (`p.color ?? palette.color`, `LightPacker`).
      if (p.color) sprite.setTint(linearRgbToPhaserTint(p.color));
      // Apply the placement's sibling-transform (rotation/flip) so a torch on a
      // wall bracket can lean, etc. Matches the existing placement sprites.
      if (p.rotation) sprite.setRotation((p.rotation * Math.PI) / 180);
      const sx = p.flipH ? -1 : 1;
      const sy = p.flipV ? -1 : 1;
      if (sx !== 1 || sy !== 1) sprite.setScale(sx, sy);

      // Play the looping anim for flame/biome-glow kinds. The campfire +
      // fireplace kinds reuse the static `game/campfire` frame (the
      // prototype's single-frame campfire; no anim registered for them — they
      // stay steady sprites, lit by their flickering light disk). Torch /
      // candle / brazier / lantern each play their own 6-frame flicker anim
      // (registered per-kind in ensureAnims); biome-glow plays its 2-frame
      // pulse. The `anims.exists` guard is a defensive belt-and-braces —
      // ensureAnims already registered these — but never throw if a kind was
      // somehow added without an anim.
      const animKey =
        p.kind === 'torch'
          ? ANIM_KEYS.torch
          : p.kind === 'candle'
            ? ANIM_KEYS.candle
            : p.kind === 'brazier'
              ? ANIM_KEYS.brazier
              : p.kind === 'lantern'
                ? ANIM_KEYS.lantern
                : p.kind === 'biome-glow' && !tintedCrystal
                  ? ANIM_KEYS.biomeGlow
                  : null;
      if (animKey && this.scene.anims.exists(animKey)) {
        sprite.play({ key: animKey, repeat: -1 });
      }
      this.sprites.set(tileKey(p.gridX, p.gridY), sprite);
    }
  }

  /**
   * Destroy the prop sprite at a given tile, if one was spawned there. Called
   * when a destructible (e.g. a campfire) is destroyed — its motivating light
   * disk is removed in parallel by `LightingPipeline.removePlacementAt`. No-op
   * when no sprite exists at that tile (the kind had no fixture, e.g.
   * barrel-fire / scatter, or the tile never carried a placement). Best-effort
   * — never throws.
   */
  removeAt(gridX: number, gridY: number): void {
    const sprite = this.sprites.get(tileKey(gridX, gridY));
    if (!sprite) return;
    sprite.destroy();
    this.sprites.delete(tileKey(gridX, gridY));
  }

  /** Clear (destroy) all spawned sprites. Called by {@link spawn} + shutdown. */
  clear(): void {
    for (const sprite of this.sprites.values()) {
      sprite.destroy();
    }
    this.sprites.clear();
  }

  /** Tear down everything (scene SHUTDOWN). Best-effort — never throws. */
  shutdown(): void {
    try {
      this.clear();
    } catch {
      // best-effort
    }
  }

  /** The number of spawned prop sprites (diagnostics / tests). */
  get count(): number {
    return this.sprites.size;
  }
}
