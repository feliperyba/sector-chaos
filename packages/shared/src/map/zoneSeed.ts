import { avalanche } from './lootTiers.js';
import type { MapData } from './types.js';

/**
 * Zone determinism + landmark-biased endgame (map-redesign ticket 09 /
 * DEC-008 — GDD §5.4: "Zone center randomization uses the same seed for
 * reproducibility in testing").
 *
 * The zone service used to be seeded with `Date.now()`, so the same map seed
 * produced a different zone path every match. This module restores the GDD
 * contract: the zone seed is a pure function of the map seed, and the final
 * phase's landmark-bias anchors (hero-POI + compound positions) are derived
 * from the same shared `MapData` the client renders landmarks from.
 *
 * Determinism (ADR 0035): the zone stream is an isolated XOR-salted,
 * avalanche-mixed stream derived from the map seed —
 * `avalanche(seed ^ ZONE_SEED_XOR)` — the same convention as lootTiers'
 * 'TIER'/'HOTS', poiNames' 'NAME'/'DESG' and landmarks' 'LNDM' salts. Wall
 * clock never influences zone GEOMETRY (phase TIMING may still read clocks
 * per the existing architecture). Same map seed ⇒ identical zone center
 * sequence, twice in the same process or across processes.
 */

/**
 * Isolated RNG stream seed XOR constant for the zone center randomization
 * ('ZSEC' in ASCII hex — same convention as lootTiers' 'TIER'/'HOTS' salts).
 * The zone draws ONLY from this stream so it can never perturb — or be
 * perturbed by — the tile/entity/identity generation streams.
 */
export const ZONE_SEED_XOR = 0x5a534543;

/**
 * Derive the zone RNG seed from the FINAL map seed. Pure function: same map
 * seed ⇒ same zone seed. The avalanche (murmur3 finalizer, shared with the
 * other identity streams) spreads the seed across all 32 bits so consecutive
 * map seeds decorrelate their zone paths (see `avalanche` in lootTiers.ts for
 * the measured low-bit-correlation problem this prevents).
 */
export function deriveZoneSeed(mapSeed: number): number {
  return avalanche((mapSeed >>> 0) ^ ZONE_SEED_XOR);
}

/**
 * World-space bias anchors for the final-phase zone center selection
 * (DEC-008.2): every sector's hero-landmark anchor tile (the signature
 * gameplay structure the landmark sits ON) plus the central compound's
 * center (the map's scheduled constant landmark). The final-phase center is
 * drawn TOWARD these — weighted, never forced — so the finale lands on
 * structured ground instead of dead field.
 *
 * Returns an empty array when the map carries no landmark assignment (demo
 * TMX maps) — an empty anchor set disables the bias and the zone falls back
 * to the plain per-phase random walk.
 */
export function collectZoneBiasAnchors(
  mapData: Pick<MapData, 'landmarks' | 'fortress'>,
  tileWidth: number,
): Array<{ x: number; y: number }> {
  const anchors: Array<{ x: number; y: number }> = [];
  for (const row of mapData.landmarks.heroes) {
    for (const hero of row) {
      anchors.push({
        x: hero.tileX * tileWidth + tileWidth / 2,
        y: hero.tileY * tileWidth + tileWidth / 2,
      });
    }
  }
  if (mapData.fortress) {
    anchors.push({
      x: (mapData.fortress.originCol + mapData.fortress.size / 2) * tileWidth,
      y: (mapData.fortress.originRow + mapData.fortress.size / 2) * tileWidth,
    });
  }
  return anchors;
}
