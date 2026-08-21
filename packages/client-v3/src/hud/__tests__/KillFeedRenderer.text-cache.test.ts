/**
 * Regression test for perf ticket 48 — kill-feed row text cache.
 *
 * WHY THE MOCK SEAM (not a real Phaser scene):
 * `KillFeedRenderer`'s constructor builds real Phaser objects via
 * `scene.add.nineslice` + `new Label` (which calls `scene.add.text`), and
 * Phaser has no lightweight headless mode in vitest (documented in
 * SpectatorHUDCleanup.test / WeaponHideEventHandler.test). We mock only the
 * `Label` component — replacing it with a spy class whose `setText` /
 * `setAlpha` calls we count — and stub the scene's `nineslice`/`tweens`.
 * `weaponRegistry` is imported REAL so the formatted strings asserted here are
 * produced by the same source of truth as production.
 *
 * WHAT THIS PROVES:
 *  1. `formatKillEntry` output is computed once per entry (cached at addKill)
 *     — across N `update()` frames with an unchanged entry, `setText` fires
 *     exactly once per row. Before ticket 48 it fired every frame, forcing a
 *     Phaser canvas re-render + texture upload for zero visual change.
 *  2. `setText` fires again exactly when a row's assigned ENTRY changes
 *     (feed shift on a new kill) — the scroll behavior is preserved.
 *  3. The cached strings are byte-identical to the old per-frame output for
 *     the same entries (format function untouched) — visual identity.
 *  4. The per-frame fade (`setAlpha`) is NOT cached — alpha still updates
 *     every frame, including the expired → `setAlpha(0)` path.
 *
 * WHAT THIS DOES NOT PROVE (browser verification):
 *  - Rows visually appear/fade/scroll identically in a real Phaser scene
 *    (covered by tsc + the identical-string guarantees above + manual check).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { weaponRegistry, WeaponType } from '@sector-battle/shared';
import type { KillFeedEntry } from '../../types.js';

// --- Label spy (module-level holder — the vi.mock factory is hoisted, so the
// closure must read the binding at construction time, not factory time). -----
interface LabelSpy {
  setText: ReturnType<typeof vi.fn>;
  setAlpha: ReturnType<typeof vi.fn>;
  setDepth: ReturnType<typeof vi.fn>;
  setScrollFactor: ReturnType<typeof vi.fn>;
  getAt: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
}

let labelInstances: LabelSpy[];

vi.mock('../../ui/components/Label.js', () => ({
  Label: class {
    setText = vi.fn((_text: string) => undefined);
    setAlpha = vi.fn().mockReturnThis();
    setDepth = vi.fn().mockReturnThis();
    setScrollFactor = vi.fn().mockReturnThis();
    setOrigin = vi.fn().mockReturnThis();
    getAt = vi.fn(() => ({ setOrigin: vi.fn().mockReturnThis() }));
    destroy = vi.fn();

    constructor() {
      labelInstances.push(this as unknown as LabelSpy);
    }
  },
}));

// KillFeedRenderer imports Phaser for TYPES only; keep the heavy real module
// (and any browser-global probing) out of this unit test.
vi.mock('phaser', () => ({ default: {} }));

import { KillFeedRenderer } from '../KillFeedRenderer.js';

// --- Minimal scene stub -----------------------------------------------------
function makeSceneStub(): Phaser.Scene {
  const panel = {
    setDepth: vi.fn().mockReturnThis(),
    setScrollFactor: vi.fn().mockReturnThis(),
    setOrigin: vi.fn().mockReturnThis(),
    setTint: vi.fn().mockReturnThis(),
    setAlpha: vi.fn().mockReturnThis(),
    destroy: vi.fn(),
  };
  return {
    scale: { width: 1280, height: 720 },
    tweens: { add: vi.fn(() => ({})) },
    add: { nineslice: vi.fn(() => panel) },
  } as unknown as Phaser.Scene;
}

// --- Fixtures ---------------------------------------------------------------
function makeKill(overrides: Partial<KillFeedEntry> = {}): KillFeedEntry {
  return {
    killerName: 'Killer',
    victimName: 'Victim',
    weaponType: WeaponType.HAMMER,
    timestamp: 1000,
    cause: '',
    attackType: 'ARC',
    killerId: 'killer-1',
    ...overrides,
  };
}

const HAMMER_NAME = weaponRegistry.getDefinition(WeaponType.HAMMER).name;

describe('ticket 48 — KillFeedRenderer row-text cache', () => {
  beforeEach(() => {
    labelInstances = [];
  });

  it('setText fires exactly once per row while the entry is unchanged across frames', () => {
    const renderer = new KillFeedRenderer(makeSceneStub());
    renderer.addKill(makeKill());

    // 10 frames, entry unchanged (timestamp fixed, now advancing inside the
    // 5000ms fade window so the row stays visible).
    for (let f = 1; f <= 10; f++) renderer.update(1000 + f * 100);

    const row0 = labelInstances[0]!;
    expect(row0.setText).toHaveBeenCalledTimes(1);
    expect(row0.setText).toHaveBeenCalledWith(
      `Killer eliminated Victim with ${HAMMER_NAME}`,
    );
  });

  it('the per-frame fade is untouched — setAlpha still fires every frame', () => {
    const renderer = new KillFeedRenderer(makeSceneStub());
    renderer.addKill(makeKill());
    // Ignore the constructor's initial setAlpha(0) on every row.
    for (const label of labelInstances) label.setAlpha.mockClear();

    for (let f = 1; f <= 10; f++) renderer.update(1000 + f * 100);

    const row0 = labelInstances[0]!;
    expect(row0.setAlpha).toHaveBeenCalledTimes(10);
    // Alpha follows the 5000ms fade curve: last frame now=2000 → 1 - 1000/5000 = 0.8.
    expect(row0.setAlpha).toHaveBeenLastCalledWith(0.8);
  });

  it('a new kill reassigns rows — setText fires again only for changed rows', () => {
    const renderer = new KillFeedRenderer(makeSceneStub());
    renderer.addKill(makeKill({ victimName: 'First' }));
    renderer.update(1100);

    const row0 = labelInstances[0]!;
    const row1 = labelInstances[1]!;
    expect(row0.setText).toHaveBeenCalledTimes(1);
    expect(row1.setText).not.toHaveBeenCalled();

    renderer.addKill(makeKill({ victimName: 'Second', killerId: 'killer-2' }));
    // Second kill: row0 shifts to the new entry, row1 picks up the old one.
    renderer.update(1200);

    expect(row0.setText).toHaveBeenCalledTimes(2);
    expect(row0.setText).toHaveBeenLastCalledWith(
      `Killer eliminated Second with ${HAMMER_NAME}`,
    );
    expect(row1.setText).toHaveBeenCalledTimes(1);
    expect(row1.setText).toHaveBeenCalledWith(
      `Killer eliminated First with ${HAMMER_NAME}`,
    );
  });

  it('cached strings are byte-identical to the old per-frame output (visual identity)', () => {
    const renderer = new KillFeedRenderer(makeSceneStub());
    // Branch coverage of formatKillEntry: weapon kill + each special cause.
    renderer.addKill(makeKill());
    renderer.addKill(makeKill({ cause: 'zone', killerId: undefined }));
    renderer.addKill(makeKill({ cause: 'trap_damage', killerId: undefined }));
    renderer.addKill(makeKill({ cause: 'siege_crush', killerId: undefined }));
    renderer.addKill(makeKill({ cause: 'disconnect', killerId: undefined }));
    renderer.update(1100);

    // Rows are newest-first; compare against the exact strings the previous
    // per-frame formatKillEntry produced for the same entries.
    expect(labelInstances[0]!.setText).toHaveBeenCalledWith(
      `Victim disconnected`,
    );
    expect(labelInstances[1]!.setText).toHaveBeenCalledWith(
      `Victim was crushed by the siege`,
    );
    expect(labelInstances[2]!.setText).toHaveBeenCalledWith(
      `Victim was eliminated by a trap`,
    );
    expect(labelInstances[3]!.setText).toHaveBeenCalledWith(
      `Victim was eliminated by the zone`,
    );
    expect(labelInstances[4]!.setText).toHaveBeenCalledWith(
      `Killer eliminated Victim with ${HAMMER_NAME}`,
    );
  });

  it('overflow past 5 entries keeps every row correct (feed scroll + drop)', () => {
    const renderer = new KillFeedRenderer(makeSceneStub());
    for (let i = 1; i <= 6; i++) {
      renderer.addKill(makeKill({ victimName: `V${i}`, killerId: `k${i}` }));
      renderer.update(1000 + i);
    }

    // 6th (oldest) entry is dropped; rows 0-4 show V6..V2 newest-first.
    const expected = ['V6', 'V5', 'V4', 'V3', 'V2'];
    for (let row = 0; row < 5; row++) {
      expect(labelInstances[row]!.setText).toHaveBeenLastCalledWith(
        `Killer eliminated ${expected[row]} with ${HAMMER_NAME}`,
      );
    }
  });

  it('expired entries fade out without any new setText calls', () => {
    const renderer = new KillFeedRenderer(makeSceneStub());
    renderer.addKill(makeKill());
    renderer.update(1100);

    const row0 = labelInstances[0]!;
    const callsAfterVisible = row0.setText.mock.calls.length;
    expect(callsAfterVisible).toBe(1);

    // Past the 5000ms window the row is invisible; its text must not be
    // re-set (the string did not change) but alpha must keep updating.
    renderer.update(1000 + 6000);
    expect(row0.setText.mock.calls.length).toBe(callsAfterVisible);
    expect(row0.setAlpha).toHaveBeenLastCalledWith(0);
  });
});
