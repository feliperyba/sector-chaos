/**
 * BarrelFuseLightPopulator — the escalating primed-barrel warm light
 * (juice-pass-1 ticket 06).
 *
 * The "subtle warm light at prime … brightening toward detonation" half of
 * ticket 01 Resolution §3 (the ember/flame half lives in
 * `rendering/vfx/BarrelFuseVFX.ts`; both derive their escalation from the
 * SAME pure function, `computeFuseElapsedFraction`, keyed off remaining fuse
 * = synced absolute expiry tick − `StateSync.getTick()` — the synced
 * live-tick source the HUD power-up countdowns already use. No client-side
 * fuse timer, no guessing).
 *
 * Built on the DynamicLightPopulator precedent, in a NEW file (the populator
 * itself sits at the 500-line gate): per-frame, server-state-derived
 * registration of one warm flickering light per PRIMED barrel. When the
 * server detonates the barrel the destructible drops out of the live map and
 * the light simply stops being registered next frame — teardown is the schema
 * removal itself, never a client-side guess.
 *
 * POOL DISCIPLINE (B4 perf — see `DynamicLightPopulatorPool`): this shares
 * the populator's per-pipeline scratch + alternating clone pools. It must run
 * AFTER `populateDynamicLights` in the same frame (guaranteed by its only
 * call site, `driveSceneLighting`) and must NOT flip the clone pool or reset
 * the hand-out counter — it simply continues handing out entries from the
 * pool `populateDynamicLights` activated this frame, keeping the previous
 * frame's `lastKeptDynamic` refs valid.
 *
 * Cosmetic-only (GDD forbids fog of war): the warm glow is a danger cue, not
 * a vision radius. Over-registering is safe — the pipeline's LightBudget pass
 * trims to the on-screen target; these tag `LIGHT_PRIORITY.BARREL` (the
 * lowest dynamic band, reserved by name for barrel lights) so a busy scene
 * sheds barrel glow before combat/player light; the in-world fire particles
 * carry the fuse readability regardless.
 */
import { resolveLightKind } from './LightPalette.js';
import { cookieKeyToIndex } from './LightPacker.js';
import { LIGHT_PRIORITY } from './LightBudget.js';
import { computeFlickerMulForKind } from './TorchFlicker.js';
import { flickerSeedFromPosition } from './DynamicLightPopulatorFlicker.js';
import { scratchForPipeline, cloneLight } from './DynamicLightPopulatorPool.js';
import { computeFuseElapsedFraction } from '../vfx/BarrelFuseVFX.js';
import type { StateSync } from '../../network/StateSync.js';
import type { LightingPipeline } from './LightingPipeline.js';
import { DESTRUCTIBLE_TYPE_BARREL } from '../../types.js';

/* ── Owner retune list — warm-light escalation (all in one place) ───────── */

/**
 * Light radius ramp (px): a candle-ish warm disk at prime growing to a
 * torch-scale glow at detonation. The barrel sits on a 128px tile; max 230px
 * stays under the fire-trap's 307px patch light (a barrel fuse is a smaller,
 * contained fire than a 3×3 floor burn).
 */
const FUSE_LIGHT_RADIUS_MIN = 95;
const FUSE_LIGHT_RADIUS_MAX = 230;
/**
 * Light intensity ramp: barely-there at prime (below the chest glint's 1.2),
 * torch-hot at detonation (between the fire trap's 3.0 and a glint).
 */
const FUSE_LIGHT_INTENSITY_MIN = 0.4;
const FUSE_LIGHT_INTENSITY_MAX = 2.2;
/**
 * Final-seconds surge: the glow swells through the last stretch of the fuse
 * ("bright = leave now"). Breakpoint as a fuse-elapsed fraction + gain.
 */
const FUSE_LIGHT_SURGE_T = 0.9;
const FUSE_LIGHT_SURGE_GAIN = 0.3;
/** Dim ember-orange at prime → bright warm amber at detonation (linear RGB). */
const FUSE_LIGHT_COLOR_EARLY: readonly [number, number, number] = [0.85, 0.42, 0.18];
const FUSE_LIGHT_COLOR_LATE: readonly [number, number, number] = [1.0, 0.72, 0.35];

/** The fire palette's cookie/falloff shape (warm light_01, same as fire traps). */
const FIRE_PALETTE = resolveLightKind('fire');
const FIRE_COOKIE_INDEX = cookieKeyToIndex(FIRE_PALETTE.cookieKey);

/**
 * Register one warm escalating light per primed barrel on the pipeline's
 * dynamic-light list. Call AFTER `populateDynamicLights` (same frame, same
 * pipeline — see the pool-discipline note in the header) and BEFORE
 * `pipeline.update()`.
 *
 * @param pipeline  the lighting pipeline (dynamic list appended in place).
 * @param stateSync live match state (the server-authoritative destructibles
 *                  map + the synced server tick).
 * @param nowMs     wall-clock ms (shared frame timestamp; drives the flame
 *                  flicker, deterministically per barrel position).
 */
export function populateBarrelFuseLights(
  pipeline: LightingPipeline,
  stateSync: StateSync,
  nowMs: number,
): void {
  const serverTick = stateSync.getTick();
  // No synced tick yet (pre-first-patch): register nothing — never guess a fuse.
  if (serverTick <= 0) return;

  // Shared per-pipeline scratch (continues this frame's clone pool — the
  // flip + count reset stay owned by `populateDynamicLights`).
  const scratch = scratchForPipeline(pipeline);
  const light = scratch.scratchLight;

  for (const [, d] of stateSync.getDestructibles()) {
    if (d.type !== DESTRUCTIBLE_TYPE_BARREL || d.primed !== true || d.isDestroyed) continue;
    const t = computeFuseElapsedFraction(serverTick, d.fuseExpiresAtTick ?? 0);
    const surge = 1 + FUSE_LIGHT_SURGE_GAIN * surgeRamp(t);
    light.x = d.x;
    light.y = d.y;
    light.radius = FUSE_LIGHT_RADIUS_MIN + (FUSE_LIGHT_RADIUS_MAX - FUSE_LIGHT_RADIUS_MIN) * t;
    light.intensity =
      (FUSE_LIGHT_INTENSITY_MIN + (FUSE_LIGHT_INTENSITY_MAX - FUSE_LIGHT_INTENSITY_MIN) * t) *
      surge;
    // In-place color write (B4 H5 — no transient [r,g,b] tuple per emit).
    const color = light.color;
    color[0] = FUSE_LIGHT_COLOR_EARLY[0] + (FUSE_LIGHT_COLOR_LATE[0] - FUSE_LIGHT_COLOR_EARLY[0]) * t;
    color[1] = FUSE_LIGHT_COLOR_EARLY[1] + (FUSE_LIGHT_COLOR_LATE[1] - FUSE_LIGHT_COLOR_EARLY[1]) * t;
    color[2] = FUSE_LIGHT_COLOR_EARLY[2] + (FUSE_LIGHT_COLOR_LATE[2] - FUSE_LIGHT_COLOR_EARLY[2]) * t;
    light.corePower = FIRE_PALETTE.corePower;
    light.haloFrac = FIRE_PALETTE.haloFrac;
    light.specPower = FIRE_PALETTE.specPower;
    light.cookieOn = FIRE_COOKIE_INDEX;
    light.blend = FIRE_PALETTE.blend;
    // A primed fuse is a contained fire — the fire-trap flicker profile
    // (medium amp, active), deterministically de-synced per barrel position
    // so a chain of primed barrels doesn't strobe in unison.
    light.flickerMul = computeFlickerMulForKind('fire-trap', {
      t: nowMs / 1000,
      seed: flickerSeedFromPosition(d.x, d.y),
    });
    pipeline.addDynamicLight(cloneLight(scratch, light), LIGHT_PRIORITY.BARREL);
  }
}

/**
 * Smoothstep into the final-stretch surge (clamped 0..1 past the breakpoint).
 *
 * @param t fuse-elapsed fraction.
 * @returns the surge ramp in [0,1].
 */
function surgeRamp(t: number): number {
  const x = Math.min(1, Math.max(0, (t - FUSE_LIGHT_SURGE_T) / (1 - FUSE_LIGHT_SURGE_T)));
  return x * x * (3 - 2 * x);
}
