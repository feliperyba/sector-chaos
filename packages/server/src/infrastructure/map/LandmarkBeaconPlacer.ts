import type { LightPlacementTiled, LandmarkAssignment, FortressInfo } from '@sector-battle/shared';

/**
 * Beacon light placements for the landmark system (map-redesign ticket 04 /
 * DEC-002 + DEC-005).
 *
 * Every hero landmark carries one beacon — theme-colored, tier-valued
 * (map-polish ticket 03: hue = the sector TYPE's identity color from
 * `BEACON_THEME_LIGHT`, value = the loot-tier intensity band), slow pulse,
 * radius ≥ 512, the brightest static light in its sector — and each minor
 * landmark carries a small steady marker light (authored neutral-cool: a
 * junction node belongs to four districts, so no single theme). The beacon
 * SPEC is authored by the shared
 * generation (`MapData.landmarks`, an isolated XOR-salted stream) and this
 * placer only converts it to `LightPlacementTiled` entries appended to the
 * map's light placements: they ride the existing one-shot `mapData` payload
 * through the existing light pipeline + budget (≤ on-screen target), with the
 * per-placement `color`/`radius`/`intensity`/`pulse` overrides the packer
 * and prop renderer already honor. Zero RNG — a pure projection of the
 * landmark assignment (deterministic per seed).
 */

/**
 * Project the landmark assignment onto light placements.
 *
 * @param landmarks the shared-generation landmark assignment (MapData.landmarks)
 * @returns beacon placements (16 hero + 2–3 minor), appended after the
 *   sconce/crystal placements by the adapter
 */
export function buildBeaconLightPlacements(landmarks: LandmarkAssignment): LightPlacementTiled[] {
  const placements: LightPlacementTiled[] = [];
  for (const row of landmarks.heroes) {
    for (const hero of row) {
      placements.push({
        gridX: hero.tileX,
        gridY: hero.tileY,
        kind: 'beacon',
        color: hero.beacon.color,
        radius: hero.beacon.radius,
        intensity: hero.beacon.intensity,
        pulse: true,
        rotation: 0,
        flipH: false,
        flipV: false,
      });
    }
  }
  for (const minor of landmarks.minors) {
    placements.push({
      gridX: minor.tileX,
      gridY: minor.tileY,
      kind: 'beacon',
      color: minor.light.color,
      radius: minor.light.radius,
      intensity: minor.light.intensity,
      // Minor markers are steady — the pulse reads as "destination", which a
      // junction node is not.
      pulse: false,
      rotation: 0,
      flipH: false,
      flipV: false,
    });
  }
  return placements;
}

/**
 * The fortress (compound / Citadel) beacon placement (map-redesign ticket 06 /
 * DEC-004.2): every compound template carries one beacon at its authored
 * anchor — theme-colored for the standard variants (the beacon anchor
 * sector's TYPE hue, tier-valued intensity — the same hue=theme, value=tier
 * contract as the hero beacons), and for the rare Citadel
 * the VAULT beacon: the strongest static light on the map (intensity at the
 * `BEACON_INTENSITY_MAX` ceiling, radius beyond every hero beacon, violet
 * rare-event color — the one sanctioned tier-hue exception), still inside
 * the DEC-005 static value band. A pure
 * projection of `MapData.fortress` — zero RNG.
 */
export function buildFortressBeaconPlacements(fortress: FortressInfo): LightPlacementTiled[] {
  return [
    {
      gridX: fortress.beacon.tileX,
      gridY: fortress.beacon.tileY,
      kind: 'beacon',
      color: fortress.beacon.color,
      radius: fortress.beacon.radius,
      intensity: fortress.beacon.intensity,
      pulse: true,
      rotation: 0,
      flipH: false,
      flipV: false,
    },
  ];
}
