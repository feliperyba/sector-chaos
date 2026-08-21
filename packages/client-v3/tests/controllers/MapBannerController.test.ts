import { describe, expect, it, vi } from 'vitest';

// MapBannerController → Label → UIComponent extends Phaser.GameObjects.Container,
// so a minimal Container base class replaces the real Phaser bundle (jsdom has
// no canvas; the real bundle trips its Device.init probe at module scope).
vi.mock('phaser', () => {
  class Container {
    scene: unknown;
    x: number;
    y: number;
    alpha = 1;
    visible = true;
    readonly children: unknown[] = [];
    constructor(scene: unknown, x: number, y: number) {
      this.scene = scene;
      this.x = x;
      this.y = y;
      (scene as { add: { existing: (c: unknown) => void } }).add.existing(this);
    }
    add(child: unknown): this {
      this.children.push(child);
      return this;
    }
    getAt(index: number): unknown {
      return this.children[index];
    }
    setDepth(): this {
      return this;
    }
    setScrollFactor(): this {
      return this;
    }
    setAlpha(alpha: number): this {
      this.alpha = alpha;
      return this;
    }
    setVisible(visible: boolean): this {
      this.visible = visible;
      return this;
    }
    removeAll(): this {
      this.children.length = 0;
      return this;
    }
    removeAllListeners(): this {
      return this;
    }
    destroy(): void {
      /* stub */
    }
  }
  return { default: { GameObjects: { Container } } };
});

import type Phaser from 'phaser';
import { MapBannerController, poiNameAt } from '../../src/controllers/MapBannerController.js';
import type { GameState } from '../../src/controllers/GameState.js';

/**
 * Map-redesign ticket 03 REPAIR (judge finding F1 on d3ed814).
 *
 * The designation-at-match-start race: the buffered MATCH_START `to:1` is
 * drained inside connectWithRoom BEFORE requestMapData, so the countdown
 * event ALWAYS beats the one-shot mapData message. The intended design is
 * `showDesignation(null)` → arm `designationPending` (label stays hidden)
 * → mapData lands → `notifyMapData(designation)` flushes and shows the
 * line. This suite pins that pending/flush handshake (it previously had
 * zero coverage, which is how the dead-code guard slipped through), plus
 * the pure poiNameAt sector lookup.
 */

interface TextStub {
  text: string;
  setOrigin: ReturnType<typeof vi.fn>;
  setText: (text: string) => void;
  setColor: ReturnType<typeof vi.fn>;
}

interface TweenStub {
  config: {
    targets?: unknown;
    alpha?: number;
    delay?: number;
    duration?: number;
    ease?: string;
  };
  remove: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}

interface LabelInstance {
  alpha: number;
  visible: boolean;
}

interface SceneStub {
  scale: { width: number; height: number };
  tweens: { add: (config: TweenStub['config']) => TweenStub };
  add: {
    existing: ReturnType<typeof vi.fn>;
    text: ReturnType<() => TextStub>;
  };
}

function createTextStub(): TextStub {
  return {
    text: '',
    setOrigin: vi.fn(),
    setColor: vi.fn(),
    setText(text: string): void {
      this.text = text;
    },
  };
}

function createFixture(): {
  controller: MapBannerController;
  designationLabel: LabelInstance;
  designationText: TextStub;
  bannerLabel: LabelInstance;
  bannerText: TextStub;
  tweens: TweenStub[];
} {
  const tweens: TweenStub[] = [];
  const scene: SceneStub = {
    scale: { width: 1280, height: 720 },
    tweens: {
      add: (config) => {
        const tween: TweenStub = { config, remove: vi.fn(), stop: vi.fn() };
        tweens.push(tween);
        return tween;
      },
    },
    add: {
      existing: vi.fn(),
      text: vi.fn(() => createTextStub()),
    },
  };
  const state = { mapWorldW: 0, poiNames: null, lastLocalDamageAt: 0 };
  const controller = new MapBannerController(scene as unknown as Phaser.Scene, state as GameState);
  // Label creation order inside the controller: banner first, designation
  // second. Each Label registers itself on `add.existing` twice (the mock
  // Container base registers + UIComponent's own call), so dedupe by
  // instance to recover [bannerLabel, designationLabel] in order.
  const labelInstances = [
    ...new Set(scene.add.existing.mock.calls.map((call) => call[0] as LabelInstance)),
  ];
  const bannerLabel = labelInstances[0];
  const designationLabel = labelInstances[1];
  const bannerText = scene.add.text.mock.results[0].value as TextStub;
  const designationText = scene.add.text.mock.results[1].value as TextStub;
  return { controller, designationLabel, designationText, bannerLabel, bannerText, tweens };
}

describe('MapBannerController — designation pending/flush (ticket 03 race repair)', () => {
  it('THE RACE: showDesignation(null) hides, then notifyMapData flushes and shows', () => {
    const f = createFixture();

    // Countdown beat mapData: value still null — arm pending, show nothing.
    f.controller.showDesignation(null);
    expect(f.tweens).toHaveLength(0);
    expect(f.designationText.text).toBe('');
    expect(f.designationLabel.visible).toBe(false);
    expect(f.designationLabel.alpha).toBe(0);

    // mapData landed: the GameSceneSetup onMapData flush fires notifyMapData.
    f.controller.notifyMapData('RIDGELINE • RINGHOLD • 9IX');
    expect(f.designationText.text).toBe('RIDGELINE • RINGHOLD • 9IX');
    expect(f.designationLabel.visible).toBe(true);
    expect(f.designationLabel.alpha).toBe(1);
    expect(f.tweens).toHaveLength(1);
    // DESIGNATION_HOLD_MS=4500 (through the ~5s countdown) + FADE_MS=900.
    expect(f.tweens[0].config).toMatchObject({ delay: 4500, duration: 900, alpha: 0 });
    expect(f.tweens[0].config.targets).toBe(f.designationLabel);

    // The flush consumed the pending flag: a replayed notify is a no-op.
    f.controller.notifyMapData('OTHER • MAP • 1');
    expect(f.tweens).toHaveLength(1);
    expect(f.designationText.text).toBe('RIDGELINE • RINGHOLD • 9IX');
  });

  it('non-race flow: showDesignation with text shows immediately (no pending armed)', () => {
    const f = createFixture();

    f.controller.showDesignation('RINGROAD • SPIRE • 3F');
    expect(f.designationText.text).toBe('RINGROAD • SPIRE • 3F');
    expect(f.designationLabel.visible).toBe(true);
    expect(f.tweens).toHaveLength(1);

    // Pending was never armed, so the later mapData flush must not re-show.
    f.controller.notifyMapData('RINGROAD • SPIRE • 3F');
    expect(f.tweens).toHaveLength(1);
    expect(f.designationText.text).toBe('RINGROAD • SPIRE • 3F');
  });

  it('notifyMapData without a prior match-start is a no-op', () => {
    const f = createFixture();

    f.controller.notifyMapData('X • Y • Z');
    expect(f.tweens).toHaveLength(0);
    expect(f.designationText.text).toBe('');
    expect(f.designationLabel.visible).toBe(false);
  });

  it('pending + notifyMapData(null) (demo map, no designation) stays hidden but keeps pending', () => {
    const f = createFixture();

    f.controller.showDesignation(null);
    f.controller.notifyMapData(null);
    expect(f.tweens).toHaveLength(0);
    expect(f.designationLabel.visible).toBe(false);

    // Pending was NOT consumed by the null flush — a later real flush works.
    f.controller.notifyMapData('LATE • MAP • 7');
    expect(f.designationText.text).toBe('LATE • MAP • 7');
    expect(f.tweens).toHaveLength(1);
  });

  it('destroy() silences both surfaces (no flush, no tween, no text)', () => {
    const f = createFixture();

    f.controller.showDesignation(null);
    f.controller.destroy();
    f.controller.notifyMapData('X • Y • Z');
    f.controller.showDesignation('A • B • C');
    expect(f.tweens).toHaveLength(0);
    expect(f.designationText.text).toBe('');
  });
});

describe('poiNameAt — pure sector-name lookup', () => {
  const NAMES = [
    ['A1', 'B1', 'C1', 'D1'],
    ['A2', 'B2', 'C2', 'D2'],
    ['A3', 'B3', '', 'D3'],
    ['A4', 'B4', 'C4', 'D4'],
  ];
  const WORLD = 4000; // 4x4 sectors of 1000px

  it('maps a world position to its sector display name', () => {
    // Center of sector (row 1, col 2): x=2500, y=1500.
    expect(poiNameAt(NAMES, WORLD, 2500, 1500)).toBe('C2');
    expect(poiNameAt(NAMES, WORLD, 999, 999)).toBe('A1');
    expect(poiNameAt(NAMES, WORLD, 0, 0)).toBe('A1');
  });

  it('returns undefined off-map and for absent naming data', () => {
    expect(poiNameAt(null, WORLD, 2000, 2000)).toBeUndefined();
    expect(poiNameAt(NAMES, 0, 2000, 2000)).toBeUndefined();
    expect(poiNameAt(NAMES, WORLD, -1, 2000)).toBeUndefined();
    expect(poiNameAt(NAMES, WORLD, 4000, 2000)).toBeUndefined();
    expect(poiNameAt(NAMES, WORLD, 2000, -1)).toBeUndefined();
    expect(poiNameAt(NAMES, WORLD, 2000, 4000)).toBeUndefined();
  });

  it('returns undefined for an empty-string cell (unnamed sector)', () => {
    // Sector (row 2, col 2) has an empty name.
    expect(poiNameAt(NAMES, WORLD, 2500, 2500)).toBeUndefined();
  });
});
