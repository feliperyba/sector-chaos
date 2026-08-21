/**
 * Hand-authored test-light injection for the lighting pipeline (ticket 07).
 *
 * Extracted from `LightingPipeline.ts` to respect the 450-line file-length lint
 * cap. This module owns the multi-kind test-light fixture: a torch, a campfire
 * (hero override), a cool player aura (hero override, no flicker), and a candle
 * — exercising every palette + cookie index + flicker combination so the AAA
 * stack (two-term + specular + cookies + flicker) is visible together in the
 * viewport.
 *
 * The lights cluster around a base world position (typically the local player)
 * set by the pipeline each frame via `setTestLightBase`. Warm lights
 * (torch/campfire/candle/fire) flicker; the cool player aura does NOT
 * (prototype gate `L.isTorch`, prototype.js:718). The flicker multiplier folds
 * into the packed intensity (`uLights[i].w = intensity * mul`).
 *
 * This is the ticket-07 hand-authored fixture; ticket 10 will replace it with
 * map-gen placements (resolved through the same `resolveLightKind` +
 * `HERO_LIGHT_OVERRIDES` + `cookieKeyToIndex` chain exercised here).
 */
import type { DynamicLight } from './LightPacker.js';
import { cookieKeyToIndex } from './LightPacker.js';
import { TIERS, ACTIVE_TIER } from './LightingTiers.js';
import { computeFlickerMul } from './TorchFlicker.js';
import { HERO_LIGHT_OVERRIDES, resolveLightKind } from './LightPalette.js';

/**
 * Deterministic per-test-light flicker seeds. Fixed so every client computes
 * the same flicker for the same light index — the seed stream will later come
 * from the map RNG (ticket 10); for the hand-authored test lights a fixed
 * prime-spaced table keeps the flames desynchronised + deterministic.
 */
const TEST_FLICKER_SEEDS = [1.7, 42.1, 99.3, 7.7] as const;

/**
 * Build the test-light `DynamicLight[]` for this frame and append it to `out`.
 *
 * @param baseX/baseY  the world px the lights cluster around (local player).
 * @param timeSeconds  wall-clock seconds (drives the orbit + flicker).
 * @param out          the pipeline's dynamic-light list (appended in place).
 */
export function injectTestLights(
  baseX: number,
  baseY: number,
  timeSeconds: number,
  out: DynamicLight[],
): void {
  const tier = TIERS[ACTIVE_TIER] ?? TIERS[1]!;
  const flickerOn = tier.flicker;
  // Slow orbit offsets so the lights are world-locked + visibly moving under
  // pan/zoom (preserves the ticket-06 world-locked-under-pan proof).
  const orbit = (idx: number, r: number, speed: number): readonly [number, number] => {
    const ang = timeSeconds * speed + idx * 1.7;
    return [baseX + Math.cos(ang) * r, baseY + Math.sin(ang) * r];
  };

  const torchPalette = resolveLightKind('torch');
  const auraPalette = resolveLightKind('aura');
  const candlePalette = resolveLightKind('candle');
  const campfireHero = HERO_LIGHT_OVERRIDES.campfire!;
  const auraHero = HERO_LIGHT_OVERRIDES.aura!;

  // Flicker multipliers — deterministic per light. Warm lights (torch,
  // campfire, candle) flicker; the cool aura does not (prototype gate).
  const torchMul = flickerOn
    ? computeFlickerMul({ t: timeSeconds, seed: TEST_FLICKER_SEEDS[0]! })
    : 1.0;
  const campfireMul = flickerOn
    ? computeFlickerMul({ t: timeSeconds, seed: TEST_FLICKER_SEEDS[1]! })
    : 1.0;
  const candleMul = flickerOn
    ? computeFlickerMul({ t: timeSeconds, seed: TEST_FLICKER_SEEDS[2]! })
    : 1.0;

  // ── Torch (warm, flicker ON, light_01 cookie) — orbits the base. ──
  const [torchX, torchY] = orbit(0, 170, 0.6);
  out.push({
    x: torchX,
    y: torchY,
    radius: 230,
    intensity: 2.8 * torchMul,
    color: [torchPalette.color[0], torchPalette.color[1], torchPalette.color[2]],
    corePower: torchPalette.corePower,
    haloFrac: torchPalette.haloFrac,
    specPower: torchPalette.specPower,
    cookieOn: cookieKeyToIndex(torchPalette.cookieKey),
    flickerMul: 1.0, // already folded into intensity above
  });

  // ── Campfire (hero override: torch palette, r=260, i=3.2, flicker ON). ──
  // Anchored offset from the base (no orbit — a fixed world prop).
  out.push({
    x: baseX + 120,
    y: baseY + 110,
    radius: campfireHero.radius,
    intensity: campfireHero.intensity * campfireMul,
    color: [torchPalette.color[0], torchPalette.color[1], torchPalette.color[2]],
    corePower: torchPalette.corePower,
    haloFrac: torchPalette.haloFrac,
    specPower: torchPalette.specPower,
    cookieOn: cookieKeyToIndex(torchPalette.cookieKey),
    flickerMul: 1.0,
  });

  // ── Player aura (hero override: aura palette, r=160, i=1.9, flicker OFF). ──
  // Sits on the base (follows the local player exactly).
  out.push({
    x: baseX,
    y: baseY,
    radius: auraHero.radius,
    intensity: auraHero.intensity,
    color: [auraPalette.color[0], auraPalette.color[1], auraPalette.color[2]],
    corePower: auraPalette.corePower,
    haloFrac: auraPalette.haloFrac,
    specPower: auraPalette.specPower,
    cookieOn: cookieKeyToIndex(auraPalette.cookieKey),
    flickerMul: 1.0,
  });

  // ── Candle (warm, flicker ON, light_01 cookie) — smaller, offset orbit. ──
  const [candleX, candleY] = orbit(2, 130, -0.45);
  out.push({
    x: candleX,
    y: candleY,
    radius: 150,
    intensity: 1.8 * candleMul,
    color: [candlePalette.color[0], candlePalette.color[1], candlePalette.color[2]],
    corePower: candlePalette.corePower,
    haloFrac: candlePalette.haloFrac,
    specPower: candlePalette.specPower,
    cookieOn: cookieKeyToIndex(candlePalette.cookieKey),
    flickerMul: 1.0,
  });
}
