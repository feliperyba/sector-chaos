/**
 * Map-redesign ticket 05 — golden light-placement fixtures.
 *
 * The DEC-005 hierarchy restructure CHANGES light placements by design (POI
 * glow pools, route-biased sconces, per-tier dark pockets, hue-discipline
 * enforcement) — the ticket sanctions regenerating the pins. These fixtures
 * pin the FINAL placement list (sconce layer + appended beacons, post
 * hue-discipline enforcement) for the standard seed set {1, 42, 999,
 * 0xdeadbeef} (the same seeds the shared MapData golden suite pins), so any
 * accidental light-stream shift after this ticket goes RED here.
 *
 * **Map-polish ticket 05 (beacon plaza real composition) re-pins ALL FOUR
 * goldens — the sanctioned cascade for that diff.** The ticket's mandated
 * stamping position (plazas stamped after assignLandmarks, BEFORE
 * EntityPlacer.place) makes lights placement a downstream consumer of the
 * entity pools: POI glow clusters anchor on chest clusters, doorway ladder
 * rungs read entity-claimed tiles, hearth selection reads crate tiles — so
 * plaza tiles shifting those pools legitimately moves 18–54 non-beacon
 * placements per golden seed (control experiment: with the stamp disabled the
 * lights goldens pass 5/5). The ticket's original "lights-seed byte-UNTOUCHED"
 * constraint was unachievable under its own stamping mandate; the orchestrator
 * sanctioned this re-pin (strip-diff discipline: ONLY `lightPlacements`
 * content differs — the beacon sub-lists are byte-identical, pinned separately
 * below against the pre-ticket-05 extraction). No placement-shape change, no
 * RNG/stream change ⇒ `PIPELINE_VERSION` stays 5.
 *
 * **Map-polish ticket 10 ADDENDUM repair (coordinated doorway-pair stepping)
 * previously re-pinned seeds 1 + 42** (both members step through the fallback
 * rungs TOGETHER: band end → outward → travel-inward). The per-seed doorway
 * outcomes after the ticket-05 cascade are audited in LightPlacer.test.ts
 * ("Anchor B doorway sconce PAIRS") and LightingDiscipline.test.ts.
 *
 * **Map-polish ticket 07 (light-prop destructible entities) re-pins ALL FOUR
 * goldens — the sanctioned diff is EXACTLY the new per-placement `anchor`
 * provenance field.** `kind` cannot discriminate exempt from convertible
 * (doorway/route/fill share the sconce kind mix), so ticket 07 adds
 * `anchor: 'doorway' | 'route' | 'fill' | 'poi-pool' | 'crystal' |
 * 'campfire'` to every sconce-layer placement (beacons stay kind-identified,
 * NO anchor). ZERO RNG draws added/moved (ADR 0035) — placements, kinds and
 * overrides are byte-identical per seed (strip-diff audited at re-pin time:
 * same length, same order, identical placement bodies modulo the `anchor`
 * key), so `PIPELINE_VERSION` bumps 5 → 6 for the serialized-shape change
 * only. Note: the textual diff looks large because `anchor` pushes each
 * placement line past the 100-col prettier width, wrapping every object —
 * the SEMANTIC diff is one field per placement.
 *
 * **Map-polish ticket 14 (wall composition gate) re-pins ALL FOUR goldens —
 * the sanctioned cascade for that diff.** The zero-RNG `WallCompositionPass`
 * (final tile-mutating step, PIPELINE_VERSION 6 → 7) clears unsanctioned
 * orphan wall stubs / converts orphaned destructible walls to crates; the
 * entity pools the light ladder reads (doorway rung occupancy, POI glow
 * anchors, hearth candidacy) shift with those tiles — 1–3 placements per
 * golden seed change kind/anchor while total counts stay ~97–99. The beacon
 * sub-lists are byte-identical (landmarks are assigned PRE-pass — pinned
 * separately below, unchanged). Same cascade class as the ticket-05 plaza
 * stamp; zero RNG draws added/moved (ADR 0035) — the pass is a pure grid
 * function and the light streams themselves are untouched.
 *
 * **Map-polish round-2 ticket 18 (corridor sconces: one prop, one tone)
 * re-pins ALL FOUR goldens — the sanctioned diff is the doorway layer's
 * kind/color fields + the documented downstream cascade.** The doorway KIND
 * draw was REMOVED from the isolated light stream (the root cause of the
 * owner's "2 random pieces": both pair members drew independently — 14–18 of
 * the 24 pairs per seed mixed two props with two palette tones). Every
 * doorway placement is now the FIXED `DOORWAY_SCONCE_KIND` ('torch') with
 * the FIXED `DOORWAY_SCONCE_COLOR` (the menu registry's TONE_WARM
 * [1.0,0.55,0.22]) — strip-diff: doorway rows change kind (where not already
 * torch) + gain the `color` block; positions/anchors byte-identical; pair
 * counts EXACTLY as pinned (23/1 seed 1, 24/0 the others). The sanctioned
 * cascade: the ~48 removed draws shift the stream for every later kind pick
 * (route-mid + dark-gap fill kinds) and the fill-pass candidate shuffle. The
 * beacon sub-lists stay byte-identical (pinned separately below). No
 * serialized `MapData` shape change (`color` is an existing optional field)
 * ⇒ `PIPELINE_VERSION` stays 8 (the ticket-03/15 ride precedent; v8 re-pin
 * changelog entry in shared `map/constants.ts`).
 *
 * **Map-polish round-3 ticket 25 (prefab library + smart reuse) re-pins ALL
 * FOUR goldens — the sanctioned cascade for that diff.** The deterministic
 * prefab placement pass (PIPELINE_VERSION 9 → 10) replaces the refinement
 * scatter passes with authored compositions stamped into open pockets
 * BEFORE landmark assignment / entity placement (isolated 'PREF' stream —
 * zero main-stream draws), so the entity pools the light ladder reads shift
 * through the ticket-05/24 cascade class. The beacon sub-lists re-pin
 * position-only (fallback-path hero anchors — see the v10 changelog in
 * shared `map/constants.ts`; colors/intensities/radii unchanged), pinned
 * separately below. Regenerated via the ticket-24 ESM-path procedure
 * (MapGenerator source → SeedMapAdapter.adapt → lightPlacements, prettier-
 * formatted like the committed pins).
 *
 * Determinism contract (ADR 0035): same seed ⇒ byte-identical placements.
 * The light + crystal streams are isolated salts; the ticket-05 passes and
 * the ticket-10 doorway pairs draw ZERO new RNG for POSITION (pure
 * geometry), and (ticket 18) ZERO draws for the doorway KIND too — one
 * fixed prop + one fixed tone.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { MapGenerator, type LightPlacementTiled } from '@sector-battle/shared';
import { SeedMapAdapter } from '../SeedMapAdapter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, '__fixtures__');
const TILED_DIR = resolve(__dirname, '../../../../../../tiled');

function serialize(placements: LightPlacementTiled[]): string {
  return JSON.stringify(placements);
}

function loadGolden(filename: string): string {
  const raw = readFileSync(join(fixturesDir, filename), 'utf-8');
  // Canonical on both sides (parse + restringify tolerates formatting drift).
  return JSON.stringify(JSON.parse(raw));
}

function adaptedPlacements(seed: number): LightPlacementTiled[] {
  const mapData = new MapGenerator().generate(seed);
  const enriched = new SeedMapAdapter().adapt(mapData, seed, TILED_DIR);
  return enriched.entities.lightPlacements;
}

describe('Light placements golden fixtures (map-redesign ticket 05, DEC-005)', () => {
  it('seed 1 produces byte-identical placements to the ticket-05 golden', () => {
    expect(serialize(adaptedPlacements(1))).toBe(loadGolden('lights-seed-1.json'));
  });

  it('seed 42 produces byte-identical placements to the ticket-05 golden', () => {
    expect(serialize(adaptedPlacements(42))).toBe(loadGolden('lights-seed-42.json'));
  });

  it('seed 999 produces byte-identical placements to the ticket-05 golden', () => {
    expect(serialize(adaptedPlacements(999))).toBe(loadGolden('lights-seed-999.json'));
  });

  it('seed 0xdeadbeef produces byte-identical placements to the ticket-05 golden', () => {
    expect(serialize(adaptedPlacements(0xdeadbeef))).toBe(
      loadGolden('lights-seed-3735928559.json'),
    );
  });

  it('BEACON placements are byte-identical to the pre-ticket-05 pins (map-polish 05 cascade ruling)', () => {
    // The beacons are the A/B-owned content (positions/colors/intensities/
    // radii — map-polish tickets 01–04 tuned them; topic D keeps them baked).
    // The ticket-05 plaza stamp never moves a landmark anchor, so the beacon
    // sub-list must ride the re-pinned goldens UNCHANGED. These pins were
    // extracted verbatim from the pre-ticket-05 `lights-seed-*.json` fixtures
    // at the re-pin (ruling 1 of the sanctioned-cascade repair); any drift in
    // a beacon position/color/intensity/radius goes RED here even when the
    // surrounding non-beacon placements were legitimately re-pinned.
    for (const { seed, file } of [
      { seed: 1, file: 'beacons-pinned-seed-1.json' },
      { seed: 42, file: 'beacons-pinned-seed-42.json' },
      { seed: 999, file: 'beacons-pinned-seed-999.json' },
      { seed: 0xdeadbeef, file: 'beacons-pinned-seed-3735928559.json' },
    ]) {
      const beacons = adaptedPlacements(seed).filter((p) => p.kind === 'beacon');
      expect(
        beacons.length,
        `${file}: 16 heroes + 2–3 minors (+1 fortress)`,
      ).toBeGreaterThanOrEqual(19);
      expect(beacons.length, `${file}: hero + minor + fortress beacon set`).toBeLessThanOrEqual(20);
      expect(serialize(beacons)).toBe(loadGolden(file));
    }
  });

  it('the goldens carry the hierarchy (beacons + POI pools present, per seed)', () => {
    for (const file of [
      'lights-seed-1.json',
      'lights-seed-42.json',
      'lights-seed-999.json',
      'lights-seed-3735928559.json',
    ]) {
      const placements = JSON.parse(
        readFileSync(join(fixturesDir, file), 'utf-8'),
      ) as LightPlacementTiled[];
      // Beacons (ticket 04) survive the hierarchy restructure untouched.
      expect(placements.filter((p) => p.kind === 'beacon').length).toBeGreaterThanOrEqual(18);
      // The POI glow layer exists (ticket 05).
      expect(
        placements.filter((p) => p.kind === 'brazier' && p.intensity === 1.7).length,
      ).toBeGreaterThan(0);
    }
  });
});
