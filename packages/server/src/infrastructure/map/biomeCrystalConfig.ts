import { SectorType } from '@sector-battle/shared';

/**
 * Biome-crystal configuration for the dedicated crystal anchor (Anchor C) in
 * {@link LightPlacer}. Server-local, matching the `biomeConfig.ts` precedent
 * (biome flavour config lives with the placer that consumes it — the client
 * never needs these constants because it reads the resolved `color` /
 * `radius` / `intensity` / `pulse` straight off each `LightPlacementTiled`).
 *
 * **Context — what "promote the crystals" means here.** `biome-glow` is NOT
 * new to gameplay: the pre-existing wall-bracket anchor already emitted it in
 * 3 of 4 sector types. But it shipped as a bare `{ gridX, gridY, kind }` with
 * NO cosmetic fields, so the client rendered it as the flat cool-blue static
 * `biome-glow_01` glow at the `DEFAULT_HERO_LIGHT` (256 / 1.9). This module is
 * the gameplay parity for the menu diorama's richer crystal treatment: a
 * per-biome `color` hue (which the client swaps for the tinted `biome-crystal_01`
 * sprite), a moody `intensity` / `radius`, and a slow `pulse`. The client
 * lighting pipeline already honours all four fields on `biome-glow` with no new
 * rendering code — the work is entirely server-side (emit the fields from a
 * dedicated motivated anchor).
 *
 * **Mood direction (locked with the user):** full visual parity but MOODY —
 * radius kept, intensity pulled back from the menu's 3.0 to a luminous-but-
 * not-bright ~2.1 (just above the old 1.9 default so the tile reads as a live
 * accent against the fire-lit scene, not a dead tile and not a neon beacon),
 * distinct MUTED hue per biome (max channel ~0.40 so none read neon), shallow
 * pulse. Count matches the prior biome-glow frequency but the placements are
 * RELOCATED to motivated nooks / clearings so each crystal "means something."
 */

// ─── Per-biome crystal hue ───────────────────────────────────────────────────

/**
 * Distinct MUTED crystal hue per sector type (linear-RGB, max channel ≈0.45 so
 * the crystal reads as a moody bioluminescent glow, not a neon beacon). Each
 * hue is themed to its room AND spaced evenly across the cool spectrum
 * (emerald → teal → azure → violet) so the four biomes read as four clearly
 * DIFFERENT colours at a glance — never two near-duplicate greens (the prior
 * emerald/moss-teal pair both read green, which the user called "variety
 * lacking"). All four stay on the cool side to contrast with the warm fire
 * family `[1.0, 0.55, 0.22]`, so a crystal never reads as "another fire":
 *  - OPEN_ARENA    — grass / forest clearing   → emerald (bioluminescent moss)
 *  - MAZE          — overgrown ruined labyrinth → teal    (damp cyan-green overgrowth; deliberately shifted OFF emerald so the two nature biomes differ in hue, not just brightness)
 *  - GRID_ARENA    — industrial crate-yard      → azure   (cold arcane tech; pushed toward pure blue so it stops reading as the same hue as MAZE teal)
 *  - RESOURCE_RICH — polished vault / treasure  → violet  (spectral treasure; pushed toward magenta for max separation from the blue family)
 *
 * The client swaps to the tintable `biome-crystal_01` sprite when a `biome-glow`
 * placement carries a `color` (LightPropRenderer.spawn), so emitting `color`
 * here is what upgrades the sprite from the painted-blue `biome-glow_01` glow
 * to the themed crystal.
 */
export const BIOME_CRYSTAL_HUE: Readonly<Record<SectorType, readonly [number, number, number]>> = {
  [SectorType.OPEN_ARENA]: [0.16, 0.44, 0.2], // emerald — forest clearing moss
  [SectorType.MAZE]: [0.16, 0.4, 0.44], // teal — damp overgrown ruins (cyan-green, deliberately separated from emerald)
  [SectorType.GRID_ARENA]: [0.18, 0.28, 0.48], // azure — cold arcane industrial (pure blue, distinct from MAZE teal)
  [SectorType.RESOURCE_RICH]: [0.3, 0.14, 0.44], // violet — spectral vault (pushed magenta for max separation)
};

// ─── Moody gameplay crystal tune ─────────────────────────────────────────────

/**
 * Gameplay crystal light tune. MOODY parity with the menu diorama crystals
 * (which run radius 300 / intensity 3.0 / pulse). Radius is pushed to 384
 * (a 3-tile reach — larger than the menu's 300 AND than campfire's 320) so each
 * rare regional crystal casts a real POOL of bioluminescence across its
 * clearing/nook, not the tight 2-tile disk of the prior 256 (which read as a
 * faint pinpoint the user called "too small"). It stays moody — not a beacon —
 * because the `biome-glow` palette's high haloFrac (0.88, the diffuse-wash
 * family) spreads that radius into a soft rim, and intensity 2.1 only MATCHES
 * campfire brightness rather than exceeding it. The shallow pulse (a 0.9 + 0.1
 * breath folded in by LightPacker) gives the "alive" read without strobing.
 *
 * These OVERRIDE the shared `HERO_LIGHT_OVERRIDES` / `DEFAULT_HERO_LIGHT` per
 * placement via the cosmetic `LightPlacementTiled` `.radius` / `.intensity` /
 * `.pulse` fields — gameplay fire config is untouched.
 */
export const BIOME_CRYSTAL_LIGHT = {
  radius: 384,
  intensity: 2.1,
  pulse: true,
} as const;

// ─── Anchor C — motivated crystal placement geometry ─────────────────────────

/**
 * Isolated RNG salt for the crystal anchor. Distinct from
 * {@link LightPlacer}'s `LIGHT_PLACEMENT_SALT` AND every `biomeConfig` accent
 * salt, so adding / tuning crystals never perturbs the wall-bracket stream or
 * any accent stream (the determinism contract: identical seed → identical
 * output, and an isolated stream means changing crystal density shifts ONLY
 * crystal output). XOR'd with the map seed at fork time, exactly like the
 * `LIGHT_PLACEMENT_SALT` / `AccentConfig.salt` pattern.
 */
export const CRYSTAL_PLACEMENT_SALT = 0x6c1f73a5;

/**
 * Minimum wall-neighbour count (8-neighbourhood) for a NOOK crystal in an
 * ENCLOSED biome (GRID_ARENA / MAZE / RESOURCE_RICH). ≥4 walls around an EMPTY
 * floor tile = a DEEP concave pocket (nearly enclosed — a genuine shadow locale
 * for a bioluminescent crystal growth), NOT a mere corridor bend (≥3 walls,
 * which is far too permissive: every MAZE corner would grow a crystal, reading
 * as clutter rather than a rare motivated accent). Stricter motivation = the
 * correctness lever that keeps crystals rare + meaningful.
 */
export const CRYSTAL_NOOK_MIN_WALL_NEIGHBOURS = 4;

/**
 * Wall-distance (in tiles) for a FOREST-CLEARING crystal in OPEN_ARENA. The
 * forest biome is open (few wall-nooks), so its crystals use a complementary
 * motivated signal: an EMPTY tile with NO wall within its 7×7 neighbourhood
 * (≥3 tiles from any wall) = a DEEP forest-clearing bioluminescence (not a
 * shallow 5×5 gap, which almost any open tile qualifies for). Stricter depth =
 * fewer, more deliberate clearing crystals.
 */
export const CRYSTAL_FOREST_CLEARING_WALL_DISTANCE = 3;

/**
 * Minimum Manhattan spacing (in tiles, GLOBAL) between a crystal and ANY other
 * light on the whole map. Modest (4) because the per-sector SIGNATURE model
 * (one crystal per region) already bounds the count — the spacing only needs to
 * keep adjacent sectors' signature crystals from clumping at their shared
 * border and to keep each crystal clear of nearby fire lights. Global (not
 * per-sector) so the wall-nook fill respects crystals across borders too.
 */
export const CRYSTAL_MIN_SPACING = 4;
