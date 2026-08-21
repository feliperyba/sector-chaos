import type { StateCallbacks } from '../../network/StateSync.js';
import type { StateBridgeDeps } from '../ClientStateBridge.js';

export type ExplosionStateCallbacks = Pick<
  StateCallbacks,
  'onExplosionAdd' | 'onExplosionRemove'
>;

/**
 * Explosions family state-sync handlers (ticket 45 — bodies moved verbatim
 * from the bridge's callbacks literal, including the VFX-particle light
 * registration + its deterministic seed helper). Explosions have no onChange
 * (there is no onExplosionChange in StateCallbacks).
 */
export function createExplosionStateHandlers(deps: StateBridgeDeps): ExplosionStateCallbacks {
  return {
    onExplosionAdd: (e, key) => {
      deps.entityRenderer.addExplosion(key, e);
      // Ticket 08 (A7 VFX-particle lights): the visual explosion VFX (the
      // muzzle/flare/fire/ring/glow/flames/sparks/smoke/scorch sprites the user
      // SEES) is created from the schema-synced Explosion ENTITY — a SEPARATE
      // transport from the BarrelExploded MESSAGE the ExplosionEventHandler
      // registers the deferred light from. Without this, the visual explosion
      // carries NO deferred light (the A7 findings §2.1: the VFX particles are
      // flat additive decals — they brighten their own footprint but do NOT
      // illuminate world geometry). Per the user's ruling ("the explosion you
      // SEE is the explosion that LIGHTS the scene"), register a light from
      // the VFX-creation path too. This fires for EVERY explosion entity
      // (barrel + any future), in parallel with the event-handler path; for a
      // barrel blast both fire (a slightly brighter flash — desirable for the
      // hottest scene element). Cosmetic-only.
      //
      // The seed is derived from the entity position (deterministic per blast)
      // so the pulse phase is stable. The schema Explosion entity carries the
      // authoritative blast radius (e.radius) → the registry scales the light.
      deps.gameState.explosionLights.register(
        e.x,
        e.y,
        e.radius,
        performance.now(),
        explosionVfxLightSeed(e.x, e.y),
      );
    },
    onExplosionRemove: (key) => {
      deps.entityRenderer.removeExplosion(key);
    },
  };
}

/**
 * Deterministic per-explosion-position seed for the VFX-particle light
 * (ticket 08 / A7). The seed phase-offsets the single-pulse curve so concurrent
 * explosions (a barrel chain) don't peak on the exact same frame. Pure — same
 * (x, y) → same seed → same pulse phase. Kept local (no LightingHash import)
 * because the bridge shouldn't pull the lighting internals; the seed only needs
 * to be a stable, well-spread float derived from the position.
 */
function explosionVfxLightSeed(x: number, y: number): number {
  // Cheap integer hash on the floor'd world coords. Mirrors the spirit of
  // `flickerSeedFromHash` (LightingHash) without the import. The result is a
  // positive float in a comfortable range for the pulse's sine jitter.
  let h = (Math.floor(x) * 374761393) ^ (Math.floor(y) * 668265263);
  h = (h ^ (h >>> 13)) >>> 0;
  h = (h * 1274126177) >>> 0;
  return (h % 1_000_000) / 1000;
}
