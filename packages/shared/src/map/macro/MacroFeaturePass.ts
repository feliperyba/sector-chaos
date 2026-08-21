import { SeededRNG } from '../rng/SeededRNG.js';
import { avalanche } from '../lootTiers.js';
import { carveHighway } from './Highway.js';
import { placeCompound } from './MegaStructure.js';
import { placeBarrierRidge } from './BarrierRidge.js';
import { placeOpenCommons } from './OpenCommons.js';
import type { MacroFeatureResult } from './MacroTypes.js';
import type { SectorData } from '../types.js';

/**
 * Isolated RNG stream seed XOR constant ('HIGW' in ASCII hex).
 * Ensures macro feature RNG draws do NOT shift the main pipeline RNG stream.
 */
const MACRO_SEED_XOR = 0x48494757;

/**
 * Isolated RNG stream seed XOR constant for the compound ('COMP' in ASCII hex).
 * Kept separate from the highway stream so changes to one feature's draw count
 * never perturb the other feature's output.
 */
const COMPOUND_SEED_XOR = 0x434f4d50;

/**
 * Isolated RNG stream seed XOR constant for the rare Citadel variant
 * ('CITD' in ASCII hex — map-redesign ticket 06 / DEC-004.1). The stream is
 * AVALANCHE-MIXED (`avalanche(seed ^ CITD)` — same decorrelation treatment
 * as the TIER/HOTS/NAME/DESG identity streams) so the seed-parameterized
 * rarity roll (~10–15% band) does not cluster on step-adjacent seeds, and
 * every Citadel geometry draw (seam order, gap starts, guardian-trap count)
 * stays fully decoupled from the COMP stream: standard maps draw the exact
 * same COMP sequence as before ticket 06 except the template-index bound
 * (3 templates → 4, the sanctioned compound-template selection change).
 */
const CITADEL_SEED_XOR = 0x43495444;

/**
 * Isolated RNG stream seed XOR constant for the seed-selected flavor feature
 * ('FLAV' in ASCII hex). The flavor RNG draws both (a) the 33/33/33 choice
 * between ridge / commons / nothing AND (b) every subsequent draw the chosen
 * feature makes, so neither feature's output is perturbed by edits to the
 * other or to the highway / compound streams.
 */
const FLAVOR_SEED_XOR = 0x464c4156;

/**
 * Orchestrator for cross-sector macro features.
 *
 * Runs AFTER sector skeletons, corridors, and border cleanup are complete but
 * BEFORE entity placement. Carves the Highway (always), places the
 * mega-structure compound (always), then rolls a 33/33/33 seed-selected
 * flavor feature: Barrier Ridge, Open Commons, or neither.
 *
 * Order matters: the highway is carved first, then the compound is placed
 * with the highway's carved-tile set in hand so it can yield to the highway
 * on overlaps (highway wins). The flavor feature runs last with the union of
 * highway + compound carved tiles so it can yield to both on overlaps.
 *
 * Feature priority (ADR 0028): outer map perimeter (untouchable) → Highway →
 * Mega-structure → Barrier Ridge / Open Commons (outer sectors, avoid
 * mega-structure zone).
 */
export class MacroFeaturePass {
  /**
   * Apply all macro features to the sector grid.
   *
   * @param sectors - the 2D sector grid (mutated in place)
   * @param seed - the pipeline seed (XOR'd to isolate each feature's RNG stream)
   * @returns metadata about carved features for downstream passes (heal, entity exclusion)
   */
  apply(sectors: SectorData[][], seed: number): MacroFeatureResult {
    const highwayRng = new SeededRNG(seed ^ MACRO_SEED_XOR);
    const highway = carveHighway(sectors, highwayRng);

    // Compound uses a SEPARATE XOR'd stream so its RNG draws are independent of
    // the highway's draw count. Pass the highway's carved tiles so the compound
    // can yield (highway wins) on any overlap. The Citadel roll + geometry use
    // a THIRD, avalanche-mixed stream (CITD — see above) so the rare-variant
    // draws never perturb the standard COMP sequence.
    //
    // The COMP stream is AVALANCHE-MIXED (map-redesign ticket 06): plain
    // salted seeds correlate on step-adjacent seeds (measured: the first
    // nextInt(0, N) draw returned the SAME bucket for 200 consecutive seeds —
    // the exact pathology lootTiers.ts documents), which collapsed the
    // template family to one variant across seed sweeps. Avalanche restores
    // the uniform draw (measured 45/49/56/50 over 200 seeds). Sanctioned
    // compound-template-selection change — golden fixtures re-pin.
    const compoundRng = new SeededRNG(avalanche((seed ^ COMPOUND_SEED_XOR) >>> 0));
    const citadelRng = new SeededRNG(avalanche((seed ^ CITADEL_SEED_XOR) >>> 0));
    const highwayTiles = highway?.carvedTiles ?? new Set<string>();
    const compound = placeCompound(sectors, compoundRng, highwayTiles, citadelRng);

    // Flavor feature uses a SEPARATE XOR'd stream so its 33/33/33 roll AND its
    // chosen feature's subsequent draws are independent of the highway and
    // compound streams. The flavor feature yields to both via `allCarved`.
    const flavorRng = new SeededRNG(seed ^ FLAVOR_SEED_XOR);
    const allCarved = new Set<string>([...highwayTiles, ...(compound?.carvedTiles ?? [])]);

    let barrierRidge = null;
    let openCommons = null;

    const choice = flavorRng.nextInt(0, 2);
    if (choice === 0) {
      barrierRidge = placeBarrierRidge(sectors, flavorRng, allCarved, allCarved);
    } else if (choice === 1) {
      openCommons = placeOpenCommons(sectors, flavorRng);
    }
    // choice === 2: nothing — adds per-seed variety via absence.

    return { highway, compound, barrierRidge, openCommons };
  }
}
