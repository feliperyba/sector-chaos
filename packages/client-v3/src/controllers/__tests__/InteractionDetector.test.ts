/**
 * Unit tests for `InteractionDetector` — the per-frame proximity scanner that
 * selects the nearest chest/weapon-pickup target and builds the interaction
 * prompt string.
 *
 * The chest-opening prompt now carries a live 5-segment progress bar +
 * percentage (built from `openingProgress / CHEST.OPEN_DURATION`), replacing
 * the old static `'Opening chest...'`. This test locks down:
 *  1. The closed-chest prompt is still `'[E] Open chest'`.
 *  2. The opening prompt changes as `openingProgress` advances (so it bypasses
 *     HUDManager's `===` dirty-check every frame — the timer reads live).
 *  3. The bar fills monotonically + the percentage rounds correctly.
 *  4. The detector selects the nearest chest when multiple are in range.
 *  5. (Ticket #41) The squared-distance scan selects the exact same candidate
 *     as the old sqrt-per-item scan across a swept battery, including
 *     exact-radius boundary cases.
 *  6. (Ticket #41) Prompt strings are rebuilt only when their cache key
 *     changes (candidate determinants / chest-progress bucket) while the
 *     rendered content + refresh cadence stay identical.
 *
 * `StateSync` is mocked as the minimal `getEntities()` surface the detector
 * reads (`chests` + `weaponPickups` Maps). No Phaser, no network.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { CHEST, weaponRegistry, WeaponType } from '@sector-battle/shared';
import { InteractionDetector } from '../InteractionDetector.js';
import type { ChestState, WeaponPickupState } from '../../types.js';
import type { StateSync } from '../../network/StateSync.js';

function makeChest(overrides: Partial<ChestState> = {}): ChestState {
  return {
    id: 'chest-1',
    tier: 0,
    x: 100,
    y: 100,
    state: 0,
    openingPlayerId: '',
    openingProgress: 0,
    textureKey: 'chest',
    rotation: 0,
    flipH: false,
    flipV: false,
    ...overrides,
  };
}

function makeWeapon(overrides: Partial<WeaponPickupState> = {}): WeaponPickupState {
  return {
    id: 'wp-1',
    weaponType: WeaponType.DAGGER,
    tier: 0,
    ammo: 10,
    maxAmmo: 10,
    x: 100,
    y: 100,
    lifetime: 1,
    textureKey: 'weapon-dagger',
    rotation: 0,
    flipH: false,
    flipV: false,
    ...overrides,
  };
}

/**
 * Build a minimal StateSync stub exposing only `getEntities()` with the two
 * Maps the detector reads (chests + weaponPickups). Cast through unknown — the
 * detector only touches this surface.
 */
function makeStateSync(
  chests: Map<string, ChestState> = new Map(),
  weaponPickups: Map<string, WeaponPickupState> = new Map(),
): StateSync {
  return {
    getEntities: () => ({
      players: new Map(),
      projectiles: new Map(),
      destructibles: new Map(),
      chests,
      weaponPickups,
      traps: new Map(),
      powerUps: new Map(),
      explosions: new Map(),
      exits: new Map(),
    }),
  } as unknown as StateSync;
}

/**
 * The PRE-#41 detector algorithm, kept verbatim (sqrt per item, prompt built
 * inside the loop on every improvement) as the equivalence reference for the
 * ticket-#41 battery. Any behavior-preserving refactor must produce identical
 * output to this function across the whole sweep.
 */
function referenceDetect(
  localX: number,
  localY: number,
  stateSync: StateSync,
): { pickupId: string; chestId: string; type: '' | 'weapon' | 'chest'; prompt: string } {
  const entities = stateSync.getEntities();
  const TIER_NAMES = ['Common', 'Uncommon', 'Rare', 'Legendary'];

  let bestWeaponDist = 32;
  let bestWeaponId = '';
  let bestWeaponPrompt = '';
  for (const [id, wp] of entities.weaponPickups) {
    if (wp.lifetime <= 0) continue;
    const dx = wp.x - localX;
    const dy = wp.y - localY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < bestWeaponDist) {
      bestWeaponDist = dist;
      bestWeaponId = id;
      const wName = weaponRegistry.getDefinition(wp.weaponType)?.name ?? 'Weapon';
      const tierName = wp.tier > 0 ? (TIER_NAMES[wp.tier] ?? '') : '';
      bestWeaponPrompt = tierName ? `[E] Pick up ${tierName} ${wName}` : `[E] Pick up ${wName}`;
    }
  }

  let bestChestDist: number = CHEST.INTERACTION_RANGE;
  let bestChestId = '';
  let bestChestPrompt = '';
  for (const [id, c] of entities.chests) {
    if (c.state >= 2) continue;
    const dx = c.x - localX;
    const dy = c.y - localY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < bestChestDist) {
      bestChestDist = dist;
      bestChestId = id;
      bestChestPrompt =
        c.state === 1
          ? (() => {
              const ratio = Math.max(0, Math.min(1, c.openingProgress / CHEST.OPEN_DURATION));
              const filled = Math.round(ratio * 5);
              const bar = '▓'.repeat(filled) + '░'.repeat(5 - filled);
              return `Opening ${bar} ${Math.round(ratio * 100)}%`;
            })()
          : '[E] Open chest';
    }
  }

  if (bestChestId && bestChestDist < bestWeaponDist) {
    return { pickupId: '', chestId: bestChestId, type: 'chest', prompt: bestChestPrompt };
  }
  if (bestWeaponId) {
    return { pickupId: bestWeaponId, chestId: '', type: 'weapon', prompt: bestWeaponPrompt };
  }
  if (bestChestId) {
    return { pickupId: '', chestId: bestChestId, type: 'chest', prompt: bestChestPrompt };
  }
  return { pickupId: '', chestId: '', type: '', prompt: '' };
}

describe('InteractionDetector — chest prompt', () => {
  it('shows "[E] Open chest" for a closed chest in range', () => {
    const chests = new Map([['c1', makeChest({ x: 100, y: 100, state: 0 })]]);
    const sync = makeStateSync(chests);
    const det = new InteractionDetector();
    det.detect(100, 100, sync);
    expect(det.nearestType).toBe('chest');
    expect(det.interactionPrompt).toBe('[E] Open chest');
  });

  it('shows a progress-bar prompt for an opening chest', () => {
    const chests = new Map([['c1', makeChest({ x: 100, y: 100, state: 1, openingProgress: 0 })]]);
    const sync = makeStateSync(chests);
    const det = new InteractionDetector();
    det.detect(100, 100, sync);
    expect(det.interactionPrompt).toMatch(/Opening/);
    // Bar is 5 segments of ▓/░ + a percentage
    expect(det.interactionPrompt).toMatch(/[▓░]{5}/);
    expect(det.interactionPrompt).toMatch(/%/);
  });

  it('the prompt changes as openingProgress advances (bypasses HUD dirty-check)', () => {
    // The HUDManager.setInteractionPrompt dirty-check is `text === last`; a
    // static prompt would be skipped after the first frame. The progress bar
    // MUST change every frame so the timer reads live.
    const chest = makeChest({ x: 100, y: 100, state: 1, openingProgress: 0 });
    const sync = makeStateSync(new Map([['c1', chest]]));
    const det = new InteractionDetector();
    det.detect(100, 100, sync);
    const at0 = det.interactionPrompt;

    chest.openingProgress = CHEST.OPEN_DURATION * 0.5; // 50%
    det.detect(100, 100, sync);
    const at50 = det.interactionPrompt;

    chest.openingProgress = CHEST.OPEN_DURATION; // 100%
    det.detect(100, 100, sync);
    const at100 = det.interactionPrompt;

    expect(at0).not.toBe(at50);
    expect(at50).not.toBe(at100);
    expect(at0).not.toBe(at100);
  });

  it('the bar fills + percentage rounds correctly at known progress points', () => {
    const chest = makeChest({ x: 100, y: 100, state: 1, openingProgress: 0 });
    const sync = makeStateSync(new Map([['c1', chest]]));
    const det = new InteractionDetector();

    // 0% → 0 filled segments
    chest.openingProgress = 0;
    det.detect(100, 100, sync);
    expect(det.interactionPrompt).toContain('░░░░░');
    expect(det.interactionPrompt).toContain('0%');

    // 50% → ~3 filled segments (round(0.5 * 5) = 3)
    chest.openingProgress = CHEST.OPEN_DURATION * 0.5;
    det.detect(100, 100, sync);
    expect(det.interactionPrompt).toContain('▓▓▓');
    expect(det.interactionPrompt).toContain('50%');

    // 100% → 5 filled segments
    chest.openingProgress = CHEST.OPEN_DURATION;
    det.detect(100, 100, sync);
    expect(det.interactionPrompt).toContain('▓▓▓▓▓');
    expect(det.interactionPrompt).toContain('100%');
  });

  it('clamps openingProgress above the duration to 100% (defensive)', () => {
    const chest = makeChest({
      x: 100,
      y: 100,
      state: 1,
      openingProgress: CHEST.OPEN_DURATION * 2, // way past
    });
    const sync = makeStateSync(new Map([['c1', chest]]));
    const det = new InteractionDetector();
    det.detect(100, 100, sync);
    expect(det.interactionPrompt).toContain('100%');
    expect(det.interactionPrompt).toContain('▓▓▓▓▓');
  });

  it('selects the nearest of multiple chests in range', () => {
    const chests = new Map([
      ['far', makeChest({ id: 'far', x: 300, y: 100, state: 0 })],
      ['near', makeChest({ id: 'near', x: 120, y: 100, state: 0 })],
    ]);
    const sync = makeStateSync(chests);
    const det = new InteractionDetector();
    det.detect(100, 100, sync);
    expect(det.nearestChestId).toBe('near');
  });

  it('skips already-open chests (state >= 2)', () => {
    const chests = new Map([['open', makeChest({ id: 'open', x: 100, y: 100, state: 2 })]]);
    const sync = makeStateSync(chests);
    const det = new InteractionDetector();
    det.detect(100, 100, sync);
    expect(det.nearestChestId).toBe('');
    expect(det.interactionPrompt).toBe('');
  });
});

describe('InteractionDetector — weapon prompt', () => {
  it('shows "[E] Pick up <name>" for a tier-0 weapon pickup', () => {
    const wName = weaponRegistry.getDefinition(WeaponType.DAGGER).name;
    const sync = makeStateSync(
      new Map(),
      new Map([['w1', makeWeapon({ id: 'w1', x: 110, y: 100, weaponType: WeaponType.DAGGER, tier: 0 })]]),
    );
    const det = new InteractionDetector();
    det.detect(100, 100, sync);
    expect(det.nearestType).toBe('weapon');
    expect(det.nearestPickupId).toBe('w1');
    expect(det.interactionPrompt).toBe(`[E] Pick up ${wName}`);
  });

  it('prepends the tier name for tier > 0 pickups', () => {
    const wName = weaponRegistry.getDefinition(WeaponType.HAMMER).name;
    const sync = makeStateSync(
      new Map(),
      new Map([['w1', makeWeapon({ id: 'w1', x: 100, y: 100, weaponType: WeaponType.HAMMER, tier: 2 })]]),
    );
    const det = new InteractionDetector();
    det.detect(100, 100, sync);
    expect(det.interactionPrompt).toBe(`[E] Pick up Rare ${wName}`);
  });

  it('skips expired pickups (lifetime <= 0) and selects the nearest live one', () => {
    const sync = makeStateSync(
      new Map(),
      new Map([
        ['dead', makeWeapon({ id: 'dead', x: 101, y: 100, lifetime: 0 })],
        ['near', makeWeapon({ id: 'near', x: 110, y: 100 })],
        ['far', makeWeapon({ id: 'far', x: 125, y: 100 })],
      ]),
    );
    const det = new InteractionDetector();
    det.detect(100, 100, sync);
    expect(det.nearestPickupId).toBe('near');
  });
});

describe('InteractionDetector — squared-scan equivalence battery (ticket #41)', () => {
  /**
   * Deterministic LCG (no `Math.random`) — the battery must be reproducible.
   * Multiplications stay under 2^53 so the recurrence is exact.
   */
  function lcg(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 2 ** 32;
    };
  }

  /** Run both detectors on the same world and assert identical output. */
  function assertEquivalent(
    chests: Map<string, ChestState>,
    weaponPickups: Map<string, WeaponPickupState>,
    x: number,
    y: number,
  ): void {
    const sync = makeStateSync(chests, weaponPickups);
    const det = new InteractionDetector();
    det.detect(x, y, sync);
    const ref = referenceDetect(x, y, sync);
    expect(det.nearestPickupId).toBe(ref.pickupId);
    expect(det.nearestChestId).toBe(ref.chestId);
    expect(det.nearestType).toBe(ref.type);
    expect(det.interactionPrompt).toBe(ref.prompt);
  }

  it('exact-radius boundary: weapon at distance exactly 32 is excluded (d2 == 1024)', () => {
    // dx=32, dy=0 → d2 = 1024 exactly; sqrt(1024) = 32 exactly. Both the old
    // `32 < 32` and the new `1024 < 1024` are false → excluded.
    assertEquivalent(new Map(), new Map([['b', makeWeapon({ id: 'b', x: 132, y: 100 })]]), 100, 100);
    const det = new InteractionDetector();
    det.detect(100, 100, makeStateSync(new Map(), new Map([['b', makeWeapon({ id: 'b', x: 132, y: 100 })]])));
    expect(det.nearestPickupId).toBe('');
    expect(det.interactionPrompt).toBe('');

    // dy-only variant + the 3-4-5-style diagonal 19.2/25.6 (real d2 = 1024,
    // and 19.2² + 25.6² evaluates to exactly 1024.0 in double arithmetic).
    assertEquivalent(new Map(), new Map([['b', makeWeapon({ id: 'b', x: 100, y: 132 })]]), 100, 100);
    assertEquivalent(new Map(), new Map([['b', makeWeapon({ id: 'b', x: 119.2, y: 125.6 })]]), 100, 100);
  });

  it('exact-radius boundary: chest at distance exactly 192 is excluded (d2 == 36864)', () => {
    assertEquivalent(new Map([['b', makeChest({ id: 'b', x: 292, y: 100 })]]), new Map(), 100, 100);
    const det = new InteractionDetector();
    det.detect(100, 100, makeStateSync(new Map([['b', makeChest({ id: 'b', x: 292, y: 100 })]])));
    expect(det.nearestChestId).toBe('');
    expect(det.interactionPrompt).toBe('');

    // axis variant + scaled diagonal (115.2, 153.6) — real d2 = 36864.
    assertEquivalent(new Map([['b', makeChest({ id: 'b', x: 100, y: 292 })]]), new Map(), 100, 100);
    assertEquivalent(new Map([['b', makeChest({ id: 'b', x: 215.2, y: 253.6 })]]), new Map(), 100, 100);
  });

  it('sub-boundary perturbations agree on both sides of each radius', () => {
    for (const eps of [1, 0.5, 0.25, 0.001, 1e-6, 1e-9]) {
      // Weapon radius 32: just inside (included) / just outside (excluded).
      assertEquivalent(new Map(), new Map([['w', makeWeapon({ id: 'w', x: 132 - eps, y: 100 })]]), 100, 100);
      assertEquivalent(new Map(), new Map([['w', makeWeapon({ id: 'w', x: 132 + eps, y: 100 })]]), 100, 100);
      // Chest radius 192.
      assertEquivalent(new Map([['c', makeChest({ id: 'c', x: 292 - eps, y: 100 })]]), new Map(), 100, 100);
      assertEquivalent(new Map([['c', makeChest({ id: 'c', x: 292 + eps, y: 100 })]]), new Map(), 100, 100);
    }
  });

  it('ties resolve identically (first-scanned wins in both forms)', () => {
    // Two chests equidistant on opposite sides: d2 identical (exact tie) —
    // strict `<` keeps the FIRST scanned in both the sqrt and squared forms.
    assertEquivalent(
      new Map([
        ['left', makeChest({ id: 'left', x: 80, y: 100 })],
        ['right', makeChest({ id: 'right', x: 120, y: 100 })],
      ]),
      new Map(),
      100,
      100,
    );
    // Same-position weapons.
    assertEquivalent(
      new Map(),
      new Map([
        ['w1', makeWeapon({ id: 'w1', x: 110, y: 100, weaponType: WeaponType.DAGGER })],
        ['w2', makeWeapon({ id: 'w2', x: 110, y: 100, weaponType: WeaponType.SPEAR, tier: 3 })],
      ]),
      100,
      100,
    );
    // Weapon and chest at the exact same distance: the chest-strictly-closer
    // branch is false in both forms (`<` on equal values), so the weapon wins.
    assertEquivalent(
      new Map([['c', makeChest({ id: 'c', x: 110, y: 100 })]]),
      new Map([['w', makeWeapon({ id: 'w', x: 110, y: 100 })]]),
      100,
      100,
    );
  });

  it('chest-vs-weapon precedence agrees for both strict orderings', () => {
    // Chest strictly nearer than the weapon → chest branch.
    assertEquivalent(
      new Map([['c', makeChest({ id: 'c', x: 108, y: 100 })]]),
      new Map([['w', makeWeapon({ id: 'w', x: 116, y: 100 })]]),
      100,
      100,
    );
    // Weapon strictly nearer → weapon branch.
    assertEquivalent(
      new Map([['c', makeChest({ id: 'c', x: 116, y: 100 })]]),
      new Map([['w', makeWeapon({ id: 'w', x: 108, y: 100 })]]),
      100,
      100,
    );
  });

  it('deterministic random sweep: identical selection + prompt vs the sqrt reference', () => {
    const rand = lcg(0x5eed41);
    const TYPES = [WeaponType.DAGGER, WeaponType.SHORT_SWORD, WeaponType.HAMMER, WeaponType.SPEAR];
    // Mixed coordinate distributions: integer grid, 3-decimal continuous
    // (d2 gaps ≥ ~0.06 — far above the ~1e-13 sqrt-rounding collapse window),
    // and near-boundary offsets.
    const coord = (center: number, scale: number): number => {
      const r = rand();
      const v = center + (r * 2 - 1) * scale;
      return rand() < 0.5 ? Math.round(v) : Math.round(v * 1000) / 1000;
    };

    for (let iter = 0; iter < 500; iter++) {
      const lx = coord(1000, 500);
      const ly = coord(1000, 500);
      const weaponPickups = new Map<string, WeaponPickupState>();
      for (let i = 0; i < 5; i++) {
        weaponPickups.set(`w${i}`, {
          ...makeWeapon({
            id: `w${i}`,
            x: coord(lx, 40), // mix of in-range (<32) and out-of-range
            y: coord(ly, 40),
            weaponType: TYPES[Math.floor(rand() * TYPES.length)]!,
            tier: Math.floor(rand() * 4),
            lifetime: rand() < 0.15 ? 0 : 1, // some expired (skipped)
          }),
        });
      }
      const chests = new Map<string, ChestState>();
      for (let i = 0; i < 4; i++) {
        chests.set(`c${i}`, {
          ...makeChest({
            id: `c${i}`,
            x: coord(lx, 200), // mix of in-range (<192) and out-of-range
            y: coord(ly, 200),
            state: rand() < 0.2 ? 2 : rand() < 0.6 ? 1 : 0, // some open (skipped)
            openingProgress: Math.round(rand() * CHEST.OPEN_DURATION * 1000) / 1000,
          }),
        });
      }
      assertEquivalent(chests, weaponPickups, lx, ly);
    }
  });
});

describe('InteractionDetector — prompt cache (ticket #41)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('weapon prompt is rebuilt only when the key (weaponType+tier) changes', () => {
    // Fetch expected names BEFORE installing the spy so the assertions never
    // inflate the call count.
    const daggerName = weaponRegistry.getDefinition(WeaponType.DAGGER).name;
    const spearName = weaponRegistry.getDefinition(WeaponType.SPEAR).name;
    const spy = vi.spyOn(weaponRegistry, 'getDefinition');
    const pickups = new Map([['w1', makeWeapon({ id: 'w1', x: 110, y: 100, weaponType: WeaponType.DAGGER, tier: 0 })]]);
    const sync = makeStateSync(new Map(), pickups);
    const det = new InteractionDetector();

    det.detect(100, 100, sync);
    expect(det.interactionPrompt).toBe(`[E] Pick up ${daggerName}`);
    expect(spy).toHaveBeenCalledTimes(1); // built once

    // Repeated scans with an unchanged candidate → no rebuild.
    det.detect(100, 100, sync);
    det.detect(101.5, 100, sync);
    expect(det.interactionPrompt).toBe(`[E] Pick up ${daggerName}`);
    expect(spy).toHaveBeenCalledTimes(1);

    // Nearest candidate swaps to a DIFFERENT pickup of the same weaponType +
    // tier: the string determinants are unchanged, so the cache still holds.
    pickups.set('w2', makeWeapon({ id: 'w2', x: 95, y: 100, weaponType: WeaponType.DAGGER, tier: 0 }));
    det.detect(100, 100, sync);
    expect(det.nearestPickupId).toBe('w2');
    expect(det.interactionPrompt).toBe(`[E] Pick up ${daggerName}`);
    expect(spy).toHaveBeenCalledTimes(1);

    // Tier change → key change → exactly one rebuild with the tier name.
    const w2 = pickups.get('w2')!;
    w2.tier = 2;
    det.detect(100, 100, sync);
    expect(det.interactionPrompt).toBe(`[E] Pick up Rare ${daggerName}`);
    expect(spy).toHaveBeenCalledTimes(2);

    // Weapon type change → key change → rebuild.
    w2.weaponType = WeaponType.SPEAR;
    det.detect(100, 100, sync);
    expect(det.interactionPrompt).toBe(`[E] Pick up Rare ${spearName}`);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('chest opening prompt rebuilds only when the (filled, percent) bucket changes', () => {
    const repeatSpy = vi.spyOn(String.prototype, 'repeat');
    const chest = makeChest({ id: 'c1', x: 100, y: 100, state: 1, openingProgress: 0 });
    const sync = makeStateSync(new Map([['c1', chest]]));
    const det = new InteractionDetector();

    det.detect(100, 100, sync); // bucket (0, 0) → build ('▓'.repeat + '░'.repeat)
    expect(repeatSpy).toHaveBeenCalledTimes(2);
    expect(det.interactionPrompt).toBe('Opening ░░░░░ 0%');

    // Same bucket (ratio 0 → 0.002: filled 0, percent 0) → cached.
    chest.openingProgress = 0.001;
    det.detect(100, 100, sync);
    expect(repeatSpy).toHaveBeenCalledTimes(2);

    // Bucket change (ratio 0.2: filled 1, percent 20) → exactly one rebuild.
    chest.openingProgress = 0.1;
    det.detect(100, 100, sync);
    expect(repeatSpy).toHaveBeenCalledTimes(4);
    expect(det.interactionPrompt).toBe('Opening ▓░░░░ 20%');

    // Same bucket (ratio 0.202: filled 1, percent 20) → cached.
    chest.openingProgress = 0.101;
    det.detect(100, 100, sync);
    expect(repeatSpy).toHaveBeenCalledTimes(4);
    expect(det.interactionPrompt).toBe('Opening ▓░░░░ 20%');

    // Full bucket (ratio 1: filled 5, percent 100) → rebuild.
    chest.openingProgress = CHEST.OPEN_DURATION;
    det.detect(100, 100, sync);
    expect(repeatSpy).toHaveBeenCalledTimes(6);
    expect(det.interactionPrompt).toBe('Opening ▓▓▓▓▓ 100%');
  });

  it('chest closed prompt builds once and survives scans; state flip rebuilds', () => {
    const repeatSpy = vi.spyOn(String.prototype, 'repeat');
    const chest = makeChest({ id: 'c1', x: 100, y: 100, state: 0 });
    const sync = makeStateSync(new Map([['c1', chest]]));
    const det = new InteractionDetector();

    det.detect(100, 100, sync);
    expect(det.interactionPrompt).toBe('[E] Open chest');
    expect(repeatSpy).not.toHaveBeenCalled(); // no bar in the closed prompt

    det.detect(102, 100, sync);
    expect(det.interactionPrompt).toBe('[E] Open chest');
    expect(repeatSpy).not.toHaveBeenCalled();

    // Closed → opening: key change → one bar build.
    chest.state = 1;
    chest.openingProgress = 0.1;
    det.detect(100, 100, sync);
    expect(det.interactionPrompt).toBe('Opening ▓░░░░ 20%');
    expect(repeatSpy).toHaveBeenCalledTimes(2);
  });

  it('progress cadence matches a rebuild-every-scan reference (content + change points)', () => {
    const chest = makeChest({ id: 'c1', x: 100, y: 100, state: 1, openingProgress: 0 });
    const sync = makeStateSync(new Map([['c1', chest]]));
    const det = new InteractionDetector();

    /** Pre-#41 formatter — rebuilds the string from scratch every call. */
    const referencePrompt = (progress: number): string => {
      const ratio = Math.max(0, Math.min(1, progress / CHEST.OPEN_DURATION));
      const filled = Math.round(ratio * 5);
      const bar = '▓'.repeat(filled) + '░'.repeat(5 - filled);
      return `Opening ${bar} ${Math.round(ratio * 100)}%`;
    };

    let prevRef: string | null = null;
    let prevDet: string | null = null;
    let refChanges = 0;
    let detChanges = 0;
    for (let i = 0; i <= 500; i++) {
      chest.openingProgress = i / 1000; // 0 → OPEN_DURATION(0.5) in 1ms steps
      det.detect(100, 100, sync);
      const ref = referencePrompt(chest.openingProgress);
      // Identical content at EVERY step, cached or not.
      expect(det.interactionPrompt).toBe(ref);
      if (prevRef !== null) {
        if (ref !== prevRef) refChanges++;
        if (det.interactionPrompt !== prevDet) detChanges++;
      }
      prevRef = ref;
      prevDet = det.interactionPrompt;
    }
    // The cached detector changes value at exactly the same steps as the
    // rebuild-every-scan reference → same visual refresh cadence.
    expect(detChanges).toBe(refChanges);
    // Sanity: the sweep genuinely crossed many buckets (percent 0→100).
    expect(refChanges).toBeGreaterThan(10);
  });
});
