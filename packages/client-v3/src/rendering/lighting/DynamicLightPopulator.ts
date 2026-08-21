/**
 * DynamicLightPopulator — per-frame dynamic-light registration (ticket 11 + 18).
 *
 * Each frame, this module walks the LIVE match state (players + projectiles +
 * chests + fire traps) + the explosion-light registry + the impact-light
 * registry, resolves each entity to its `DynamicLight`, and registers the kept
 * set on the lighting pipeline. The pipeline's `dynamic` array is cleared +
 * repopulated here (via `beginDynamicLights` / `addDynamicLight`) before
 * `update()` packs + renders.
 *
 * The pipeline's own `update()` then runs the LightBudget pass over
 * (static placements + this dynamic list) + camera, trims to ≤80 on-screen,
 * and packs. So this module's job is purely "describe every live light" —
 * the budget manager handles the cull. Over-registering is safe (the budget
 * caps it); under-registering loses a light.
 *
 * Cosmetic-only (GDD forbids fog of war): the aura is identity/glow, NOT a
 * vision radius; projectile lights are trailing glow; the chest glint is a
 * lootability readability hint (the chest is still visible/lootable without
 * it); the fire-trap light is mood for an active fire. No gameplay gate, no
 * network traffic (lights are derived from the same client-side entity state
 * the renderers already consume).
 *
 * Per-category tuning (spec §"Light data + tuning values", hero overrides):
 *  - Player aura (ticket 07): LOCAL = REMOTE (identical) — ticket 22's local-
 *    vs-remote branch (×1.2 intensity + 35% warm blend) is REMOVED per user
 *    ruling (values recorded as the A/B baseline at the AURA_HERO constant).
 *    Dead/spectating skipped.
 *  - Projectile (ticket 20): per-AttackType color/falloff/cookie + a 2-light
 *    fade trail. SHIELD emits no traveling light. No flicker.
 *  - Chest glint (ticket 18): small steady warm-gold light on UNOPENED chests
 *    (the "hero lights at loot" wayfinding hint); open/looted chests skipped.
 *  - Fire-trap light (ticket 18): fire-palette flicker-ON light while
 *    `fireAreaActive` is true; nothing when inactive.
 * Static barrels do NOT emit (ticket 18 — barrels are inert until they
 * explode); the barrel EXPLOSION flash is handled by ExplosionLightRegistry.
 * Combat-impact flashes (ticket 09 / A3 — arrow impact, shield block, melee
 * hit, weapon break) are handled by ImpactLightRegistry, collected here the
 * same way as the explosion lights (registry returns reused distinct refs,
 * pushed straight through at EXPLOSION priority).
 *
 * Allocation shape (ticket 01 / B4 perf — pooled, steady-state zero-alloc):
 * the populator mutates one scratch light per entity in place, then
 * `cloneLight`s it into a POOLED `DynamicLight` (two alternating per-pipeline
 * pools, flipped each frame — see `cloneLight` + the scratch interface). The
 * alternation keeps the previous frame's `lastKeptDynamic` refs valid until
 * they're consumed; each pool is grow-only → zero per-frame alloc at steady
 * state. The registry's explosion lights are already distinct objects (skip
 * clone).
 *
 * Honest history: pre-ticket-01 this allocated ~64+ `DynamicLight` +
 * `color[3]` per frame at 64-player peak (a load-bearing GC-pressure source
 * per the B4 investigation). Ticket 24's docstring-honesty pass FLAGGED this
 * but did NOT fix the allocation (it only instance-ified the scratch). Ticket
 * 01 closes it via the alternating pool.
 */
import { GRID, PlayerStatus, TRAP } from '@sector-battle/shared';
import { cookieKeyToIndex } from './LightPacker.js';
import { HERO_LIGHT_OVERRIDES, resolveLightKind } from './LightPalette.js';
import { computeFlickerMul, computeFlickerMulForKind } from './TorchFlicker.js';
import { LIGHT_PRIORITY } from './LightBudget.js';
import type { ExplosionLightRegistry } from './ExplosionLightRegistry.js';
import type { ImpactLightRegistry } from './ImpactLightRegistry.js';
import type { LightingPipeline } from './LightingPipeline.js';
import type { GameState } from '../../controllers/GameState.js';
import type { StateSync } from '../../network/StateSync.js';
import type { EntityInterpolator } from '../../prediction/EntityInterpolator.js';
import type { PredictionService } from '../../prediction/PredictionService.js';
import {
  computeAuraBreathingMul,
  flickerSeedFromPosition,
} from './DynamicLightPopulatorFlicker.js';
import { scratchForPipeline, cloneLight } from './DynamicLightPopulatorPool.js';

// Re-export the flicker/phase helpers (C7) so existing imports from
// './DynamicLightPopulator.js' keep working (LightingPipelineTypes.ts
// re-export precedent).
export {
  AURA_BREATHING_AMP,
  AURA_BREATHING_HZ,
  computeAuraBreathingMul,
  hashPlayerIdPhase,
} from './DynamicLightPopulatorFlicker.js';

/** Player aura hero override (ticket 07): radius 256, intensity 1.2, no flicker. */
const AURA_HERO = HERO_LIGHT_OVERRIDES.aura!;
const AURA_PALETTE = resolveLightKind('aura');
const AURA_COOKIE_INDEX = cookieKeyToIndex(AURA_PALETTE.cookieKey); // light_02 → 2

// ── Ticket 22 local-vs-remote aura branch — REMOVED (ticket 07) ──
// A/B BASELINE (do NOT silently reverse prior ACCEPTED work — REVIEW item B1):
//   Ticket 22 (commit on the prior batch) gave LOCAL a readability nudge:
//     - AURA_LOCAL_INTENSITY_MUL = 1.2  (local ~1.2× remote: 1.9 → ~2.28)
//     - AURA_LOCAL_COLOR = cool aura blended 35% toward warm amber [0.62,0.55,0.42]
//         = [0.479, 0.6395, 0.879]  (R up, G/B down → warmer R/B ratio)
//   Remote kept the verbatim cool baseline {1.9, [0.40,0.68,1.0]}.
//   User ruling (this ticket): local = remote (identical). Both get the same
//   warm aura. The branch above is removed; both paths now resolve to the
//   single AURA_HERO/AURA_PALETTE values below. The ticket-22 values are
//   recorded here as the A/B baseline so the reversal is documented, not
//   silent (same discipline as ticket 23's tone values).

/**
 * Fire palette (fire-trap light + the explosion-kind source) — hottest red,
 * light_01 cookie, flicker ON. Module-local copy; `ExplosionLightRegistry`
 * has its own identical copy for the explosion path.
 */
const FIRE_PALETTE = resolveLightKind('fire');
const FIRE_COOKIE_INDEX = cookieKeyToIndex(FIRE_PALETTE.cookieKey); // light_01 → 1

/**
 * Projectile-light tuning lives in `ProjectileLightTuning.ts` (ticket 20) — a
 * per-AttackType table (RANGED/LINE/THROWN/ARC) + a defensive AttackType
 * resolver (weaponType → AttackType, mirroring the renderer's pattern) + the
 * trail ring buffer. Pre-ticket-20 this collapsed to two buckets (arrow
 * `bounces<0` vs thrown) with one warm-yellow color + one cookie, so a thrown
 * axe glowed identically to a barrel-fire. The new table gives each element a
 * distinct color/falloff/cookie (AAA per-element principle, research §4) and a
 * short fade trail so projectiles read as fast streaks, not static disks.
 * SHIELD emits no traveling light (melee pulse; server spawns no projectile).
 */
import { resolveAttackTypeForProjectile, getProjectileLight } from './ProjectileLightTuning.js';

/**
 * Chest-glint tuning (ticket 18, retuned ticket 07). A small, steady, warm-gold
 * light that makes an unopened chest readable as lootable from across a sector
 * — the Level Design Book "hero lights at loot" wayfinding principle. Steady
 * (no flicker) because a treasure glint is not a flame. Radius/intensity are
 * tuned by eye: small enough to read as a glint (not a campfire), warm enough
 * (gold) to contrast with the cool aura + dark ambient. The gold tint is
 * inline (no LightKind entry — the glint is its own one-off mood light, not a
 * map-gen/light-palette kind).
 *
 * Ticket 07 (A2 findings): radius HELD tactical (105px = ~0.8 tile — the chest
 * stays a subtle accent, NOT a primary light source; readable as lootable from
 * across a sector without flooding). The diffuseness changes apply (lower
 * corePower, higher haloFrac — see the inline values at the emit site) so the
 * glint reads as a soft twinkle, not a hard dot. A/B baseline: was radius 105,
 * intensity 1.2, corePower 4.0, haloFrac 0.55 (verbatim). Radius + intensity
 * UNCHANGED; corePower/haloFrac softened.
 */
const CHEST_GLINT_RADIUS = 105; // ~0.8 tile — readable but not a flood (HELD tactical, ticket 07).
const CHEST_GLINT_INTENSITY = 1.2; // steady warm gold — between candle + torch (UNCHANGED).
const CHEST_GLINT_COLOR: readonly [number, number, number] = [1.0, 0.85, 0.45]; // warm gold.
const CHEST_GLINT_COOKIE_INDEX = cookieKeyToIndex('light_02'); // soft radial.
// Ticket 07 diffuseness — softer core + more halo so the glint twinkles softly.
const CHEST_GLINT_CORE_POWER = 3.2; // was 4.0 (inline) — softer warm core (a glint, not a flood).
const CHEST_GLINT_HALO_FRAC = 0.75; // was 0.55 (inline) — soft surrounding glow.

/**
 * Chest `state` wire values (server `StateMapper.chestToSchema`:
 * `{ closed: 0, opening: 1, open: 2 }`). A chest is "looted" once open (2);
 * it keeps its glint while closed (0) or opening (1) — i.e. while it still
 * holds loot the player wants.
 */
const CHEST_STATE_OPEN = 2;

/**
 * Fire-trap light sizing. A fire trap's `fireAreaActive` flag gates a
 * `(2 * FIRE_AREA_RADIUS + 1)`-tile fire patch (`EntityRendererTraps.
 * drawFireArea`: `TRAP.FIRE_AREA_RADIUS = 1` → a 3×3 area). The geometric
 * radius spanning the patch is `(2 * FIRE_AREA_RADIUS + 1) / 2` tiles. The
 * light radius derives dynamically from the constant — if `FIRE_AREA_RADIUS`
 * changes, the light radius recomputes automatically.
 *
 * The ×1.6 spill multiplier pushes the nominal radius well past the patch
 * corners (corners of a 3×3 are at `sqrt(2) × TILE_SIZE ≈ 181px` from center;
 * at 1.6× the 192px patch radius → 307px, the corners sit at 59% of the
 * nominal radius — well inside the full-intensity band, so the whole 3×3
 * reads as lit, not just the center cross). Prior: 1.2× (230px) left the
 * corners dim through the `fire` palette's steep corePower-3.8 falloff.
 */
const FIRE_TRAP_PATCH_RADIUS = (2 * TRAP.FIRE_AREA_RADIUS + 1) * 0.5 * GRID.TILE_SIZE; // 192 px (for R=1).
const FIRE_TRAP_LIGHT_RADIUS = Math.round(FIRE_TRAP_PATCH_RADIUS * 1.6); // 307 px (full 3×3 coverage).
/**
 * Fire-trap light intensity. A `(2R+1)`-tile fire patch is a substantial fire
 * source — matched to the campfire (2.6), since a 3×3 floor fire is at least
 * as much flame as a campfire. Prior: 2.0 (torch-ish) read as a dim dot
 * relative to the patch size.
 */
const FIRE_TRAP_LIGHT_INTENSITY = 3.0;

/**
 * Deps bag — the live match state the populator reads. All fields are the
 * same singletons GameScene already owns (no new state, no network traffic).
 */
export interface DynamicLightPopulatorDeps {
  state: GameState;
  stateSync: StateSync;
  /** Player interpolator (remote-player interpolated positions). */
  interpolator: EntityInterpolator;
  /** Projectile interpolator (matches the projectile renderer's positions). */
  projectileInterpolator: EntityInterpolator;
  /** Local-player prediction visual position source. */
  predictionService: PredictionService;
  /** Explosion-light registry (the brief flash lifecycle). */
  explosionLights: ExplosionLightRegistry;
  /**
   * Impact-light registry (ticket 09 / A3). Combat event handlers
   * (DamageEventHandler for PlayerDamaged/ShieldBlocked/WeaponBroken;
   * AttackEventHandler for ProjectileDestroyed) register brief flash lights
   * here; the populator collects the live lights each frame, mirroring the
   * explosion-light pattern. Optional so existing tests/constructors that don't
   * care about impact lighting keep working (matches the explosion-light
   * registry's optional-on-construction discipline).
   */
  impactLights?: ImpactLightRegistry;
}

/**
 * Populate the pipeline's dynamic-light list for this frame. Clears the list
 * first (via `beginDynamicLights`), then adds one light per live player +
 * per active projectile + per unopened chest + per active fire trap + every
 * live explosion light.
 *
 * Call AFTER interpolation has run (so interpolated positions are fresh) and
 * BEFORE `pipeline.update()` (so the dynamic list is packed this frame). The
 * pipeline's own budget pass trims to the on-screen target.
 *
 * @param pipeline     the lighting pipeline (cleared + populated in place).
 * @param deps         live match state.
 * @param nowMs        wall-clock ms (shared frame timestamp; drives the
 *                     explosion-light fade via the registry's `collect`).
 * @param flickerMul   per-frame global flicker multiplier for flame lights
 *                     (explosions + active fire traps). The caller computes
 *                     this via `computeFlickerMul` so it controls the flicker
 *                     cadence + can gate it by tier (tier-1 A/B → 1.0). Player
 *                     auras + projectiles + chest glints do NOT flicker (spec).
 */
export function populateDynamicLights(
  pipeline: LightingPipeline,
  deps: DynamicLightPopulatorDeps,
  nowMs: number,
  flickerMul: number,
): void {
  pipeline.beginDynamicLights();

  const {
    state,
    stateSync,
    interpolator,
    projectileInterpolator,
    predictionService,
    explosionLights,
    impactLights,
  } = deps;
  const entities = stateSync.getEntities();

  // Per-pipeline scratch (ticket 24 — was module-singletons; now WeakMap-keyed
  // so each pipeline gets its own, GC'd on pipeline death).
  const scratch = scratchForPipeline(pipeline);
  const {
    scratchLight: SCRATCH_LIGHT,
    interpOut: INTERP_OUT,
    projectileTrails: PROJECTILE_TRAILS,
    liveProjectileIds: LIVE_PROJECTILE_IDS,
  } = scratch;

  // Ticket 01 (B4 perf) — flip the alternating clone pool + reset this frame's
  // hand-out counter. The previous frame's (now inactive) pool holds the
  // `lastKeptDynamic` refs read at the START of this frame's `pipeline.update`;
  // leaving it untouched keeps them valid.
  scratch.clonePoolFlip = !scratch.clonePoolFlip;
  scratch.clonePoolCount = 0;

  // ── Player auras (local + remote; skip dead/spectating) ──
  // Ticket 07: LOCAL = REMOTE (identical) — ticket 22's local-vs-remote branch
  // (×1.2 intensity + 35% warm blend) is REMOVED per user ruling. Both get the
  // same warm aura: AURA_HERO radius/intensity + AURA_PALETTE color/falloff.
  // The verbatim aura color is cool blue [0.40,0.68,1.0] — kept as the identity
  // hue (the "warm aura" in the ticket refers to the global mood being warm-
  // lit by many sources, not that every aura is itself amber).
  for (const [id, player] of entities.players) {
    // Skip dead/dying/spectating players — no aura on a corpse.
    if (
      (player.status & (PlayerStatus.DEAD | PlayerStatus.DYING | PlayerStatus.SPECTATING)) !==
      0
    ) {
      continue;
    }
    const isLocal = id === state.myId;
    let x: number;
    let y: number;
    if (isLocal) {
      // Local player: prediction visual position (matches the sprite).
      const visual = predictionService.getVisualPosition();
      x = visual.x;
      y = visual.y;
    } else {
      // Remote player: interpolated position (matches the sprite).
      if (!interpolator.getInterpolatedPosition(id, INTERP_OUT, nowMs)) continue;
      x = INTERP_OUT.x;
      y = INTERP_OUT.y;
    }
    SCRATCH_LIGHT.x = x;
    SCRATCH_LIGHT.y = y;
    // IDENTICAL for local + remote (ticket 07): radius 256, intensity 1.2,
    // corePower 2.5, haloFrac 0.85, cool color, light_02 cookie, no flicker.
    SCRATCH_LIGHT.radius = AURA_HERO.radius; // 256 (2.0 tiles, ticket 07)
    SCRATCH_LIGHT.intensity = AURA_HERO.intensity; // 1.2 (both)
    // In-place color write (B4 H5) — avoids allocating a fresh [r,g,b] tuple
    // per emit that would immediately become garbage when cloneLight copies it.
    const auraColor = SCRATCH_LIGHT.color;
    auraColor[0] = AURA_PALETTE.color[0]!;
    auraColor[1] = AURA_PALETTE.color[1]!;
    auraColor[2] = AURA_PALETTE.color[2]!;
    SCRATCH_LIGHT.corePower = AURA_PALETTE.corePower; // 2.5 (ticket 07)
    SCRATCH_LIGHT.haloFrac = AURA_PALETTE.haloFrac; // 0.85 (ticket 07)
    SCRATCH_LIGHT.specPower = AURA_PALETTE.specPower;
    SCRATCH_LIGHT.cookieOn = AURA_COOKIE_INDEX;
    // D2 — forward the palette's blend mode ('max' for auras) so the packer
    // folds `+10` into `uLightParams[i].w` (alongside the cookie index) and the
    // HdrLit loop max-blends clustered same-color auras instead of summing them
    // to white. (The blend mode is PACKED into `.w` — no separate `uLightBlend`
    // array — to avoid overflowing `MAX_FRAGMENT_UNIFORM_VECTORS`.)
    SCRATCH_LIGHT.blend = AURA_PALETTE.blend;
    // C7 (lighting-system-3): the aura now BREATHES — a slow ±6% intensity
    // pulse at ~0.6Hz (≈1.7s period), de-synchronized per player via a hash
    // phase offset so 64 auras don't pulse in unison. Replaces the hardcoded
    // `1.0` ("steady identity glow (aura never flickers)"). SLOW breathing,
    // distinct from torch flicker — preserves the "steady identity" character
    // while adding life. Deterministic: same nowMs + same playerId → same
    // value. No `Math.random()`. Cosmetic-only (GDD `docs/GDD.md:210`).
    SCRATCH_LIGHT.flickerMul = computeAuraBreathingMul(nowMs / 1000, id);
    pipeline.addDynamicLight(cloneLight(scratch, SCRATCH_LIGHT), LIGHT_PRIORITY.PLAYER);
  }

  // ── Projectile lights (ticket 20 — per-AttackType character + streak trail) ──
  // Each projectile resolves its AttackType from weaponType + looks up a
  // distinct color/falloff/cookie (AAA per-element principle, research §4).
  // SHIELD emits no traveling light. A 2-light fade trail (×0.5/×0.25) makes
  // each read as a fast streak. Cosmetic-only (GDD `docs/GDD.md:210`).
  LIVE_PROJECTILE_IDS.clear();
  for (const [, p] of entities.projectiles) {
    LIVE_PROJECTILE_IDS.add(p.id);
    if (!projectileInterpolator.getInterpolatedPosition(p.id, INTERP_OUT, nowMs)) {
      // Fall back to the wire position if interpolation has no snapshot yet
      // (the first frame after spawn — better to glow at the spawn point than
      // to drop the light entirely).
      INTERP_OUT.x = p.x;
      INTERP_OUT.y = p.y;
    }
    // Resolve AttackType client-side from weaponType (the renderer's pattern,
    // `EntityRendererProjectiles.ts:49-53`; defensive try/catch → fallback).
    // SHIELD → null tuning → skip the light entirely (melee pulse, not a disk).
    const attackType = resolveAttackTypeForProjectile(p.weaponType);
    const tuning = getProjectileLight(attackType);
    if (tuning === null) continue; // SHIELD: no traveling light.
    const headX = INTERP_OUT.x;
    const headY = INTERP_OUT.y;

    // Record this frame's head position BEFORE emitting the head, so the trail
    // lags one frame behind (the streak reads as motion). The buffer keeps the
    // last 2 positions per id; older ones roll off.
    PROJECTILE_TRAILS.record(p.id, headX, headY);

    // ── Head light (steady glow; full intensity) ──
    SCRATCH_LIGHT.x = headX;
    SCRATCH_LIGHT.y = headY;
    SCRATCH_LIGHT.radius = tuning.radius;
    SCRATCH_LIGHT.intensity = tuning.intensity;
    // In-place color write (B4 H5).
    const projColor = SCRATCH_LIGHT.color;
    projColor[0] = tuning.color[0]!;
    projColor[1] = tuning.color[1]!;
    projColor[2] = tuning.color[2]!;
    SCRATCH_LIGHT.corePower = tuning.corePower;
    SCRATCH_LIGHT.haloFrac = tuning.haloFrac;
    SCRATCH_LIGHT.specPower = tuning.specPower;
    SCRATCH_LIGHT.cookieOn = tuning.cookieOn;
    SCRATCH_LIGHT.flickerMul = 1.0; // projectiles do NOT flicker (steady glow)
    pipeline.addDynamicLight(cloneLight(scratch, SCRATCH_LIGHT), LIGHT_PRIORITY.PROJECTILE);

    // ── Streak trail (2 fade-trailing lights at past positions) ──
    // Each trailing light reuses the head's color/falloff/cookie but dims the
    // intensity (×0.5 most-recent past, ×0.25 older past) so the streak fades
    // quickly behind the head. Tagged PROJECTILE priority → trims before
    // props/scatter when the scene is busy (budget-safe; head + 2 trail = 3
    // lights per projectile, dominated by the prop/aura priority bands).
    const trail = PROJECTILE_TRAILS.collect(p.id);
    for (let i = 0; i < trail.length; i++) {
      const t = trail[i]!;
      SCRATCH_LIGHT.x = t.x;
      SCRATCH_LIGHT.y = t.y;
      // Same radius/falloff/cookie as the head (a streak, not shrinking dots);
      // only intensity dims so the trail reads as the head's tail, not a
      // separate color.
      SCRATCH_LIGHT.intensity = tuning.intensity * t.dim;
      pipeline.addDynamicLight(cloneLight(scratch, SCRATCH_LIGHT), LIGHT_PRIORITY.PROJECTILE);
    }
  }
  // Drop trail state for projectiles no longer live (prevents the buffer from
  // leaking dead ids — a despawned projectile's last positions are forgotten).
  PROJECTILE_TRAILS.pruneDead(LIVE_PROJECTILE_IDS);

  // ── Chest-glint lights (ticket 18 — motivated-loot wayfinding hint) ──
  // One small, steady, warm-gold light per UNOPENED chest. Opened/looted
  // chests (state === CHEST_STATE_OPEN) are skipped — the natural unregister
  // (same pattern the old barrel loop used). Cosmetic: a readability hint, not
  // a vision gate (GDD `docs/GDD.md:210` — the chest stays visible without it).
  // Tagged STATIC priority: chests are static world loot, same tier as torches
  // (the ticket allows a new LOOT tier, but STATIC is simpler + the budget trim
  // already favors STATIC over BARREL/AMBIENT_SCATTER, so loot is kept when the
  // scene is busy).
  for (const [, c] of entities.chests) {
    if (c.state === CHEST_STATE_OPEN) continue; // looted → no glint.
    SCRATCH_LIGHT.x = c.x;
    SCRATCH_LIGHT.y = c.y;
    SCRATCH_LIGHT.radius = CHEST_GLINT_RADIUS;
    SCRATCH_LIGHT.intensity = CHEST_GLINT_INTENSITY;
    // In-place color write (B4 H5).
    const chestColor = SCRATCH_LIGHT.color;
    chestColor[0] = CHEST_GLINT_COLOR[0]!;
    chestColor[1] = CHEST_GLINT_COLOR[1]!;
    chestColor[2] = CHEST_GLINT_COLOR[2]!;
    SCRATCH_LIGHT.corePower = CHEST_GLINT_CORE_POWER; // 3.2 (ticket 07) — was 4.0.
    SCRATCH_LIGHT.haloFrac = CHEST_GLINT_HALO_FRAC; // 0.75 (ticket 07) — was 0.55.
    SCRATCH_LIGHT.specPower = 30.0; // gentle spec (treasure reads soft).
    SCRATCH_LIGHT.cookieOn = CHEST_GLINT_COOKIE_INDEX;
    SCRATCH_LIGHT.flickerMul = 1.0; // steady — a treasure glint is not a flame.
    pipeline.addDynamicLight(cloneLight(scratch, SCRATCH_LIGHT), LIGHT_PRIORITY.STATIC);
  }

  // ── Fire-trap lights (ticket 18 — fire is a light source per the user ruling) ──
  // While `fireAreaActive` is true, emit a fire-palette light (hot red, flicker
  // ON) sized to the trap's 3×3-tile fire patch. When inactive, emit nothing
  // (gated cleanly on the existing flag the trap renderer already uses).
  for (const [, t] of entities.traps) {
    if (!t.fireAreaActive) continue; // inactive fire trap → no light.
    SCRATCH_LIGHT.x = t.x;
    SCRATCH_LIGHT.y = t.y;
    SCRATCH_LIGHT.radius = FIRE_TRAP_LIGHT_RADIUS;
    SCRATCH_LIGHT.intensity = FIRE_TRAP_LIGHT_INTENSITY;
    // In-place color write (B4 H5).
    const fireColor = SCRATCH_LIGHT.color;
    fireColor[0] = FIRE_PALETTE.color[0]!;
    fireColor[1] = FIRE_PALETTE.color[1]!;
    fireColor[2] = FIRE_PALETTE.color[2]!;
    SCRATCH_LIGHT.corePower = FIRE_PALETTE.corePower;
    SCRATCH_LIGHT.haloFrac = FIRE_PALETTE.haloFrac;
    SCRATCH_LIGHT.specPower = FIRE_PALETTE.specPower;
    SCRATCH_LIGHT.cookieOn = FIRE_COOKIE_INDEX;
    // Per-trap flicker phase: deterministic seed from the trap's stable world
    // position so adjacent active traps don't strobe in unison (richer visual,
    // still deterministic — same position → same phase). Ticket 08 (A4): uses
    // the dedicated `fire-trap` flicker profile (medium amp, active — a
    // contained floor-patch fire) instead of the generic torch profile.
    SCRATCH_LIGHT.flickerMul = computeFlickerMulForKind('fire-trap', {
      t: nowMs / 1000,
      seed: flickerSeedFromPosition(t.x, t.y),
    });
    pipeline.addDynamicLight(cloneLight(scratch, SCRATCH_LIGHT), LIGHT_PRIORITY.STATIC);
  }

  // ── Explosion lights (brief hot flash; fades via the registry) ──
  // The registry returns reused distinct refs — push them straight through.
  const explosionCollected = explosionLights.collect(nowMs, flickerMul);
  for (let i = 0; i < explosionCollected.length; i++) {
    pipeline.addDynamicLight(explosionCollected[i]!, LIGHT_PRIORITY.EXPLOSION);
  }

  // ── Impact lights (ticket 09 / A3 — combat-impact flashes) ──
  // Same pattern as the explosion lights: the registry returns reused distinct
  // refs, pushed straight through. Tagged EXPLOSION priority (combat feedback —
  // brief transient action the player is looking at, same tier as explosions;
  // kept over distant static props when the scene is busy). NO-OP when the
  // registry is absent (older test fixtures) or empty (no recent combat events).
  // Cosmetic-only (GDD `docs/GDD.md:210` — mood accents, never a vision gate).
  if (impactLights) {
    const impactCollected = impactLights.collect(nowMs, flickerMul);
    for (let i = 0; i < impactCollected.length; i++) {
      pipeline.addDynamicLight(impactCollected[i]!, LIGHT_PRIORITY.EXPLOSION);
    }
  }
}
