/**
 * Map-polish ticket 09 — the NO-UNBACKED-LIGHTS audit gate.
 *
 * The owner's rule ("All light sources/props must be destructibles in the
 * map, none should be baked directly, minus the beacons and corridor
 * passages") becomes an invariant: on every standard seed, the pure gate
 * `auditLightPropBacking` cross-checks the FINAL placement list against the
 * PRODUCTION-hydrated destructible entity list (buildGameMapResult →
 * createGameOrchestrator, the same path the room runs) in both directions.
 *
 *  - GATE (all seeds): zero `unbackedNonExemptLights`, zero
 *    `unbackedLightEntities`, zero `overConvertedExemptLights` — every
 *    non-exempt placement has exactly one backing entity (a `'light'` entity
 *    for the conversion set, a crate for campfires), every `'light'` entity
 *    has exactly one backing placement, and no exempt tile holds a `'light'`
 *    entity.
 *  - TEETH (injected failures): a deliberately-injected unbacked non-exempt
 *    placement fails the gate — plus the reverse (orphan entity), the
 *    over-conversion (entity at a beacon tile), the duplicate-tile claim, the
 *    future-anchor the hydration rule does not convert, and the campfire
 *    whose crate backing went missing. A future anchor pass that forgets the
 *    entity backing fails THIS suite, not the mood.
 *  - MANIFEST: `buildLightingReport` carries the audit as
 *    `unbackedNonExemptLights` (0 across the seed sweep; > 0 on injection)
 *    and its derived-entity mode matches the production hydration exactly.
 *  - DETERMINISM (extends the golden surface): repeated same-seed generation
 *    ⇒ byte-identical placements + byte-identical hydrated entity list +
 *    identical audit result (ADR-0035 — pure function of generation output,
 *    no RNG).
 *
 * The exemption reference is the map-polish research digest
 * `D-destructible-light-props.md` §1 exemption table (encoded as the shared
 * `LIGHT_BAKED_EXEMPT_KINDS`/`LIGHT_BAKED_EXEMPT_ANCHORS` data table).
 */
import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import {
  MapGenerator as SharedMapGenerator,
  TILE_PIXEL_SIZE,
  TileType,
  isBakedExemptLightPlacement,
  type LightAnchor,
  type LightPlacementTiled,
} from '@sector-battle/shared';
import {
  auditLightPropBacking,
  deriveExpectedLightBacking,
  type LightPropAuditEntity,
} from '../LightPropAudit.js';
import { buildLightingReport } from '../LightingReportBuilder.js';
import { SeedMapAdapter } from '../SeedMapAdapter.js';
import { buildGameMapResult } from '../../../room/GameRoomMapBuilder.js';
import { DEFAULT_CONFIG } from '../../../room/GameRoomConfig.js';
import { createGameOrchestrator } from '../../../application/services/GameOrchestratorInit.js';

const TILED_DIR = resolve(__dirname, '../../../../../../tiled');

const STANDARD_SEEDS: Array<{ seed: number; label: string }> = [
  { seed: 1, label: '1' },
  { seed: 42, label: '42' },
  { seed: 999, label: '999' },
  { seed: 0xdeadbeef, label: '0xdeadbeef' },
];

/** The generation-side fixture pair: final placements + the grid. */
function adaptedFixture(seed: number): {
  placements: LightPlacementTiled[];
  grid: TileType[][];
} {
  const mapData = new SharedMapGenerator().generate(seed);
  const enriched = new SeedMapAdapter().adapt(mapData, seed, TILED_DIR);
  return { placements: enriched.entities.lightPlacements, grid: enriched.grid };
}

function adaptedPlacements(seed: number): LightPlacementTiled[] {
  return adaptedFixture(seed).placements;
}

/**
 * The production hydration output for a seed: the full destructible entity
 * list (ALL types — the campfire crate backing must be auditable), flattened
 * to the audit's entity shape. Snapshotted before stop() (the sim recycles
 * entity scratch on teardown).
 */
function hydratedEntities(seed: number): LightPropAuditEntity[] {
  const config = structuredClone(DEFAULT_CONFIG);
  const { mapResult, enrichedData } = buildGameMapResult(
    { mapType: 'procedural' },
    seed,
    config.map,
  );
  const orchestrator = createGameOrchestrator(
    `ticket09-gate-${seed}`,
    config,
    mapResult,
    enrichedData,
  );
  const entities: LightPropAuditEntity[] = [];
  for (const d of orchestrator.getMatch().getState().destructibles.values()) {
    entities.push({ id: d.id, type: d.type, x: d.position.x, y: d.position.y });
  }
  orchestrator.stop();
  return entities;
}

describe('No-unbacked-lights audit gate (map-polish ticket 09)', () => {
  /** A fixture tile far from any real placement. */
  const INJECTED = { gridX: 7, gridY: 77 };
  const center = (grid: number): number => grid * TILE_PIXEL_SIZE + TILE_PIXEL_SIZE / 2;
  const injectedPlacement: LightPlacementTiled = {
    gridX: INJECTED.gridX,
    gridY: INJECTED.gridY,
    kind: 'torch',
    anchor: 'route',
    rotation: 0,
    flipH: false,
    flipV: false,
  };
  const injectedEntity: LightPropAuditEntity = {
    id: `dest_light_${INJECTED.gridY}_${INJECTED.gridX}`,
    type: 'light',
    x: center(INJECTED.gridX),
    y: center(INJECTED.gridY),
  };

  describe('the shared baked-exemption data table', () => {
    it('exempts exactly beacons (kind) + doorway sconces (anchor) — nothing else', () => {
      const base = { gridX: 0, gridY: 0, rotation: 0, flipH: false, flipV: false };
      // Exempt: the owner's carve-out.
      expect(isBakedExemptLightPlacement({ ...base, kind: 'beacon' })).toBe(true);
      expect(isBakedExemptLightPlacement({ ...base, kind: 'torch', anchor: 'doorway' })).toBe(true);
      // Everything else — including campfire (entity-backed, NOT baked) and
      // every conversion anchor — is NOT baked-exempt.
      const nonExempt: LightPlacementTiled[] = [
        { ...base, kind: 'torch', anchor: 'route' },
        { ...base, kind: 'brazier', anchor: 'fill' },
        { ...base, kind: 'brazier', anchor: 'poi-pool' },
        { ...base, kind: 'biome-glow', anchor: 'crystal' },
        { ...base, kind: 'campfire', anchor: 'campfire' },
        { ...base, kind: 'torch' }, // a dropped anchor is NOT exempt
      ];
      for (const p of nonExempt) {
        expect(isBakedExemptLightPlacement(p)).toBe(false);
      }
    });
  });

  describe('gate across the standard seed set (production hydration)', () => {
    for (const { seed, label } of STANDARD_SEEDS) {
      it(`seed ${label}: zero violations in all three audit counters`, () => {
        const placements = adaptedPlacements(seed);
        const entities = hydratedEntities(seed);
        const result = auditLightPropBacking(placements, entities);

        expect(result.unbackedNonExemptLights, JSON.stringify(result)).toHaveLength(0);
        expect(result.unbackedLightEntities, JSON.stringify(result)).toHaveLength(0);
        expect(result.overConvertedExemptLights, JSON.stringify(result)).toHaveLength(0);

        // The audit ran over real content on both sides (not vacuously 0).
        expect(placements.filter((p) => !isBakedExemptLightPlacement(p)).length).toBeGreaterThan(0);
        expect(entities.filter((e) => e.type === 'light').length).toBeGreaterThan(0);
      });
    }
  });

  describe('teeth: deliberately-injected failures MUST fail the gate', () => {
    it('an unbacked non-exempt placement fails the gate (the ticket criterion)', () => {
      const placements = adaptedPlacements(42);
      const entities = hydratedEntities(42);
      expect(auditLightPropBacking(placements, entities).unbackedNonExemptLights).toHaveLength(0);

      const result = auditLightPropBacking([...placements, injectedPlacement], entities);
      expect(result.unbackedNonExemptLights).toHaveLength(1);
      expect(result.unbackedNonExemptLights[0]).toMatchObject({
        gridX: INJECTED.gridX,
        gridY: INJECTED.gridY,
        anchor: 'route',
        reason: 'no-light-entity',
      });
    });

    it('a future anchor type the hydration rule does not convert fails the gate', () => {
      const placements = adaptedPlacements(42);
      const entities = hydratedEntities(42);
      // Simulates a NEW anchor pass whose placements nobody added to
      // LIGHT_PROP_ENTITY_ANCHORS: emitted at a real free tile, never
      // hydrated. (The double cast models a not-yet-modeled union member.)
      const forgotten: LightPlacementTiled = {
        ...injectedPlacement,
        anchor: 'chandelier' as unknown as LightAnchor,
      };
      const result = auditLightPropBacking([...placements, forgotten], entities);
      expect(result.unbackedNonExemptLights).toHaveLength(1);
      expect(result.unbackedNonExemptLights[0]!.reason).toBe('no-light-entity');
    });

    it('an orphan light entity (no backing placement) fails the gate', () => {
      const placements = adaptedPlacements(42);
      const entities = hydratedEntities(42);
      const result = auditLightPropBacking(placements, [...entities, injectedEntity]);
      expect(result.unbackedLightEntities).toHaveLength(1);
      expect(result.unbackedLightEntities[0]).toMatchObject({
        id: injectedEntity.id,
        gridX: INJECTED.gridX,
        gridY: INJECTED.gridY,
      });
    });

    it('over-conversion (a light entity at a baked-exempt tile) fails the gate', () => {
      const placements = adaptedPlacements(42);
      const entities = hydratedEntities(42);
      const beacon = placements.find((p) => p.kind === 'beacon')!;
      const overConverted: LightPropAuditEntity = {
        id: `dest_light_${beacon.gridY}_${beacon.gridX}`,
        type: 'light',
        x: center(beacon.gridX),
        y: center(beacon.gridY),
      };
      const result = auditLightPropBacking(placements, [...entities, overConverted]);
      expect(result.overConvertedExemptLights).toHaveLength(1);
      // ...and the same entity is flagged from the reverse side too (an
      // exempt tile backs no convertible placement).
      expect(result.unbackedLightEntities).toHaveLength(1);
    });

    it('two non-exempt placements claiming one tile fail the gate', () => {
      const placements = adaptedPlacements(42);
      const entities = hydratedEntities(42);
      const twin: LightPlacementTiled = { ...injectedPlacement, kind: 'brazier' };
      const result = auditLightPropBacking([...placements, injectedPlacement, twin], entities);
      const dupes = result.unbackedNonExemptLights.filter(
        (v) => v.reason === 'duplicate-placement',
      );
      expect(dupes).toHaveLength(2); // each claimant is flagged
    });

    it('a campfire whose crate backing is missing fails the gate', () => {
      const placements = adaptedPlacements(42);
      const entities = hydratedEntities(42);
      const campfire = placements.find((p) => p.anchor === 'campfire')!;
      // Drop the non-light (crate) entity at the campfire tile.
      const stripped = entities.filter((e) => {
        const atCampfireTile =
          Math.floor(e.x / TILE_PIXEL_SIZE) === campfire.gridX &&
          Math.floor(e.y / TILE_PIXEL_SIZE) === campfire.gridY;
        return !(atCampfireTile && e.type !== 'light');
      });
      const result = auditLightPropBacking(placements, stripped);
      expect(
        result.unbackedNonExemptLights.filter((v) => v.reason === 'no-crate-backing'),
      ).toHaveLength(1);
    });
  });

  describe('the manifest census (buildLightingReport carries the audit)', () => {
    for (const { seed, label } of STANDARD_SEEDS) {
      it(`seed ${label}: unbackedNonExemptLights === 0 (real + derived entities agree)`, () => {
        const { placements, grid } = adaptedFixture(seed);
        const report = buildLightingReport(
          placements,
          grid,
          [],
          undefined,
          [],
          hydratedEntities(seed),
        );
        expect(report.unbackedNonExemptLights).toBe(0);
        // Derived mode (no entity list — the deterministic hydration rules
        // over placements + grid) agrees: no placement the rules never back.
        const derived = buildLightingReport(placements, grid, [], undefined, []);
        expect(derived.unbackedNonExemptLights).toBe(0);
      });
    }

    it('derived light entities match the production-hydrated ones exactly', () => {
      for (const { seed } of STANDARD_SEEDS) {
        const { placements, grid } = adaptedFixture(seed);
        const derived = deriveExpectedLightBacking(placements, grid).filter(
          (e) => e.type === 'light',
        );
        const real = hydratedEntities(seed).filter((e) => e.type === 'light');
        const canonical = (list: LightPropAuditEntity[]) =>
          JSON.stringify(
            list
              .map(({ id, type, x, y }) => ({ id, type, x, y }))
              .sort((a, b) => (a.id < b.id ? -1 : 1)),
          );
        expect(canonical(derived)).toBe(canonical(real));
      }
    });

    it('an injected unbacked placement drives the manifest field above 0', () => {
      const { placements, grid } = adaptedFixture(42);
      const report = buildLightingReport(
        [...placements, injectedPlacement],
        grid,
        [],
        undefined,
        [],
        hydratedEntities(42),
      );
      expect(report.unbackedNonExemptLights).toBe(1);
    });
  });

  describe('seed-sweep determinism (extends the golden surface, ADR-0035)', () => {
    for (const { seed, label } of STANDARD_SEEDS) {
      it(`seed ${label}: repeated runs ⇒ byte-identical placements, entity list, audit`, () => {
        const serializeRun = () => ({
          placements: JSON.stringify(adaptedPlacements(seed)),
          entities: JSON.stringify(hydratedEntities(seed).sort((a, b) => (a.id < b.id ? -1 : 1))),
          audit: JSON.stringify(
            auditLightPropBacking(adaptedPlacements(seed), hydratedEntities(seed)),
          ),
        });
        expect(serializeRun()).toEqual(serializeRun());
      });
    }
  });
});
