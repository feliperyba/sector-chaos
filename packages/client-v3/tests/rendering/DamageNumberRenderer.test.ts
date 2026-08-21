import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DamageNumberRenderer } from '../../src/rendering/DamageNumberRenderer.js';
import { DesignTokens } from '../../src/ui/DesignTokens.js';

/**
 * Ticket #47 — gpu-damage-number-pool.
 *
 * The old renderer's "pool" was a count cap: every spawn called
 * `scene.add.text` (one fresh canvas texture registration per number — each
 * Text mints a UUID-keyed entry in the texture manager, Phaser 4
 * Text.js:272-275) and expiry destroyed the object. The true pool creates at
 * most POOL_SIZE (32) Text objects lazily, then reuses them forever via
 * setText/setColor (in-place canvas re-render) with a full state reset.
 *
 * `scene.add.text` call count is the texture-manager-growth proxy: old code
 * minted one texture per spawn (40 per 40-burst, forever); the pool mints at
 * most 32 total. Text stubs carry real mutable state so the classic pool bug
 * — stale state leaking across a recycled slot — is observable directly.
 */

interface TextStub {
  type: 'Text';
  text: string;
  x: number;
  y: number;
  alpha: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
  angle: number;
  depth: number;
  originX: number;
  originY: number;
  visible: boolean;
  active: boolean;
  tint: number;
  style: { color: string; fontFamily: string; fontSize: string; fontStyle: string; stroke: string; strokeThickness: number };
  setText: ReturnType<typeof vi.fn>;
  setColor: ReturnType<typeof vi.fn>;
  setPosition: ReturnType<typeof vi.fn>;
  setOrigin: ReturnType<typeof vi.fn>;
  setDepth: ReturnType<typeof vi.fn>;
  setScale: ReturnType<typeof vi.fn>;
  setAlpha: ReturnType<typeof vi.fn>;
  setRotation: ReturnType<typeof vi.fn>;
  setTint: ReturnType<typeof vi.fn>;
  setActive: ReturnType<typeof vi.fn>;
  setVisible: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
}

interface TweenConfig {
  targets: TextStub;
  scale: number;
  duration: number;
  ease: string;
}

type Scene = ConstructorParameters<typeof DamageNumberRenderer>[0];

function createTextStub(): TextStub {
  // Fresh Phaser Text defaults for every property this renderer touches.
  const stub = {
    type: 'Text',
    text: '',
    x: 0,
    y: 0,
    alpha: 1,
    scaleX: 1,
    scaleY: 1,
    rotation: 0,
    angle: 0,
    depth: 0,
    originX: 0,
    originY: 0,
    visible: true,
    active: true,
    tint: 0xffffff,
    style: {
      color: '#ffffff',
      fontFamily: DesignTokens.font.family,
      fontSize: `${DesignTokens.font.size.lg}px`,
      fontStyle: 'bold',
      stroke: '#000000',
      strokeThickness: 3,
    },
    setText: vi.fn(),
    setColor: vi.fn(),
    setPosition: vi.fn(),
    setOrigin: vi.fn(),
    setDepth: vi.fn(),
    setScale: vi.fn(),
    setAlpha: vi.fn(),
    setRotation: vi.fn(),
    setTint: vi.fn(),
    setActive: vi.fn(),
    setVisible: vi.fn(),
    destroy: vi.fn(),
  } as unknown as TextStub;
  // Setters mutate the stub state (mirror the Phaser component behavior the
  // renderer relies on) and stay chainable.
  stub.setText.mockImplementation((v: string) => {
    stub.text = Array.isArray(v) ? v.join('\n') : String(v);
    return stub;
  });
  stub.setColor.mockImplementation((c: string) => {
    stub.style.color = c;
    return stub;
  });
  stub.setPosition.mockImplementation((x: number, y: number) => {
    stub.x = x;
    stub.y = y;
    return stub;
  });
  stub.setOrigin.mockImplementation((x: number, y = x) => {
    stub.originX = x;
    stub.originY = y;
    return stub;
  });
  stub.setDepth.mockImplementation((d: number) => {
    stub.depth = d;
    return stub;
  });
  stub.setScale.mockImplementation((s: number) => {
    stub.scaleX = s;
    stub.scaleY = s;
    return stub;
  });
  stub.setAlpha.mockImplementation((a: number) => {
    stub.alpha = a;
    return stub;
  });
  stub.setRotation.mockImplementation((r: number) => {
    stub.rotation = r;
    return stub;
  });
  stub.setTint.mockImplementation((t: number) => {
    stub.tint = t;
    return stub;
  });
  stub.setActive.mockImplementation((a: boolean) => {
    stub.active = a;
    return stub;
  });
  stub.setVisible.mockImplementation((v: boolean) => {
    stub.visible = v;
    return stub;
  });
  return stub;
}

function createMockScene() {
  const created: Array<{ x: number; y: number; text: string; style: Record<string, unknown> }> = [];
  const texts: TextStub[] = [];
  const tweens: TweenConfig[] = [];
  const killedTweensOf: TextStub[] = [];
  const scene = {
    add: {
      text: (x: number, y: number, text: string, style: Record<string, unknown>) => {
        created.push({ x, y, text, style });
        const stub = createTextStub();
        stub.text = text;
        stub.x = x;
        stub.y = y;
        texts.push(stub);
        return stub;
      },
    },
    tweens: {
      add: (config: TweenConfig) => {
        tweens.push(config);
        return config;
      },
      killTweensOf: (target: TextStub) => {
        killedTweensOf.push(target);
      },
    },
  };
  return { scene: scene as unknown as Scene, created, texts, tweens, killedTweensOf };
}

describe('DamageNumberRenderer — true Text object pool (ticket #47)', () => {
  let mockNow: number;

  beforeEach(() => {
    mockNow = 10_000;
    vi.spyOn(performance, 'now').mockImplementation(() => mockNow);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('mints at most POOL_SIZE Text objects under repeated combat bursts (no texture-manager growth)', () => {
    const mock = createMockScene();
    const r = new DamageNumberRenderer(mock.scene);

    // 3 bursts of 40 (> 32 cap) with full expiry between — the old code
    // minted 40 textures per burst (120 total, forever).
    for (let burst = 0; burst < 3; burst++) {
      for (let i = 0; i < 40; i++) r.spawn(100 + i * 5, 200, 10 + i, i % 3 === 0);
      mockNow += 1300; // > LIFETIME (1200ms)
      r.update(16);
    }
    // Another late burst — everything is free, zero new creations.
    for (let i = 0; i < 40; i++) r.spawn(300 + i * 5, 400, 20 + i);
    mockNow += 1300;
    r.update(16);

    expect(mock.created.length).toBe(32); // lazy-to-cap, then never again
    expect(mock.texts.every((t) => t.destroy.mock.calls.length === 0)).toBe(true); // no destroys either
  });

  it('reuses a released slot via setText + identical creation style config', () => {
    const mock = createMockScene();
    const r = new DamageNumberRenderer(mock.scene);

    r.spawn(10, 20, 7, false, 0xff5555);
    mockNow += 1300;
    r.update(16); // expires → back to free list

    const creationsBefore = mock.created.length;
    r.spawn(30, 40, 9, true); // heal: '+9' in green

    expect(mock.created.length).toBe(creationsBefore); // reused, not created
    const reused = mock.texts[0]!;
    expect(reused.setText).toHaveBeenCalledWith('+9');
    expect(reused.setColor).toHaveBeenCalledWith('#' + DesignTokens.colors.green.toString(16).padStart(6, '0'));
    // The lazily-created object carries the exact style the old add.text used.
    expect(mock.created[0]).toEqual({
      x: 0,
      y: 0,
      text: '',
      style: {
        fontSize: `${DesignTokens.font.size.lg}px`,
        color: '#ffffff',
        fontFamily: DesignTokens.font.family,
        fontStyle: 'bold',
        stroke: '#000000',
        strokeThickness: 3,
      },
    });
  });

  it('overflow recycles the OLDEST slot — same moment the old cap destroyed it', () => {
    const mock = createMockScene();
    const r = new DamageNumberRenderer(mock.scene);

    vi.spyOn(Math, 'random').mockReturnValue(0.5); // jitter = 0 → deterministic positions
    for (let i = 0; i < 32; i++) r.spawn(1000 + i * 10, 500, 100 + i);
    expect(mock.created.length).toBe(32);
    const oldest = mock.texts[0]!;
    const second = mock.texts[1]!;

    r.spawn(2000, 600, 55); // 33rd live number → overflow

    expect(mock.created.length).toBe(32); // no growth at the cap
    expect(mock.killedTweensOf).toContain(oldest); // its pop tween is dead
    expect(oldest.setText).toHaveBeenLastCalledWith('-55'); // slot carries the new number
    expect(oldest.setPosition).toHaveBeenCalledWith(2000, 570);
    // Only the oldest was recycled — everyone else keeps their number.
    expect(second.setText).toHaveBeenCalledTimes(1); // its original '-101'
    expect(second.text).toBe('-101');
  });

  it('resets EVERY mutable property on acquire (dirty-slot leak guard)', () => {
    const mock = createMockScene();
    const r = new DamageNumberRenderer(mock.scene);

    vi.spyOn(Math, 'random').mockReturnValue(0.5); // jitter = 0 → deterministic positions
    r.spawn(100, 200, 12, false, 0x66ccff);
    const slot = mock.texts[0]!;

    // Simulate a full life: pop tween partway, mid-fade alpha, risen y.
    slot.setScale(0.9);
    slot.y = 123.4;
    slot.setAlpha(0.35);
    slot.setRotation(0.3);
    slot.setTint(0xff00ff);
    mockNow += 1300;
    r.update(16); // expiry → release (hidden) → free list
    expect(slot.visible).toBe(false);
    expect(slot.active).toBe(false);

    r.spawn(400, 500, 3, true); // reuse the same slot

    expect(mock.created.length).toBe(1); // same object
    expect(slot.text).toBe('+3');
    expect(slot.x).toBe(400);
    expect(slot.y).toBe(470); // y - 30
    expect(slot.alpha).toBe(1);
    expect(slot.scaleX).toBe(1.4); // POP_START_SCALE
    expect(slot.scaleY).toBe(1.4);
    expect(slot.rotation).toBe(0);
    expect(slot.tint).toBe(0xffffff);
    expect(slot.originX).toBe(0.5);
    expect(slot.originY).toBe(0.5);
    expect(slot.depth).toBe(DesignTokens.depth.floating);
    expect(slot.visible).toBe(true);
    expect(slot.active).toBe(true);
    // Fresh pop tween re-added with the exact original config.
    const tween = mock.tweens[mock.tweens.length - 1]!;
    expect(tween.targets).toBe(slot);
    expect(tween.scale).toBe(1);
    expect(tween.duration).toBe(150);
    expect(tween.ease).toBe(DesignTokens.easing.expoOut);
  });

  it('kills a still-live pop tween when overflow recycles a young slot (stale-tween guard)', () => {
    const mock = createMockScene();
    const r = new DamageNumberRenderer(mock.scene);

    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    // 32 spawns in the same instant: the oldest is younger than the 150ms pop
    // tween, exactly the burst case where the old code destroyed mid-tween.
    for (let i = 0; i < 32; i++) r.spawn(50 + i * 4, 60, 5 + (i % 7));
    const oldest = mock.texts[0]!;
    const killsBefore = mock.killedTweensOf.length;

    r.spawn(999, 60, 8);

    expect(mock.killedTweensOf.length).toBe(killsBefore + 1);
    expect(mock.killedTweensOf[mock.killedTweensOf.length - 1]).toBe(oldest);
    // And the recycled slot restarts from the pop scale, not the tween's
    // mid-flight value.
    expect(oldest.scaleX).toBe(1.4);
  });

  it('expiry releases the slot back to the pool hidden, and the pool recovers', () => {
    const mock = createMockScene();
    const r = new DamageNumberRenderer(mock.scene);

    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    for (let i = 0; i < 10; i++) r.spawn(10 * i, 20 * i, 30 + i);
    mockNow += 1300;
    r.update(16);

    expect(mock.texts.slice(0, 10).every((t) => t.visible === false && t.active === false)).toBe(true);
    expect(mock.created.length).toBe(10);

    // 10 fresh numbers without any creation.
    for (let i = 0; i < 10; i++) r.spawn(11 * i, 21 * i, 40 + i);
    expect(mock.created.length).toBe(10);
  });

  it('update motion math is unchanged: rise by vy*dt and the same fade curve', () => {
    const mock = createMockScene();
    const r = new DamageNumberRenderer(mock.scene);

    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    r.spawn(100, 200, 50);
    const t = mock.texts[0]!;
    const bornY = t.y;

    mockNow += 100; // age 100ms → progress < 0.4 → alpha stays 1
    r.update(100); // dt = 0.1s → y += RISE_SPEED(−50) * 0.1 = −5
    expect(t.y).toBeCloseTo(bornY - 5, 10);
    expect(t.alpha).toBe(1);

    mockNow += 500; // age 600ms → progress 0.5 → alpha = 1 − ((0.5−0.4)/0.6)²
    r.update(100);
    const expectedAlpha = 1 - Math.pow((0.5 - 0.4) / 0.6, 2);
    expect(t.alpha).toBeCloseTo(expectedAlpha, 10);
    expect(t.y).toBeCloseTo(bornY - 10, 10);
  });

  it('spawnLabel drives the same pooled path (BLOCK labels share slots with numbers)', () => {
    const mock = createMockScene();
    const r = new DamageNumberRenderer(mock.scene);

    r.spawnLabel(70, 80, 'BLOCK', 0x66ccff);
    const t = mock.texts[0]!;
    expect(t.text).toBe('BLOCK');
    expect(t.style.color).toBe('#66ccff');
    expect(t.setText).toHaveBeenCalledWith('BLOCK');

    mockNow += 1300;
    r.update(16);
    r.spawn(1, 2, 3);
    expect(mock.created.length).toBe(1);
    expect(t.text).toBe('-3');
  });

  it('released slots are invisible to the albedo capture: alpha 0 + visible false (ghost guard)', () => {
    const mock = createMockScene();
    const r = new DamageNumberRenderer(mock.scene);

    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    r.spawn(100, 200, 42, false, 0xff3333);
    const slot = mock.texts[0]!;
    expect(slot.depth).toBe(DesignTokens.depth.floating); // 300 < 500 cutoff

    // Grow the fade past its curve: the last alpha update() sets before expiry
    // is nonzero (the curve reaches 0 only at exactly age 1200, which update()
    // already treats as expired) — this is the residual the ghost was made of.
    mockNow += 1100; // age 1100 → progress ~0.917 → alpha ≈ 0.0078
    r.update(16);
    expect(slot.alpha).toBeGreaterThan(0);

    mockNow += 150; // age 1250 > LIFETIME → expiry → release
    r.update(16);

    // visible/active off (the pre-fix state) AND alpha 0 (the fix). The
    // albedo capture path includes hidden depth-300 children regardless of
    // visible — alpha is the only property that makes them contribute
    // nothing once drawn (SubmitterQuad bakes _alpha into the vertex tint).
    expect(slot.visible).toBe(false);
    expect(slot.active).toBe(false);
    expect(slot.alpha).toBe(0);

    // Property-level albedo simulation: mirror buildWorldCaptureList's filter
    // (depth < worldDepthCutoff=DesignTokens.depth.hudBg, NO visible check —
    // the judge-cited defect) over the scene's texts, then assert every
    // captured RELEASED slot is fully transparent.
    const captureList = mock.texts.filter((c) => c.depth < DesignTokens.depth.hudBg);
    expect(captureList).toContain(slot); // it IS captured despite visible=false
    for (const c of captureList) {
      if (!c.active) {
        expect(c.alpha).toBe(0); // released → drawn but contributes nothing
      }
    }

    // Re-acquire fully undoes the ghost guard.
    r.spawn(300, 400, 7);
    expect(slot.alpha).toBe(1);
    expect(slot.visible).toBe(true);
  });
});
