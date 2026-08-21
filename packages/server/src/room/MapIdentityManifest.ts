import {
  deriveZoneSeed,
  type SectorLootTier,
  type SectorType,
  type MacroPoiNames,
  type LandmarkAssignment,
  type FortressInfo,
  type VisualIdentityAssignment,
  type GenerationAudit,
} from '@sector-battle/shared';
import type { LightingReport } from '../infrastructure/map/LightingReportBuilder.js';
import type { MapResult } from '../domain/services/MapGenerator.ts';

/**
 * The room's complete map-identity bundle (Named Districts program, ADR-0038):
 * every identity stream the shared generation authors, carried from the
 * `buildGameMapResult` output to the one-shot `mapData` wire payload (the
 * client-facing subset — see `GameRoom.buildMapDataPayload`) and the benchmark
 * generation manifest (the generation-only audit fields) as ONE frozen value
 * object instead of ~14 parallel room fields. Same references, same wire
 * payloads — only the storage shape is grouped.
 *
 * All fields are undefined on demo-TMX maps (no shared generation); consumers
 * already treat that as "skip the surface".
 */
export interface MapIdentityManifest {
  /**
   * Seed-authored loot-tier pyramid + per-match hot sector (map-redesign
   * ticket 02). Rides the one-shot `mapData` message to the client (minimap
   * tier tint + hot mark) and the benchmark generation manifest.
   */
  sectorTiers: SectorLootTier[][] | undefined;
  hotSector: { row: number; col: number } | undefined;
  /**
   * POI names + map designation (map-redesign ticket 03 / DEC-001 + DEC-010).
   * Rides the `mapData` message (minimap labels, enter-banner, kill-feed
   * location tags, match-start/results designation) and the benchmark
   * generation manifest.
   */
  poiNames: string[][] | undefined;
  macroPoiNames: MacroPoiNames | undefined;
  designation: string | undefined;
  /**
   * Hero landmarks + beacons + junction minor landmarks (map-redesign ticket
   * 04 / DEC-002). Rides the `mapData` message (baked composites, minimap
   * icons) and the benchmark generation manifest; the beacon LIGHTS
   * themselves ride the lightPlacements appended by the SeedMapAdapter.
   */
  landmarks: LandmarkAssignment | undefined;
  /**
   * The placed fortress projection (map-redesign ticket 06 / DEC-004):
   * compound/Citadel variant, footprint, vault anchor + beacon spec. Rides
   * the `mapData` message and the benchmark generation manifest (the
   * fortress variant field); the beacon light rides the lightPlacements
   * appended by the SeedMapAdapter.
   */
  fortress: FortressInfo | null | undefined;
  /**
   * Visual identity (map-redesign ticket 07 / DEC-006): sector type grid +
   * the identity assignment (floor tint fields + gateway dressing). Rides
   * the `mapData` message — the client resolves each district's identity
   * sheet and bakes the visuals at map load.
   */
  sectorTypes: SectorType[][] | undefined;
  identity: VisualIdentityAssignment | undefined;
  /**
   * Skeleton variety (map-redesign ticket 08 / DEC-007): per-sector skeleton
   * (sub-variant) ids + horizontal-mirror flags, read by the benchmark
   * generation manifest (the skeleton/mirror audit surface). Generation
   * metadata only — never sent to clients.
   */
  sectorSkeletons: string[][] | undefined;
  sectorMirrored: boolean[][] | undefined;
  /**
   * Generation-time fairness audit (map-redesign ticket 10 / DEC-009): how
   * many spawns the equity repair pass re-picked, how many attempts the map
   * took, and the post-repair equity audit. Read by the benchmark
   * generation manifest; not sent to clients.
   */
  generationAudit: GenerationAudit | undefined;
  /**
   * Zone RNG seed derived from the FINAL map seed on the isolated 'ZSEC'
   * salt (map-redesign ticket 09 / DEC-008.1) — the seed
   * `createGameOrchestrator` initializes the zone service with. Read by the
   * benchmark generation manifest's zone audit fields; not sent to clients.
   */
  zoneSeed: number | undefined;
  /**
   * Lighting-hierarchy discipline report (map-redesign ticket 05 / DEC-005):
   * totals, ≤3-hue-family lint + enforcement record, value-band gate,
   * dark-pocket summary, and the on-screen static count sample. Read by the
   * benchmark generation manifest (violations are LOGGED there); not sent
   * to clients (the placements themselves are).
   */
  lightingReport: LightingReport | undefined;
}

/**
 * Build the manifest once per room from the shared generation output. The
 * zone seed derivation is verbatim the pre-manifest room logic (present
 * landmarks ⇒ derive from the FINAL map seed; demo-TMX maps stay undefined).
 * The report is built by `handleOnCreate` AFTER orchestrator hydration (its
 * no-unbacked-lights audit needs the live entity list) and attached here —
 * the single construction site keeps all 14 fields born together, frozen.
 */
export function buildMapIdentityManifest(
  mapResult: MapResult,
  lightingReport: LightingReport | undefined,
): MapIdentityManifest {
  return Object.freeze({
    sectorTiers: mapResult.sectorTiers,
    hotSector: mapResult.hotSector,
    poiNames: mapResult.poiNames,
    macroPoiNames: mapResult.macroPoiNames,
    designation: mapResult.designation,
    landmarks: mapResult.landmarks,
    fortress: mapResult.fortress,
    sectorTypes: mapResult.sectorTypes,
    identity: mapResult.identity,
    sectorSkeletons: mapResult.sectorSkeletons,
    sectorMirrored: mapResult.sectorMirrored,
    generationAudit: mapResult.generationAudit,
    zoneSeed: mapResult.landmarks ? deriveZoneSeed(mapResult.seed) : undefined,
    lightingReport,
  });
}
