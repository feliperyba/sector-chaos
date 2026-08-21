import { SeededRNG } from './rng/SeededRNG.js';
import type { SectorConfig } from './sectors/ISectorGenerator.js';
import { selectSubVariants } from './sectors/subVariantSelector.js';
import type { SectorSubVariant } from './sectors/subVariants.js';
import { GridArenaGenerator } from './sectors/GridArenaGenerator.js';
import { OpenArenaGenerator } from './sectors/OpenArenaGenerator.js';
import { MazeGenerator } from './sectors/MazeGenerator.js';
import { ResourceRichGenerator } from './sectors/ResourceRichGenerator.js';
import { SectorConnector } from './SectorConnector.js';
import { LootSpawner } from './LootSpawner.js';
import { ExitPlacer } from './ExitPlacer.js';
import { EntityPlacer } from './EntityPlacer.js';
import { SpawnPointFinder } from './SpawnPointFinder.js';
import { MapValidator } from './MapValidator.js';
import { MacroFeaturePass } from './macro/MacroFeaturePass.js';
import { MacroHealPass } from './refinement/MacroHealPass.js';
import { PrefabPlacementPass } from './prefabs/PrefabPlacementPass.js';
import { WallCompositionPass } from './refinement/WallCompositionPass.js';
import { BreachPanelPass } from './refinement/BreachPanelPass.js';
import { MapBorder } from './MapBorder.js';
import { SectorDistributor } from './SectorDistributor.js';
import { applyProbabilisticSubBlocks } from './sectors/probabilisticBlocks.js';
import { maybeMirrorSector } from './sectors/skeletonMirror.js';
import { LegendaryBudget, assignSectorTiers, effectiveSectorTier } from './lootTiers.js';
import { repairSpawnEquity, type SpawnEquityAudit } from './spawnFairness.js';
import { generatePoiNames } from './poiNames.js';
import { assignLandmarks } from './landmarks.js';
import { stampLandmarkPlazas, type PlazaStamp } from './landmarkPlaza.js';
import { appendCompoundLoot, buildFortressInfo } from './compoundLoot.js';
import { generateVisualIdentity } from './visualIdentity.js';
import { biasedWeatherWeights } from './identitySheets.js';
import type { PrefabPassStats } from './prefabs/PrefabPlacementPass.js';
import type { MapConfig } from '../types/config/index.js';
import type { MapData, SectorData, SectorLootTier, SectorWeather } from './types.js';
import { SectorType } from './types.js';
import {
  SECTOR_GRID_SIZE,
  SECTOR_TILE_SIZE,
  TILE_PIXEL_SIZE,
  MAX_MAP_LEGENDARY,
} from './constants.js';

const MAX_RETRIES = 10;

/**
 * Generation-time audit of the LAST successful `generate()` call
 * (map-redesign ticket 10 / DEC-009). Deliberately NOT stored on `MapData` —
 * MapData is the golden-fixture byte-identity surface, and the audit is
 * telemetry about how the map was produced, not map content. The server-side
 * MapResult copies it out (benchmark manifest rides it).
 */
export interface GenerationAudit {
  /** Spawns re-picked by the fairness repair pass (0 = first-attempt clean). */
  spawnRepairs: number;
  /** How many pipeline attempts the successful map took (1 = first attempt). */
  generationAttempts: number;
  /** Post-repair fairness audit (gate-clean: violations is empty). */
  equity: SpawnEquityAudit;
}

interface GeneratorInstance {
  generate(rng: SeededRNG, config: SectorConfig): SectorData;
}

export class MapGenerator {
  private readonly connector = new SectorConnector();
  private readonly lootSpawner = new LootSpawner();
  private readonly entityPlacer = new EntityPlacer();
  private readonly exitPlacer = new ExitPlacer();
  private readonly spawnFinder = new SpawnPointFinder();
  private readonly validator = new MapValidator();
  private readonly macroFeaturePass = new MacroFeaturePass();
  private readonly macroHealPass = new MacroHealPass();
  private readonly prefabPlacementPass = new PrefabPlacementPass();
  private readonly wallCompositionPass = new WallCompositionPass();
  private readonly breachPanelPass = new BreachPanelPass();
  private readonly mapBorder = new MapBorder();
  private readonly sectorDistributor = new SectorDistributor();

  /** Audit of the last successful generate() (see {@link GenerationAudit}). */
  private lastGenerationAudit: GenerationAudit | null = null;

  /**
   * Plaza stamps of the last SUCCESSFUL pipeline attempt (map-polish ticket
   * 05). Telemetry only — deliberately NOT on MapData (golden fixtures pin
   * MapData bytes; the plaza geometry itself rides `sector.tiles`). Consumed
   * by the shared purity test to invert the stamp when replaying
   * `assignLandmarks`.
   */
  private lastPlazaStamps: PlazaStamp[] = [];

  /** Fairness-pass result of the last runPipeline attempt (consumed by generate). */
  private lastPipelineEquity: { repairs: number; audit: SpawnEquityAudit } | null = null;

  /**
   * Prefab-pass telemetry of the last runPipeline attempt (map-polish ticket
   * 25). Deliberately NOT on MapData (byte-identity surface) — same rule as
   * {@link lastGenerationAudit}. Counts the stamps of the SUCCESSFUL attempt.
   */
  private lastPrefabStats: PrefabPassStats | null = null;

  private readonly generators: Record<SectorType, GeneratorInstance>;

  constructor() {
    this.generators = {
      [SectorType.GRID_ARENA]: new GridArenaGenerator(),
      [SectorType.OPEN_ARENA]: new OpenArenaGenerator(),
      [SectorType.MAZE]: new MazeGenerator(),
      [SectorType.RESOURCE_RICH]: new ResourceRichGenerator(),
    };
  }

  generate(seed: number, _config?: MapConfig): MapData {
    let currentSeed = seed >>> 0;
    this.lastGenerationAudit = null;
    this.lastPipelineEquity = null;
    this.lastPlazaStamps = [];
    this.lastPrefabStats = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const rng = new SeededRNG(currentSeed);
      const mapData = this.runPipeline(currentSeed, rng);

      const result = this.validator.validate(mapData);
      if (result.valid) {
        // Ticket 10: repair counts + attempt count ride the generation audit
        // (NOT MapData — golden fixtures pin MapData bytes).
        const equity = this.lastPipelineEquity!;
        this.lastGenerationAudit = {
          spawnRepairs: equity.repairs,
          generationAttempts: attempt + 1,
          equity: equity.audit,
        };
        return mapData;
      }

      currentSeed = (currentSeed + 1) >>> 0;
    }

    throw new Error(`Map generation failed after ${MAX_RETRIES} retries for seed ${seed}`);
  }

  /** Audit of the last successful `generate()` (null before the first call
   *  or after a failed generation). Repair counts ride the benchmark manifest. */
  getLastGenerationAudit(): GenerationAudit | null {
    return this.lastGenerationAudit;
  }

  /** Plaza stamps written by the last successful `generate()` (empty before
   *  the first call). Telemetry — see {@link lastPlazaStamps}. */
  getLastPlazaStamps(): PlazaStamp[] {
    return this.lastPlazaStamps;
  }

  /** Prefab-pass stats of the last `generate()` (null before the first
   *  call). Telemetry only — never stored on MapData (golden fixtures pin
   *  MapData bytes; the prefab geometry itself rides `sector.tiles`). */
  getLastPrefabStats(): PrefabPassStats | null {
    return this.lastPrefabStats;
  }

  private runPipeline(seed: number, rng: SeededRNG): MapData {
    const typeGrid = this.sectorDistributor.distribute(rng);
    // Sub-variant selection runs on an isolated seed-derived RNG stream (see
    // selectSubVariants) — it must NOT consume from `rng`, or it would shift
    // every per-sector subSeed and change the generated tiles.
    const subVariantGrid = selectSubVariants(seed, typeGrid);
    const sectors = this.generateSectorLayouts(rng, typeGrid, subVariantGrid);
    const { connections, corridorTiles } = this.connector.connect(sectors, rng);
    this.mapBorder.carveWalls(sectors);
    this.mapBorder.cleanBuffer(sectors);

    // Macro features: highway + compound (always; the compound may roll the
    // rare 14×14 Citadel on the isolated avalanche-mixed CITD stream). Runs
    // on isolated RNG streams (seed XOR'd inside MacroFeaturePass) so
    // existing generation is NOT perturbed.
    //
    // The tier pyramid is computed BEFORE the macro pass (a pure function of
    // the seed — zero RNG) so `appendCompoundLoot` below can tier-integrate
    // the compound chests against the same effective-tier lookup every other
    // placer consumes. Hoisting the call changes nothing downstream.
    const tierAssignment = assignSectorTiers(seed);
    const macroResult = this.macroFeaturePass.apply(sectors, seed);

    // Heal damage from macro features (dangling wall stubs, orphaned cover).
    this.macroHealPass.run(sectors, macroResult);

    // Exclude macro-feature tiles from prefab + entity placement so neither
    // compositions nor loot/entities land on the highway center/shoulder
    // tiles or inside the compound footprint (compound chests are placed
    // explicitly by the template). Built BEFORE the prefab pass (hoisted from
    // its old post-refinement position — a pure read of macroResult, so the
    // hoist is behavior-neutral for every other consumer).
    const macroTiles = new Set<string>();
    if (macroResult.highway) for (const t of macroResult.highway.carvedTiles) macroTiles.add(t);
    if (macroResult.compound) for (const t of macroResult.compound.carvedTiles) macroTiles.add(t);
    if (macroResult.barrierRidge)
      for (const t of macroResult.barrierRidge.carvedTiles) macroTiles.add(t);
    if (macroResult.openCommons)
      for (const t of macroResult.openCommons.carvedTiles) macroTiles.add(t);

    // Prefab placement pass (map-polish ticket 25): the deterministic
    // smart-reuse replacement for the refinement stage's scatter passes
    // (dead-zone 3-crate shapes, sightline midpoint crates, density-balance
    // top-ups). Featureless all-EMPTY 5×5 pockets now receive ONE authored
    // composition from the prefab library (`prefabs/PrefabLibrary.ts`),
    // selected + oriented on an isolated XOR-salted stream (ADR 0035) with
    // per-sector reuse variation; the stage's zero-RNG orphan cleanup is
    // preserved inside the pass. Stays BEFORE landmark assignment / plaza
    // keeps / entity placement for the same reasons the refinement stage did:
    // the placers must see the final cover, and the landmark anchor
    // resolution must see the post-placement grid (the pass keeps every
    // authored anchor EMPTY by construction, so `assignLandmarks` still
    // resolves to the skeleton-authored sites).
    this.lastPrefabStats = this.prefabPlacementPass.run(sectors, seed, corridorTiles, macroTiles);

    // Loot-tier pyramid (map-redesign ticket 02): every sector gets a seed-
    // authored tier on an isolated XOR-salted stream (see lootTiers.ts) — the
    // tier drives chest/ground-weapon weight tables, and one non-central WARM
    // sector is upgraded to HOT for the match (hot sector). Computed from
    // `seed` (NOT drawn from `rng`) so the tile/entity streams are untouched.
    // (Hoisted above the macro pass — see the comment there.)
    // Landmark pass (map-redesign ticket 04 / DEC-002): every sector reserves
    // exactly one hero landmark on its skeleton-authored anchor site, plus
    // 2–3 junction minor landmarks. Computed from `seed` on an isolated
    // XOR-salted stream (see landmarks.ts) — NOT drawn from `rng` — so the
    // tile/entity/tier streams are untouched. Runs BEFORE the naming pass so
    // the POI noun can align with the chosen landmark family.
    const landmarkAssignment = assignLandmarks(
      seed,
      sectors,
      typeGrid,
      corridorTiles,
      tierAssignment,
    );
    // Beacon plazas (map-polish ticket 05): every hero landmark's region
    // becomes REAL authored geometry — indestructible wall segments framing
    // the anchor (Chebyshev-2 ring, ≥2 openings, segments ≥2 tiles) + 2–4
    // REAL destructible crate tiles flanking the approaches. A PURE
    // projection of the landmark assignment (authored per composition id,
    // ZERO RNG — neither the main stream nor the LNDM stream is touched),
    // stamped AFTER assignLandmarks (final anchors) and BEFORE
    // EntityPlacer.place (the entity pool must see the plaza — its walls
    // are cover and its crates hydrate to live destructible entities via
    // the existing grid path). Paint-gated: only ever writes onto EMPTY,
    // non-corridor, non-macro, non-lootSpot, interior tiles; the anchor +
    // its 4 cardinal neighbours are never touched, so the guaranteed
    // walkway to the beacon holds.
    this.lastPlazaStamps = stampLandmarkPlazas(
      sectors,
      corridorTiles,
      landmarkAssignment,
      macroTiles,
    );
    // Round-5e border-buffer re-clean: `cleanBuffer` above runs BEFORE the
    // prefab pass and the plaza keeps, both of which may stamp wall tiles at
    // sector-local row/col 1/18 — flush against the border ring. Those late
    // walls corrupt the ring tiles' 8-neighbour masks (buried cross/inner
    // roles mid-run, dirty gate-jamb flanks — the exact failure mode the
    // buffer clean exists to prevent), so the discipline is re-asserted on
    // the FINAL wall grid, after the last wall-writing pass and before the
    // composition pass heals whatever the clearing orphans. Only the compound
    // / Citadel footprint is preserved (its yard band AUTHORS walls at
    // sector-local 1..2 by design and owns its border interaction; highway
    // shoulders / ridge ends near the ring follow the buffer rule like every
    // other stamper). Idempotent and zero-RNG (ADR 0035); a clipped keep run
    // reads as a ruin breach.
    this.mapBorder.cleanBuffer(
      sectors,
      macroResult.compound ? macroResult.compound.carvedTiles : undefined,
    );
    // Breach panel pass (map-polish round 6): the wall MATERIAL policy —
    // INTERNAL composition only: straight-run middles and exactly-2-thick
    // interior band faces convert to DESTRUCTIBLE_WALL in a periodic panel
    // rhythm with rigid anchors (sector border seams, map edge, endpoints,
    // junctions, thick cores), so players can smash structural breaches inside
    // sectors instead of being railroaded through authored gaps. Pure zero-RNG
    // geometry (ADR 0035); the compound/Citadel footprint is preserved (it
    // authors its own breach segments — breakable yard, rigid vault shell).
    // Runs after the final border-buffer re-clean and BEFORE the composition
    // pass: material flips are wall-likeness-preserving, but the composition
    // pass + entity/loot/spawn placement must see the final materials.
    this.breachPanelPass.run(
      sectors,
      macroResult.compound ? macroResult.compound.carvedTiles : undefined,
    );
    // Wall composition pass (map-polish ticket 14): enforces the wall
    // composition rules on the final tile grid — clears unsanctioned orphan
    // indestructible stubs (the 1-tile notched gate-jamb remnants; maze
    // separator pillars are sanctioned and stay) and converts orphaned
    // destructible walls to crates so standing breakable WALL cover is always
    // in ≥2-tile clusters. Runs AFTER every wall-writing pass (this is the
    // last tile-mutating step before entity/loot/spawn placement) and is a
    // PURE zero-RNG grid function, so compliant seeds are byte-identical and
    // the RNG streams are untouched (ADR 0035).
    this.wallCompositionPass.run(sectors);
    // POI naming pass (map-redesign ticket 03 / DEC-001 + DEC-010): every
    // sector + macro feature gets a unique generated display name, and the
    // map gets its designation. Computed from `seed` on isolated XOR-salted
    // streams (see poiNames.ts) — NOT drawn from `rng` — so the
    // tile/entity/tier streams are untouched. The noun draw is restricted to
    // the chosen landmark's nounHints (ticket 04 noun alignment).
    const poiNameAssignment = generatePoiNames(
      seed,
      typeGrid,
      subVariantGrid,
      macroResult,
      landmarkAssignment.heroes,
    );
    // Shared map-wide legendary budget: caps total LEGENDARY placements
    // (chests + ground weapons + loot-spawner rolls combined) at ~10/map.
    const legendaryBudget = new LegendaryBudget(MAX_MAP_LEGENDARY);
    // Effective tier per sector (base pyramid + hot upgrade) as a lookup the
    // placers consume — a plain function of `tierAssignment`.
    const tierOf = (row: number, col: number): SectorLootTier =>
      effectiveSectorTier(tierAssignment, row, col);
    // Sector-TYPE lookup (same injection pattern) for the fortress beacon's
    // theme color — the anchor sector's identity hue (map-polish ticket 03).
    const typeOf = (row: number, col: number): SectorType => typeGrid[row]![col]!;

    // Map-redesign ticket 04 determinism note: the landmark pass appends ZERO
    // reservations to the entity placer — anchors/minors are chosen on the
    // post-refinement PRE-entity grid, and entities (chests/barrels, which
    // write tiles) may legitimately claim an anchor tile afterwards: a chest
    // on the vault-core landmark is "loot crowds the landmark", exactly the
    // DEC-002 "landmark sits ON the gameplay" intent, and the GDD §5.3.1/§5.6
    // entity rules + loot minimums stay byte-identical to pre-ticket-04
    // output (the tile/entity streams must keep their draw order — ADR 0035).
    // The 2–3-tile exclusion zone is DECOR-free only: it is enforced
    // server-side in SeedMapAdapter (accents + sconce/crystal lights), never
    // here.
    const { entityPlacements, chestLootPlacements, groundWeaponPlacements, trapPlacements } =
      this.entityPlacer.place(sectors, corridorTiles, rng, macroTiles, tierOf, legendaryBudget);
    // Map-redesign ticket 06 (DEC-004): the compound's authored chests/traps
    // become REAL placements — appended AFTER every sector/spawner roll so
    // the main RNG streams and pre-existing legendary outcomes are untouched
    // (the vault chest only spends leftover LegendaryBudget headroom).
    const compoundLoot = appendCompoundLoot(macroResult.compound!, tierOf, legendaryBudget, seed);
    const lootPlacements = [
      ...chestLootPlacements,
      ...groundWeaponPlacements,
      ...this.lootSpawner.spawn(sectors, rng, tierOf, legendaryBudget),
      ...compoundLoot.chestPlacements,
    ];
    const allTrapPlacements = [...trapPlacements, ...compoundLoot.trapPlacements];
    const exits = this.exitPlacer.place(sectors, rng);
    const spawnPoints = this.spawnFinder.find(sectors, rng);
    // Map-redesign ticket 10 (DEC-009): per-spawn fairness repair pass —
    // re-picks any spawn that is >30% worse than its sector's eligible-pool
    // median on a value-vector component (nearest weapon/chest/clump + path
    // distance to the nearest effective-HOT sector), plus any spawn sitting
    // on a server-rejected destructible-clearance tile. Deterministic (zero
    // RNG draws — pure ranking over the sector's eligible pool), runs AFTER
    // the spawn pass and BEFORE validation so the equity gate in MapValidator
    // sees the post-repair state. Repair counts ride the generation audit
    // (getLastGenerationAudit), never MapData.
    this.lastPipelineEquity = repairSpawnEquity({
      sectors,
      spawnPoints,
      lootPlacements,
      sectorTiers: tierAssignment.tiers,
      hotSector: tierAssignment.hotSector,
      entityPlacements,
    });
    // Weather roll (map-redesign ticket 07 / DEC-006 #6): the per-sector roll
    // is biased by fiction + EFFECTIVE tier via `biasedWeatherWeights`
    // (STORM leans HOT, SNOW leans the cold outer band, NONE dominant). The
    // draws still come from the SAME main stream at the SAME positions (one
    // weightedPick per sector, weather is the last main-rng consumer), so
    // only the OUTCOMES change — never the stream layout (ADR 0035).
    const weather = this.generateWeather(rng, typeGrid, tierAssignment);

    // Visual identity pass (map-redesign ticket 07 / DEC-006): per-sector
    // floor tint fields + per-connection gateway dressing. Runs on the
    // isolated IDTY stream (see visualIdentity.ts) — zero main-rng draws —
    // and reads the already-computed entity/trap placements for the hazard-
    // stain anchors. VISUAL-ONLY: no tile, collision or entity changes.
    const identity = generateVisualIdentity(
      seed,
      sectors,
      typeGrid,
      connections,
      entityPlacements,
      allTrapPlacements,
      landmarkAssignment,
    );

    return {
      seed,
      sectors,
      connections,
      spawnPoints,
      exits,
      lootPlacements,
      entityPlacements,
      trapPlacements: allTrapPlacements,
      weather,
      globalBounds: {
        width: SECTOR_GRID_SIZE * SECTOR_TILE_SIZE * TILE_PIXEL_SIZE,
        height: SECTOR_GRID_SIZE * SECTOR_TILE_SIZE * TILE_PIXEL_SIZE,
      },
      corridorTiles,
      sectorTiers: tierAssignment.tiers,
      hotSector: tierAssignment.hotSector,
      poiNames: poiNameAssignment.sectorNames,
      macroPoiNames: poiNameAssignment.macroNames,
      designation: poiNameAssignment.designation,
      landmarks: landmarkAssignment,
      fortress: buildFortressInfo(macroResult.compound, tierOf, typeOf),
      sectorTypes: typeGrid,
      identity,
    };
  }

  private generateSectorLayouts(
    rng: SeededRNG,
    typeGrid: SectorType[][],
    subVariantGrid: SectorSubVariant[][],
  ): SectorData[][] {
    const sectors: SectorData[][] = [];

    for (let row = 0; row < SECTOR_GRID_SIZE; row++) {
      sectors[row] = [];
      for (let col = 0; col < SECTOR_GRID_SIZE; col++) {
        const type = typeGrid[row]![col]!;
        const gen = this.generators[type];
        // The per-sector subSeed/fork order is UNCHANGED from before sub-variants
        // existed, so each generator receives the identical subRng as today and
        // the main stream position is untouched by anything below.
        const subSeed = rng.nextUint32();
        const subRng = rng.fork(subSeed);

        const config: SectorConfig = {
          width: SECTOR_TILE_SIZE,
          height: SECTOR_TILE_SIZE,
          tileSize: TILE_PIXEL_SIZE,
          type,
          theme: 'default',
          sectorCoord: { row, col },
          subVariant: subVariantGrid[row]![col]!,
        };

        const sector = gen.generate(subRng, config);
        // RNG CONTRACT (map-redesign ticket 08 / DEC-007 + Wei's dissent,
        // encoded as the ticket criterion): the forked per-sector stream is
        // consumed in three strictly APPENDED phases —
        //   (1) the base skeleton draw inside gen.generate (draw count/order
        //       unchanged from before this ticket),
        //   (2) the probabilistic sub-block presence dice — exactly ONE
        //       nextFloat() per authored sub-block, in authored order
        //       (probabilisticBlocks.ts),
        //   (3) the horizontal-mirror die — ONE nextFloat()
        //       (skeletonMirror.ts), flipping the fully-built grid INCLUDING
        //       any present sub-blocks.
        // Never interleaved with the base draw: for a given subSeed the base
        // skeleton bytes are identical to pre-ticket output, so the fixture
        // regeneration stays the single planned v3-continuity bump (layout
        // geometry + downstream cascade only — the identity streams stay on
        // their own isolated salts).
        applyProbabilisticSubBlocks(sector, subRng);
        maybeMirrorSector(sector, subRng);
        sectors[row]![col] = sector;
      }
    }

    return sectors;
  }

  private generateWeather(
    rng: SeededRNG,
    typeGrid: SectorType[][],
    tierAssignment: ReturnType<typeof assignSectorTiers>,
  ): SectorWeather[] {
    const weather: SectorWeather[] = [];

    for (let row = 0; row < SECTOR_GRID_SIZE; row++) {
      for (let col = 0; col < SECTOR_GRID_SIZE; col++) {
        // Fiction + tier bias (identity sheet data — see identitySheets.ts):
        // the weights differ per sector, but the roll consumes exactly ONE
        // draw per sector in the same row-major order as before.
        const weights = biasedWeatherWeights(
          typeGrid[row]![col]!,
          effectiveSectorTier(tierAssignment, row, col),
        );
        const weatherType = rng.weightedPick(weights);
        weather.push({
          sectorCoord: { row, col },
          weatherType,
        });
      }
    }

    return weather;
  }
}
