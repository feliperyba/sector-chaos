/**
 * LightPropAudit — the NO-UNBACKED-LIGHTS audit gate (map-polish ticket 09).
 *
 * The owner's rule is a RULE, not a one-off conversion: "All light
 * sources/props must be destructibles in the map, none should be baked
 * directly, minus the beacons and corridor passages." Tickets 07/08 implement
 * it; this gate LOCKS it in so it can never regress: a future anchor pass
 * that forgets the entity backing fails the build (the gate test), not the
 * mood.
 *
 * Exemption reference: the map-polish research digest
 * `.scratch/map-polish/research/D-destructible-light-props.md` §1 exemption
 * table (encoded as the shared data table `LIGHT_BAKED_EXEMPT_KINDS` /
 * `LIGHT_BAKED_EXEMPT_ANCHORS` — beacons + corridor/doorway sconces ONLY).
 *
 * The gate is a PURE function of the generation output (ADR-0035): the final
 * placement list + the hydrated destructible entity list. Deterministic, no
 * RNG, no runtime state. Three counters, all expected 0 on every seed:
 *
 *  - `unbackedNonExemptLights` — forward: every placement OUTSIDE the baked
 *    exemption set must have EXACTLY ONE backing destructible entity at its
 *    tile: a `'light'` entity for the conversion set (route-mid / fill /
 *    POI-pool / crystal anchors, or any FUTURE non-exempt anchor), a
 *    non-light entity for campfires (their crate backing). Catches the
 *    forgets-the-backing anchor pass, a dropped anchor label, and duplicate
 *    placements claiming one entity.
 *  - `unbackedLightEntities` — reverse: every hydrated `'light'` entity must
 *    sit at the tile of exactly one non-exempt convertible placement.
 *  - `overConvertedExemptLights` — the vice-versa guard on the exemption
 *    side: a `'light'` entity at a baked-exempt (beacon / doorway) tile
 *    means the exemption was violated by over-conversion.
 */
import {
  TILE_PIXEL_SIZE,
  TileType,
  isBakedExemptLightPlacement,
  isLightPropEntityPlacement,
  type LightPlacementTiled,
} from '@sector-battle/shared';

/** A hydrated destructible entity, flattened for the audit (world px). */
export interface LightPropAuditEntity {
  id: string;
  /** The `DestructibleType` string ('crate' | 'barrel' | 'iron' | 'wall' | 'light'). */
  type: string;
  /** World-pixel position (tile center). */
  x: number;
  y: number;
}

/** A non-exempt placement the gate found without proper entity backing. */
export interface UnbackedLightViolation {
  gridX: number;
  gridY: number;
  kind: string;
  anchor?: string;
  reason: 'no-light-entity' | 'no-crate-backing' | 'duplicate-placement';
}

/** A hydrated `'light'` entity with no (unique) backing placement. */
export interface UnbackedEntityViolation {
  id: string;
  gridX: number;
  gridY: number;
}

export interface LightPropAuditResult {
  /** Non-exempt placements without exactly one backing entity (expected []). */
  unbackedNonExemptLights: UnbackedLightViolation[];
  /** `'light'` entities without exactly one backing placement (expected []). */
  unbackedLightEntities: UnbackedEntityViolation[];
  /** `'light'` entities at baked-exempt tiles (expected []). */
  overConvertedExemptLights: UnbackedEntityViolation[];
}

const tileOf = (x: number): number => Math.floor(x / TILE_PIXEL_SIZE);

/**
 * The no-unbacked-lights audit (ticket 09). Pure: cross-checks the FINAL
 * light-placement list against the hydrated destructible entities, tile by
 * tile, in both directions. Deterministic; JSON-safe for the manifest/tests.
 */
export function auditLightPropBacking(
  placements: ReadonlyArray<LightPlacementTiled>,
  entities: ReadonlyArray<LightPropAuditEntity>,
): LightPropAuditResult {
  const entitiesByTile = new Map<string, LightPropAuditEntity[]>();
  for (const e of entities) {
    const key = `${tileOf(e.y)},${tileOf(e.x)}`;
    const bucket = entitiesByTile.get(key);
    if (bucket) bucket.push(e);
    else entitiesByTile.set(key, [e]);
  }
  const placementsByTile = new Map<string, LightPlacementTiled[]>();
  for (const p of placements) {
    const key = `${p.gridY},${p.gridX}`;
    const bucket = placementsByTile.get(key);
    if (bucket) bucket.push(p);
    else placementsByTile.set(key, [p]);
  }

  const unbackedNonExemptLights: UnbackedLightViolation[] = [];
  const overConvertedExemptLights: UnbackedEntityViolation[] = [];

  for (const p of placements) {
    const key = `${p.gridY},${p.gridX}`;
    const atTile = entitiesByTile.get(key) ?? [];
    const lights = atTile.filter((e) => e.type === 'light');
    const nonLights = atTile.filter((e) => e.type !== 'light');

    if (isBakedExemptLightPlacement(p)) {
      // Baked-exempt: NO entity of any kind is required — but a 'light'
      // entity here means the exemption was violated by over-conversion.
      for (const e of lights) {
        overConvertedExemptLights.push({ id: e.id, gridX: p.gridX, gridY: p.gridY });
      }
      continue;
    }

    // Duplicate placements claiming one tile can never be backed "exactly
    // one" — flag each claimant.
    const coPlacements = placementsByTile.get(key)!.filter((q) => !isBakedExemptLightPlacement(q));
    if (coPlacements.length > 1) {
      unbackedNonExemptLights.push({
        gridX: p.gridX,
        gridY: p.gridY,
        kind: p.kind,
        anchor: p.anchor,
        reason: 'duplicate-placement',
      });
      continue;
    }

    if (p.anchor === 'campfire') {
      // Campfire: backed by its pre-existing CRATE entity (never a 'light'
      // entity — ticket 07's landing).
      if (nonLights.length !== 1) {
        unbackedNonExemptLights.push({
          gridX: p.gridX,
          gridY: p.gridY,
          kind: p.kind,
          anchor: p.anchor,
          reason: 'no-crate-backing',
        });
      }
      continue;
    }

    // The conversion set (and any future non-exempt anchor): exactly one
    // 'light' entity at the tile. `isLightPropEntityPlacement` is what the
    // hydration keys on, so an anchor the hydration forgot shows up here as
    // a missing entity.
    if (lights.length !== 1) {
      unbackedNonExemptLights.push({
        gridX: p.gridX,
        gridY: p.gridY,
        kind: p.kind,
        anchor: p.anchor,
        reason: 'no-light-entity',
      });
    }
  }

  // Reverse: every 'light' entity needs exactly one backing non-exempt
  // convertible placement at its tile.
  const unbackedLightEntities: UnbackedEntityViolation[] = [];
  for (const e of entities) {
    if (e.type !== 'light') continue;
    const key = `${tileOf(e.y)},${tileOf(e.x)}`;
    const claims = (placementsByTile.get(key) ?? []).filter(
      (p) => !isBakedExemptLightPlacement(p) && p.anchor !== 'campfire',
    );
    if (claims.length !== 1) {
      unbackedLightEntities.push({ id: e.id, gridX: tileOf(e.x), gridY: tileOf(e.y) });
    }
  }

  return { unbackedNonExemptLights, unbackedLightEntities, overConvertedExemptLights };
}

/**
 * Derive the destructible backing the hydration WILL produce from a
 * placement list + the map grid — the `MapEntityFactory` rules: positional
 * id `dest_light_<row>_<col>` + tile-center position +
 * `isLightPropEntityPlacement` discriminator for the conversion set, and a
 * crate at every campfire whose grid tile is `DESTRUCTIBLE_CRATE` (campfires
 * are backed by their crate tiles, never by a `'light'` entity; the audit
 * matches by TILE, so the derived crate's synthetic id is irrelevant).
 *
 * The report builder uses this when no hydrated entity list is at hand. The
 * derivation is deterministic, so the audit stays meaningful: a non-exempt
 * placement the rules do not back (an anchor nobody added to
 * `LIGHT_PROP_ENTITY_ANCHORS`, a duplicate tile claim) still shows up as
 * unbacked. Only the crate-backing check of campfires needs the grid — pass
 * the real one.
 */
export function deriveExpectedLightBacking(
  placements: ReadonlyArray<LightPlacementTiled>,
  grid: ReadonlyArray<ReadonlyArray<TileType>>,
): LightPropAuditEntity[] {
  const entities: LightPropAuditEntity[] = [];
  for (const p of placements) {
    const x = p.gridX * TILE_PIXEL_SIZE + TILE_PIXEL_SIZE / 2;
    const y = p.gridY * TILE_PIXEL_SIZE + TILE_PIXEL_SIZE / 2;
    if (isLightPropEntityPlacement(p)) {
      entities.push({ id: `dest_light_${p.gridY}_${p.gridX}`, type: 'light', x, y });
    } else if (
      p.anchor === 'campfire' &&
      grid[p.gridY]?.[p.gridX] === TileType.DESTRUCTIBLE_CRATE
    ) {
      entities.push({ id: `dest_crate_${p.gridY}_${p.gridX}`, type: 'crate', x, y });
    }
  }
  return entities;
}
