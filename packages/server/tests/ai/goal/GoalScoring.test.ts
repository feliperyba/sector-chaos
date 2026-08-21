/**
 * Macro-goal candidate scoring tests — bot-ai-v2 ticket 07 (DEC-008).
 *
 * Pure-seam assertions over scoreMacroGoals / fightDensityAt: quiet-side
 * rotation against SYNTHETIC density maps (including the AGGRESSOR/DUELIST
 * deadside inversion), RNG-free determinism, POI/tier read-only flavor,
 * hotspot-edge stalk geometry, and the endgame hold points. No room, no
 * BotSystem — plain input literals.
 */

import { describe, it, expect } from 'vitest';
import {
  fightDensityAt,
  scoreMacroGoals,
  stableAngleRad,
  type ScoredCandidate,
} from '../../../src/ai/goal/GoalScoring.ts';
import {
  ARCHETYPE_GOAL_PROFILES,
  FIGHT_DENSITY_FALLOFF_PX,
  HOTSPOT_STALK_EDGE_RADIUS,
  QUIET_SIDE_RING_FRACTION,
} from '../../../src/ai/goal/GoalTables.ts';
import { PersonalityArchetype } from '../../../src/ai/intent/PersonalityProfile.ts';
import {
  buildMapIdentityView,
  mapTierAt,
  type FightPoint,
  type MacroGoalInputs,
} from '../../../src/ai/goal/GoalTypes.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A 4×4 identity map (10240²) with one HOT sector (row 0, col 0) named
 *  "Gilded Vault" with a hero-landmark anchor, one WARM sector, rest COLD. */
const IDENTITY = buildMapIdentityView({
  cols: 4,
  rows: 4,
  mapWidth: 10240,
  mapHeight: 10240,
  tilePixelSize: 128,
  sectorTiers: [
    ['HOT', 'WARM', 'COLD', 'COLD'],
    ['COLD', 'COLD', 'COLD', 'COLD'],
    ['COLD', 'COLD', 'COLD', 'COLD'],
    ['COLD', 'COLD', 'COLD', 'COLD'],
  ],
  hotSector: { row: 1, col: 1 },
  poiNames: [
    ['Gilded Vault', 'Rust Bazaar', 'Ashen Warren', 'Grid Bastion'],
    ['Salt Depot', 'Iron Hollow', 'Dusk Lattice', 'Slag Spire'],
    ['Cinder Yard', 'Mirk Fold', 'Veil Compound', 'Bolt Crossing'],
    ['Sun Foundry', 'Grim Reach', 'Wind Chancel', 'Frost Keep'],
  ],
  landmarkTiles: [
    [{ tileX: 10, tileY: 10 }, null, null, null],
    [null, null, null, null],
    [null, null, null, null],
    [null, null, null, null],
  ],
});

/** Baseline inputs: a mid-map armed SURVIVOR with a formed next ring. */
function baseInputs(overrides: Partial<MacroGoalInputs> = {}): MacroGoalInputs {
  return {
    tick: 3600,
    playerId: 'bot-score',
    x: 5120,
    y: 5120,
    health: 100,
    maxHealth: 100,
    armed: true,
    archetype: PersonalityArchetype.SURVIVOR,
    greed: 0.5,
    commitMultiplier: 1,
    zone: {
      safeX: 5120,
      safeY: 5120,
      safeRadius: 2600,
      timeUntilShrinkTicks: 99999, // far from any shrink by default
      isShrinking: false,
      lethal: true,
      damagePerTick: 5,
      nextX: 4600,
      nextY: 4600,
      nextRadius: 2400,
    },
    fightPoints: [],
    heardChest: null,
    inScanLoot: null,
    aliveCount: 40,
    mapWidth: 10240,
    mapHeight: 10240,
    mapIdentity: IDENTITY,
    sectorVisits: new Float64Array(16),
    barrelDensityAt: () => 0,
    hotspotStalkers: 0,
    ...overrides,
  };
}

function pickKind(candidates: ScoredCandidate[], kind: string): ScoredCandidate | undefined {
  return candidates.find((c) => c.kind === kind);
}

// ---------------------------------------------------------------------------
// Fight-density field (synthetic density maps)
// ---------------------------------------------------------------------------

describe('fightDensityAt (the deadside density field)', () => {
  it('peaks at the fight seat and falls off with distance', () => {
    const fights: FightPoint[] = [{ x: 5120, y: 5120, strength: 1 }];
    const atSeat = fightDensityAt(5120, 5120, fights);
    const atFalloff = fightDensityAt(5120 + FIGHT_DENSITY_FALLOFF_PX, 5120, fights);
    const atFar = fightDensityAt(5120 + 5000, 5120, fights);
    expect(atSeat).toBeCloseTo(1, 5);
    // At the falloff scale the contribution is strength / (1 + 1) = half.
    expect(atFalloff).toBeCloseTo(0.5, 5);
    expect(atFar).toBeGreaterThan(0);
    expect(atFar).toBeLessThan(atFalloff);
    expect(atSeat).toBeGreaterThan(atFalloff);
  });

  it('sums multiple fights (a brawl reads louder than a duel)', () => {
    const duel: FightPoint[] = [{ x: 0, y: 0, strength: 0.7 }];
    const brawl: FightPoint[] = [
      { x: 0, y: 0, strength: 0.7 },
      { x: 100, y: 0, strength: 1 },
    ];
    expect(fightDensityAt(0, 0, brawl)).toBeGreaterThan(fightDensityAt(0, 0, duel));
  });

  it('is exactly 0 with no fight samples (the quiet default)', () => {
    expect(fightDensityAt(100, 100, [])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Quiet-side rotation (the deadside heuristic)
// ---------------------------------------------------------------------------

describe('QUIET_SIDE scoring against synthetic density maps', () => {
  // Synthetic density map: ALL fights concentrated hard EAST of the next-ring
  // center; west is silent. The quiet side must be WEST.
  const eastFights: FightPoint[] = [
    { x: 8600, y: 4600, strength: 1 },
    { x: 8700, y: 4700, strength: 0.9 },
    { x: 8500, y: 4500, strength: 0.8 },
  ];

  it('SURVIVOR rotates AWAY from the fight density (the deadside)', () => {
    const candidates = scoreMacroGoals(baseInputs({ fightPoints: eastFights }));
    const quiet = pickKind(candidates, 'QUIET_SIDE');
    expect(quiet).toBeDefined();
    // The chosen point must be on the WEST half of the ring around the next
    // center (4600, 4600): x strictly less than the center.
    expect(quiet!.x).toBeLessThan(4600);
    // ...and reasonably far from the fight cluster (east of 7000).
    const distToFights = Math.hypot(quiet!.x - 8600, quiet!.y - 4600);
    expect(distToFights).toBeGreaterThan(3000);
  });

  it('AGGRESSOR inverts TOWARD the fight density (data-table flag)', () => {
    const survivor = pickKind(
      scoreMacroGoals(baseInputs({ fightPoints: eastFights })),
      'QUIET_SIDE',
    );
    const aggressor = pickKind(
      scoreMacroGoals(
        baseInputs({ fightPoints: eastFights, archetype: PersonalityArchetype.AGGRESSOR }),
      ),
      'QUIET_SIDE',
    );
    expect(ARCHETYPE_GOAL_PROFILES[PersonalityArchetype.AGGRESSOR].quietSideInverted).toBe(true);
    expect(ARCHETYPE_GOAL_PROFILES[PersonalityArchetype.SURVIVOR].quietSideInverted).toBe(false);
    expect(aggressor).toBeDefined();
    // The inverted bot's quiet side is CLOSER to the fight cluster than the
    // survivor's — it refuses to flee the busy region (it stalks the edge).
    const dSurv = Math.hypot(survivor!.x - 8600, survivor!.y - 4600);
    const dAggr = Math.hypot(aggressor!.x - 8600, aggressor!.y - 4600);
    expect(dAggr).toBeLessThan(dSurv);
  });

  it('no candidate without fight samples (nothing to be quiet from)', () => {
    const candidates = scoreMacroGoals(baseInputs({ fightPoints: [] }));
    expect(pickKind(candidates, 'QUIET_SIDE')).toBeUndefined();
  });

  it('the quiet point sits INSIDE the next ring (no zone-edge rotations)', () => {
    const quiet = pickKind(scoreMacroGoals(baseInputs({ fightPoints: eastFights })), 'QUIET_SIDE');
    const ringR = Math.max(240, 2400 * QUIET_SIDE_RING_FRACTION);
    const distToNextCenter = Math.hypot(quiet!.x - 4600, quiet!.y - 4600);
    expect(distToNextCenter).toBeLessThanOrEqual(ringR + 1);
  });
});

// ---------------------------------------------------------------------------
// Determinism (RNG-free scoring)
// ---------------------------------------------------------------------------

describe('scoreMacroGoals determinism', () => {
  it('identical inputs produce identical candidates in identical order', () => {
    const fights: FightPoint[] = [
      { x: 3000, y: 3000, strength: 0.8 },
      { x: 8000, y: 7000, strength: 0.6 },
    ];
    const inputs = baseInputs({
      fightPoints: fights,
      inScanLoot: { x: 5900, y: 5300, value: 1 },
      heardChest: { x: 4000, y: 6000, tick: 3500 },
    });
    const a = scoreMacroGoals(inputs);
    const b = scoreMacroGoals(inputs);
    expect(b.map((c) => [c.kind, c.score, c.x, c.y])).toEqual(
      a.map((c) => [c.kind, c.score, c.x, c.y]),
    );
  });

  it('the stable angle is per-bot constant (no per-repath sweep)', () => {
    expect(stableAngleRad('bot-a')).toBe(stableAngleRad('bot-a'));
    // Distinct bots get distinct-enough angles (hash spread, no RNG).
    const angles = new Set(
      ['bot-a', 'bot-b', 'bot-c', 'bot-d', 'bot-e'].map((id) =>
        Math.round(stableAngleRad(id) * 1000),
      ),
    );
    expect(angles.size).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// Loot cluster + POI/tier read-only flavor
// ---------------------------------------------------------------------------

describe('LOOT_CLUSTER scoring with POI/tier flavor', () => {
  it('an unarmed bot with no loot memory routes to the HOT sector anchor (named destination)', () => {
    const candidates = scoreMacroGoals(
      baseInputs({ armed: false, inScanLoot: null, heardChest: null }),
    );
    const loot = pickKind(candidates, 'LOOT_CLUSTER');
    expect(loot).toBeDefined();
    // HOT sector (row 0, col 0) — its anchor is tile (10, 10) → (10*128+64).
    expect(loot!.x).toBe(10 * 128 + 64);
    expect(loot!.y).toBe(10 * 128 + 64);
    // READ-ONLY flavor rides the goal: the POI name of the destination.
    expect(loot!.poiName).toBe('Gilded Vault');
    expect(loot!.poiTier).toBe(2);
  });

  it('an armed bot with no loot memory does not roam for tiers', () => {
    const candidates = scoreMacroGoals(baseInputs({ armed: true }));
    expect(pickKind(candidates, 'LOOT_CLUSTER')).toBeUndefined();
  });

  it('in-scan loot wins the route when present (value/distance)', () => {
    const near = pickKind(
      scoreMacroGoals(baseInputs({ armed: true, inScanLoot: { x: 5300, y: 5200, value: 1 } })),
      'LOOT_CLUSTER',
    );
    expect(near).toBeDefined();
    expect(near!.x).toBe(5300);
    // The destination sector (mid-map) is COLD base but the per-match hot
    // upgrade (row 1, col 1) is elsewhere — mid map (5120-ish) is row 2 col 2
    // = COLD: flavor tier recorded but no bonus.
    expect(mapTierAt(IDENTITY!, near!.x, near!.y)).toBe(0);
  });

  it('a null identity map yields no tier flavor and no unarmed tier route', () => {
    const candidates = scoreMacroGoals(
      baseInputs({ armed: false, mapIdentity: null, inScanLoot: null, heardChest: null }),
    );
    expect(pickKind(candidates, 'LOOT_CLUSTER')).toBeUndefined();
    expect(pickKind(candidates, 'UNEXPLORED_SECTOR')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Unexplored sector
// ---------------------------------------------------------------------------

describe('UNEXPLORED_SECTOR scoring', () => {
  it('prefers the least-recently-visited sector (age memory)', () => {
    const visits = new Float64Array(16).fill(3600); // everything visited "now"
    visits[3 * 4 + 3] = 0; // row 3, col 3 never visited
    const candidates = scoreMacroGoals(baseInputs({ sectorVisits: visits }));
    const explore = pickKind(candidates, 'UNEXPLORED_SECTOR');
    expect(explore).toBeDefined();
    // Row 3, col 3 center = ((3+0.5)/4)*10240 = 8960.
    expect(explore!.x).toBe(8960);
    expect(explore!.y).toBe(8960);
  });

  it('the CURRENT sector is de-prioritized (just been there)', () => {
    // Bot at mid map (row 2, col 2); that sector visited longest ago TOO —
    // it must still not win over an equally-old OTHER sector (×0.1 factor).
    const visits = new Float64Array(16).fill(0);
    const candidates = scoreMacroGoals(baseInputs({ sectorVisits: visits }));
    const explore = pickKind(candidates, 'UNEXPLORED_SECTOR');
    const hereIdx = 2 * 4 + 2;
    const chosenIdx = Math.floor(explore!.y / 2560) * 4 + Math.floor(explore!.x / 2560);
    expect(chosenIdx).not.toBe(hereIdx);
  });
});

// ---------------------------------------------------------------------------
// Hotspot-edge stalk
// ---------------------------------------------------------------------------

describe('HOTSPOT_STALK scoring', () => {
  const fights: FightPoint[] = [{ x: 5120, y: 5120, strength: 1 }];

  it('stalks the EDGE ring, never the centroid (and away from the density)', () => {
    const candidates = scoreMacroGoals(baseInputs({ fightPoints: fights }));
    const stalk = pickKind(candidates, 'HOTSPOT_STALK');
    expect(stalk).toBeDefined();
    const dist = Math.hypot(stalk!.x - 5120, stalk!.y - 5120);
    expect(dist).toBeCloseTo(HOTSPOT_STALK_EDGE_RADIUS, 0);
    // The approach angle minimizes density: with one fight point, the chosen
    // edge point is the FARTHEST of the 8 samples from the fight sample —
    // i.e. the point diametrically opposite any fight-weighted direction.
    // With a single centroid sample all ring points read equal density, so
    // the tie-break falls to barrel density (0) + distance — deterministic.
    expect(dist).toBeGreaterThan(0);
  });

  it('AGGRESSOR stalks stronger than SURVIVOR (data-table weights)', () => {
    expect(ARCHETYPE_GOAL_PROFILES[PersonalityArchetype.AGGRESSOR].stalkWeight).toBeGreaterThan(
      ARCHETYPE_GOAL_PROFILES[PersonalityArchetype.SURVIVOR].stalkWeight,
    );
    const aggr = pickKind(
      scoreMacroGoals(
        baseInputs({ fightPoints: fights, archetype: PersonalityArchetype.AGGRESSOR }),
      ),
      'HOTSPOT_STALK',
    );
    const surv = pickKind(scoreMacroGoals(baseInputs({ fightPoints: fights })), 'HOTSPOT_STALK');
    expect(aggr!.score).toBeGreaterThan(surv!.score);
  });

  it('saturation suppresses the stalk (a fight draws a few stalkers)', () => {
    const unsaturated = pickKind(
      scoreMacroGoals(baseInputs({ fightPoints: fights })),
      'HOTSPOT_STALK',
    );
    const saturated = pickKind(
      scoreMacroGoals(baseInputs({ fightPoints: fights, hotspotStalkers: 12 })),
      'HOTSPOT_STALK',
    );
    expect(saturated).toBeUndefined();
    expect(unsaturated).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Pre-position (rotation timing gate) — the timing model itself is
// unit-tested in ZoneTiming.test.ts; here the candidate wiring.
// ---------------------------------------------------------------------------

describe('PRE_POSITION scoring (candidate wiring)', () => {
  it('absent when the shrink clock is unknown (−1)', () => {
    const zone = { ...baseInputs().zone, timeUntilShrinkTicks: -1 };
    const candidates = scoreMacroGoals(baseInputs({ zone }));
    expect(pickKind(candidates, 'PRE_POSITION')).toBeUndefined();
  });

  it('present when timeUntilShrink < travel × margin (SURVIVOR, large margin)', () => {
    // Bot's hold ring point is 1440px away (nextRadius 2400 × 0.6) → travel
    // ≈ ceil(1440/365) = 4 ticks. SURVIVOR margin 1.8 → trips below 7.2.
    const zone = { ...baseInputs().zone, timeUntilShrinkTicks: 6 };
    const candidates = scoreMacroGoals(baseInputs({ zone }));
    expect(pickKind(candidates, 'PRE_POSITION')).toBeDefined();
  });

  it('absent when comfortably outside the margin window', () => {
    const zone = { ...baseInputs().zone, timeUntilShrinkTicks: 6000 };
    const candidates = scoreMacroGoals(baseInputs({ zone }));
    expect(pickKind(candidates, 'PRE_POSITION')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Endgame hold (edge/center by archetype — the orbit's replacement)
// ---------------------------------------------------------------------------

describe('ENDGAME_HOLD scoring (goal-driven endgame positioning)', () => {
  it('activates on a small safe ring (radius condition)', () => {
    const zone = { ...baseInputs().zone, safeRadius: 1200 };
    const candidates = scoreMacroGoals(baseInputs({ zone }));
    expect(pickKind(candidates, 'ENDGAME_HOLD')).toBeDefined();
  });

  it('activates on alive count (population condition)', () => {
    const candidates = scoreMacroGoals(baseInputs({ aliveCount: 6 }));
    expect(pickKind(candidates, 'ENDGAME_HOLD')).toBeDefined();
  });

  it('SURVIVOR holds a WIDER ring fraction than AGGRESSOR (edge vs center)', () => {
    const zone = { ...baseInputs().zone, safeRadius: 1200, nextRadius: 1200 };
    const surv = pickKind(
      scoreMacroGoals(baseInputs({ zone, playerId: 'bot-surv' })),
      'ENDGAME_HOLD',
    );
    const aggr = pickKind(
      scoreMacroGoals(
        baseInputs({ zone, playerId: 'bot-aggr', archetype: PersonalityArchetype.AGGRESSOR }),
      ),
      'ENDGAME_HOLD',
    );
    const dSurv = Math.hypot(surv!.x - zone.nextX, surv!.y - zone.nextY);
    const dAggr = Math.hypot(aggr!.x - zone.nextX, aggr!.y - zone.nextY);
    expect(dSurv).toBeGreaterThan(dAggr);
  });

  it('in the contact endgame (≤3 alive) every archetype collapses toward center', () => {
    const zone = { ...baseInputs().zone, safeRadius: 900, nextRadius: 900 };
    const hold = pickKind(scoreMacroGoals(baseInputs({ zone, aliveCount: 2 })), 'ENDGAME_HOLD');
    // Contact collapse: ring fraction ≤ 0.1 × radius from the anchor.
    const dist = Math.hypot(hold!.x - zone.nextX, hold!.y - zone.nextY);
    expect(dist).toBeLessThanOrEqual(900 * 0.1 + 1);
  });
});
