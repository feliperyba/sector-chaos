/**
 * Map-polish ticket 07 — light-prop destructible entities: every NON-EXEMPT
 * light placement converts to a live, damageable, server-authoritative
 * `'light'` destructible entity; the exemption set (beacons +
 * corridor-passage doorway sconces; campfires keep their crate backing)
 * stays baked static data.
 *
 * Covers the ticket's generation+hydration criteria on the standard seed set
 * {1, 42, 999, 0xdeadbeef} (the lights-golden seeds):
 *
 *  - PROVENANCE: every sconce-layer placement carries an `anchor` label;
 *    beacons stay kind-identified (no anchor) — `kind` alone cannot
 *    discriminate exempt from convertible.
 *  - CONVERSION: non-exempt placements hydrate as `'light'` entities with
 *    deterministic positional ids (`dest_light_<row>_<col>`) at tile centers.
 *  - EXEMPTION: zero `'light'` entities at beacon/doorway placement tiles.
 *  - NON-SOLID: every light entity's tile stays EMPTY in the grid.
 *  - REGRESSION: crate/barrel/wall/iron entities are byte-identical with the
 *    light hydration present vs absent (lights are purely additive).
 *  - DETERMINISM: same seed ⇒ byte-identical placements + identical hydrated
 *    entity list (ids, types, positions).
 *
 * Census values (21/20/19/22 converted, 48/48/47/48 doorway exempt,
 * 19–20 beacons) are measured on the CURRENT pipeline (post map-polish 05
 * plaza cascade + ticket 10 doorway pairs + round-2 ticket 16 + round-3
 * ticket 24 beacon keep) and PINNED here — the ticket's "≈19–21" band is
 * approximate by design. Ticket-24 cascade (keep tiles → entity pools →
 * doorway ladder): seed 1's ticket-16 degraded aperture (0,1)|(0,2) HEALED
 * (47→48 doorway exempt) while seed 999 picks up the one honestly-
 * asymmetric aperture — (0,2)|(0,3) H (axis row 10): member 0's band end
 * (59,9) is claimed by an EXIT prop (wall_demolished), outward (59,8) is
 * INDESTRUCTIBLE_WALL, travel-inward (58,9) a tree destructible ⇒ no solo
 * rung, survivor torch on member 1's band end (59,11) ⇒ 23/1 (the
 * ticket-05 genuine-degradation class). Convertibles re-measured through
 * the same entity-pool shift (18→21 / 20→20 / 19→19 / 24→22).
 */
import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import {
  MapGenerator as SharedMapGenerator,
  TILE_PIXEL_SIZE,
  PIPELINE_VERSION,
  TileType,
  isLightPropEntityPlacement,
  type LightPlacementTiled,
} from '@sector-battle/shared';
import type { DestructibleType } from '../../../domain/entities/Destructible.ts';
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

/**
 * Pinned conversion census (measured post map-polish 05 + 10 + 14 + 16,
 * re-measured after the round-3 ticket-24 beacon-keep cascade: the keep's
 * 13 walls + 2 props per hero shift the entity pools the light ladder
 * reads — same sanctioned cascade class as the ticket-05 plaza stamp;
 * re-measured again after the round-3 ticket-25 prefab pass — the prefab
 * stamps shift the pools through the same class).
 */
const PINNED_CONVERTED: Record<number, number> = {
  // Ticket-24 keep cascade: 18→21 / 20→20 / 19→19 / 24→22 (entity-pool
  // shift; measured from the re-pinned lights-seed-*.json goldens).
  // Ticket-25 prefab cascade: 21→19 / 20→23 / 19→20 / 22→21 (measured from
  // the re-pinned lights-seed-*.json goldens via the ticket-24 ESM-path
  // regeneration).
  // Ticket-28 fill-removal + prefab-promotion cascade: 19→19 / 23→25 / 20→17
  // / 21→23 (same entity-pool shift class; measured from the re-pinned
  // lights-seed-*.json goldens).
  // Round-6 material/density cascade (v15: breach panels + prefab
  // enrichment): 21→19 / 25→23 / 17→16 / 22→23 (same entity-pool shift
  // class; measured from the re-pinned lights-seed-*.json goldens).
  // Round-7 cohesion cascade (v16: structure-backed chests + randomized
  // preferred picks + two-phase framing prefab scan + ±2 stamp spacing):
  // 19→18 / 23→19 / 16→20 / 23→22 (same entity-pool shift class; measured
  // from the re-pinned lights-seed-*.json goldens).
  // Round-8 run-join-guard cascade (v17: stamps never create a 3-cardinal
  // wall junction — prefab runs and keep segments conflict-clip around
  // pre-existing walls): 18→17 / 19→22 / 20→18 / 22→25 (same entity-pool
  // shift class; measured from the re-pinned lights-seed-*.json goldens).
  1: 17,
  42: 22,
  999: 18,
  0xdeadbeef: 25,
};

/** Pinned doorway-exempt census (2 sconces/aperture post ticket 10). */
const PINNED_DOORWAY: Record<number, number> = {
  // Ticket-24 keep cascade: seed 1's ticket-16 degraded aperture HEALED
  // (47→48); seed 999 picks up the one honestly-asymmetric aperture —
  // (0,2)|(0,3) H (axis row 10), member 0's band end (59,9) claimed by an
  // EXIT prop, outward (59,8) wall, travel-inward (58,9) a tree destructible
  // ⇒ sibling-only, survivor torch on (59,11) (the ticket-05
  // genuine-degradation class; re-derived from the seed-999 map data — grid
  // tiles + adapter collections at every rung).
  // Ticket-25 prefab cascade: the degraded aperture moves seed 999→seed 1
  // (seed 1: 48→47 picks up the one sibling-only aperture; seed 999: 47→48
  // heals) — the entity-pool shift moves which aperture's rungs are claimed,
  // the same lottery as the ticket-14/16/24 re-measures.
  // Ticket-28 fill-removal + prefab-promotion cascade: every aperture's rungs
  // resolve fully again (48/48/48/48 — seed 1's ticket-25 sibling-only
  // aperture heals) — the same entity-pool lottery, measured from the
  // re-pinned lights-seed-*.json goldens.
  // Round-5e (v14): the aperture lottery moved the one sibling-only aperture
  // back to seed 1 (47/48/48/48).
  // Round-6 (v15): the breach-panel materials healed it again — every
  // aperture resolves fully (48/48/48/48; measured from the re-pinned
  // lights-seed-*.json goldens).
  // Round-7 (v16): every aperture still resolves fully (48/48/48/48;
  // measured from the re-pinned lights-seed-*.json goldens).
  // Round-8 (v17): still fully resolved (48/48/48/48; measured from the
  // re-pinned lights-seed-*.json goldens).
  1: 48,
  42: 48,
  999: 48,
  0xdeadbeef: 48,
};

function adaptedPlacements(seed: number): LightPlacementTiled[] {
  const mapData = new SharedMapGenerator().generate(seed);
  const enriched = new SeedMapAdapter().adapt(mapData, seed, TILED_DIR);
  return enriched.entities.lightPlacements;
}

/** A plain snapshot of one hydrated destructible (entity refs die with stop()). */
interface DestSnapshot {
  id: string;
  type: DestructibleType;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  textureKey: string;
}

/** Build the production orchestrator for a seed (real hydration path). */
function buildMatchDestructibles(seed: number): {
  lights: DestSnapshot[];
  nonLights: DestSnapshot[];
  grid: TileType[][];
} {
  const config = structuredClone(DEFAULT_CONFIG);
  const { mapResult, enrichedData } = buildGameMapResult(
    { mapType: 'procedural' },
    seed,
    config.map,
  );
  const orchestrator = createGameOrchestrator(`ticket07-${seed}`, config, mapResult, enrichedData);
  const state = orchestrator.getMatch().getState();
  const lights: DestSnapshot[] = [];
  const nonLights: DestSnapshot[] = [];
  // Snapshot BEFORE stop() — the sim recycles entity scratch on teardown.
  for (const d of state.destructibles.values()) {
    const snap: DestSnapshot = {
      id: d.id,
      type: d.type,
      x: d.position.x,
      y: d.position.y,
      hp: d.hp,
      maxHp: d.maxHp,
      textureKey: d.textureKey,
    };
    if (d.type === 'light') lights.push(snap);
    else nonLights.push(snap);
  }
  orchestrator.stop();
  return { lights, nonLights, grid: mapResult.grid };
}

describe('Light-prop destructible entities (map-polish ticket 07)', () => {
  it('bumps PIPELINE_VERSION for the serialized anchor-field shape change', () => {
    // v7 (map-polish ticket 14 — wall composition gate, tile-stream change).
    // v8 (map-polish round-2 ticket 16 — plaza archetype grammar, tile-stream
    // change: the 16 plaza layouts collapse into 4 archetypes, zero RNG).
    // v9 (map-polish round-3 ticket 24 — the beacon keep, tile-stream change:
    // the 4-archetype grammar is replaced by ONE authored ∩-shaped keep
    // around the beacon, zero RNG).
    // v10 (map-polish round-3 ticket 25 — prefab library + smart reuse,
    // tile-stream change: the refinement scatter passes are replaced by the
    // deterministic prefab placement pass — 10 authored compositions on an
    // isolated 'PREF' salted stream with paint-gate/conflict-clip/2×2/
    // never-seal guards; orphan cleanup preserved, zero main-stream draws).
    // v11 (map-polish round-3 ticket 26 — sector floor cohesion, visual-layer
    // change only: in-family floor bands + plaza accents, transparent-only
    // scatter; ZERO main-stream draws, no tile/entity change ⇒ light streams
    // byte-identical).
    // v12 (map-polish round-3 ticket 28 — interior structure organization,
    // tile-stream change: the skeleton per-cell scatter fills are removed and
    // the prefab placement pass is promoted to primary interior composer —
    // mostly-open ≥18/25 windows, caps 5/5/3/5, same isolated 'PREF' salt;
    // the fill-roll removal shifts the per-sector sub-block/mirror phases,
    // the sanctioned cascade — see the v12 changelog in shared
    // map/constants.ts).
    // v13 (map-polish round-4 ticket 29 — beacon plaza over the grid layers,
    // serialized-shape change: `MinorLandmark` loses `propId` with the removed
    // minor-prop bake; the LNDM-stream TAIL draw (per-minor prop pick) is
    // removed — earlier draws byte-identical, so light placements are
    // byte-identical and these censuses are UNCHANGED).
    expect(PIPELINE_VERSION).toBe(17); // v17: round-8 run-join guard (stamps never touch a foreign wall — thin junctions are unrenderable)
  });

  describe('provenance (the anchor discriminator)', () => {
    it('labels every non-beacon placement; beacons stay kind-identified', () => {
      const seen = new Set<string>();
      for (const { seed } of STANDARD_SEEDS) {
        for (const p of adaptedPlacements(seed)) {
          if (p.kind === 'beacon') {
            expect(
              p.anchor,
              'beacons never carry an anchor (kind-identified exemption)',
            ).toBeUndefined();
            continue;
          }
          expect(
            p.anchor,
            `non-beacon placement ${p.kind}@${p.gridX},${p.gridY} carries provenance`,
          ).toBeDefined();
          seen.add(p.anchor!);
        }
      }
      // Every anchor family fires across the standard seed set.
      expect(seen.has('campfire')).toBe(true);
      expect(seen.has('doorway')).toBe(true);
      expect([...seen].sort()).toEqual([
        'campfire',
        'crystal',
        'doorway',
        'fill',
        'poi-pool',
        'route',
      ]);
    });

    it('isLightPropEntityPlacement converts exactly route/fill/poi-pool/crystal', () => {
      for (const anchor of ['route', 'fill', 'poi-pool', 'crystal'] as const) {
        expect(
          isLightPropEntityPlacement({
            gridX: 0,
            gridY: 0,
            kind: 'torch',
            anchor,
            rotation: 0,
            flipH: false,
            flipV: false,
          }),
        ).toBe(true);
      }
      for (const anchor of ['doorway', 'campfire'] as const) {
        expect(
          isLightPropEntityPlacement({
            gridX: 0,
            gridY: 0,
            kind: 'torch',
            anchor,
            rotation: 0,
            flipH: false,
            flipV: false,
          }),
        ).toBe(false);
      }
      // Beacons (no anchor) are excluded.
      expect(
        isLightPropEntityPlacement({
          gridX: 0,
          gridY: 0,
          kind: 'beacon',
          rotation: 0,
          flipH: false,
          flipV: false,
        }),
      ).toBe(false);
    });
  });

  describe('conversion + exemption census (pinned per standard seed)', () => {
    for (const { seed, label } of STANDARD_SEEDS) {
      it(`seed ${label}: ${PINNED_CONVERTED[seed]} light-prop entities, ${PINNED_DOORWAY[seed]} doorway exempt`, () => {
        const placements = adaptedPlacements(seed);
        const converted = placements.filter((p) => isLightPropEntityPlacement(p));
        const doorway = placements.filter((p) => p.anchor === 'doorway');
        const beacons = placements.filter((p) => p.kind === 'beacon');

        expect(converted.length).toBe(PINNED_CONVERTED[seed]);
        expect(doorway.length).toBe(PINNED_DOORWAY[seed]);
        expect(beacons.length).toBeGreaterThanOrEqual(19);
        expect(beacons.length).toBeLessThanOrEqual(20);

        // The ticket's design band: ≈19–21 (seed 1 = 17 documented above).
        expect(converted.length).toBeGreaterThanOrEqual(15);
        expect(converted.length).toBeLessThanOrEqual(25);
      });
    }
  });

  describe('hydration (production path: buildGameMapResult → createGameOrchestrator)', () => {
    it('hydrates every non-exempt placement as a light entity with positional id + tile center', () => {
      for (const { seed } of STANDARD_SEEDS) {
        const placements = adaptedPlacements(seed);
        const { lights } = buildMatchDestructibles(seed);
        const convertible = placements.filter((p) => isLightPropEntityPlacement(p));
        expect(lights.length).toBe(convertible.length);

        const byTile = new Map(
          lights.map((d) => [
            `${Math.floor(d.y / TILE_PIXEL_SIZE)},${Math.floor(d.x / TILE_PIXEL_SIZE)}`,
            d,
          ]),
        );
        for (const p of convertible) {
          const light = byTile.get(`${p.gridY},${p.gridX}`);
          expect(light, `light entity at ${p.gridX},${p.gridY} (seed ${seed})`).toBeDefined();
          expect(light!.id).toBe(`dest_light_${p.gridY}_${p.gridX}`);
          expect(light!.maxHp).toBe(1);
          expect(light!.hp).toBe(1);
          expect(light!.textureKey).toBe(p.kind);
        }
      }
    });

    it('hydrates ZERO light entities at exempt (beacon/doorway/campfire) tiles', () => {
      for (const { seed } of STANDARD_SEEDS) {
        const placements = adaptedPlacements(seed);
        const { lights } = buildMatchDestructibles(seed);
        const exemptTiles = new Set(
          placements
            .filter((p) => !isLightPropEntityPlacement(p))
            .map((p) => `${p.gridY},${p.gridX}`),
        );
        expect(exemptTiles.size).toBeGreaterThan(0);
        for (const light of lights) {
          const key = `${Math.floor(light.y / TILE_PIXEL_SIZE)},${Math.floor(light.x / TILE_PIXEL_SIZE)}`;
          expect(exemptTiles.has(key), `no light entity at exempt tile ${key} (seed ${seed})`).toBe(
            false,
          );
        }
      }
    });

    it('keeps light-prop tiles EMPTY (non-solid: no walkability perturbation)', () => {
      for (const { seed } of STANDARD_SEEDS) {
        const { lights, grid } = buildMatchDestructibles(seed);
        expect(lights.length).toBeGreaterThan(0);
        for (const light of lights) {
          const gx = Math.floor(light.x / TILE_PIXEL_SIZE);
          const gy = Math.floor(light.y / TILE_PIXEL_SIZE);
          expect(grid[gy]![gx]!, `light tile ${gx},${gy} stays EMPTY (seed ${seed})`).toBe(
            TileType.EMPTY,
          );
        }
      }
    });

    it('regression: crate/barrel/wall/iron entities byte-identical with lights present or absent', () => {
      const seed = 42;
      const config = structuredClone(DEFAULT_CONFIG);
      const withLights = buildGameMapResult({ mapType: 'procedural' }, seed, config.map);
      const withoutLights = buildGameMapResult({ mapType: 'procedural' }, seed, config.map);
      delete withoutLights.mapResult.lightPlacements; // strip the conversion source

      const orchA = createGameOrchestrator(
        'ticket07-reg-a',
        config,
        withLights.mapResult,
        withLights.enrichedData,
      );
      const orchB = createGameOrchestrator(
        'ticket07-reg-b',
        config,
        withoutLights.mapResult,
        withoutLights.enrichedData,
      );
      const strip = (orch: typeof orchA) => {
        const out: Array<{ id: string; type: DestructibleType; x: number; y: number; hp: number }> =
          [];
        for (const d of orch.getMatch().getState().destructibles.values()) {
          if (d.type === 'light') continue;
          out.push({ id: d.id, type: d.type, x: d.position.x, y: d.position.y, hp: d.hp });
        }
        out.sort((a, b) => (a.id < b.id ? -1 : 1));
        return JSON.stringify(out);
      };
      expect(strip(orchA)).toBe(strip(orchB));
      orchA.stop();
      orchB.stop();
    });

    it('determinism: same seed ⇒ identical placements + identical light entity list', () => {
      for (const { seed } of STANDARD_SEEDS) {
        expect(JSON.stringify(adaptedPlacements(seed))).toBe(
          JSON.stringify(adaptedPlacements(seed)),
        );
        const a = buildMatchDestructibles(seed);
        const b = buildMatchDestructibles(seed);
        const serialize = (list: DestSnapshot[]) =>
          JSON.stringify(
            list
              .map((d) => ({ id: d.id, type: d.type, x: d.x, y: d.y }))
              .sort((p, q) => (p.id < q.id ? -1 : 1)),
          );
        expect(serialize(a.lights)).toBe(serialize(b.lights));
        expect(serialize(a.nonLights)).toBe(serialize(b.nonLights));
      }
    });
  });
});
