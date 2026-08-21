import { describe, it, expect } from 'vitest';
import type { LightPlacementTiled, LightKind } from '@sector-battle/shared';
import {
  LightPropRenderer,
  ensureAnims,
  LIGHT_PROP_Y_OFFSETS,
  lightPropYOffset,
} from '../LightPropRenderer.js';
import { LIGHT_PROP_ANIMS, BIOME_GLOW_PULSE_FRAMES } from '../LightPropResolver.js';

/**
 * Regression guard for the LightPropRenderer wiring bug that crashed
 * `spawn` with `Cannot read properties of undefined (reading 'duration')`
 * inside Phaser's `AnimationState.startAnimation` → `getFirstTick`.
 *
 * Root cause: `ensureAnims` iterated `LIGHT_PROP_ANIMS` (insertion order
 * torch/[campfire=[]]/candle/[fireplace=[]]/brazier/lantern) and routed every
 * non-torch kind onto the candle anim key via a binary ternary. The empty-list
 * `campfire` entry therefore registered a candle anim with 0 frames; the real
 * 6-frame candle anim was then skipped (`exists` guard); and `spawn`'s own
 * `anims.exists(key)` guard passed on the broken registration — Phaser's
 * `load()` set `currentFrame = anim.frames[0]` (undefined), then `getFirstTick`
 * read `currentFrame.duration` → crash. The same bug also silently dropped the
 * ticket-08 brazier/lantern flicker art (registered onto the already-existing
 * candle key, never played).
 *
 * This test exercises the WIRING (ensureAnims → spawn) with a faithful
 * Phaser-like anims mock that records `create({key, frames})` and reproduces
 * the failure mode (playing a 0-frame registered anim). The pure-data
 * LightPropResolver.test.ts could not catch this — the bug lived between the
 * two functions, which had no test seam.
 */

// ── A faithful-enough Phaser anims registry mock ───────────────────────────
// Records `create()` calls so we can assert the registered anim table has no
// 0-frame entries and that each flame kind gets its own key. `play()` simulates
// Phaser's failure: if the resolved anim has 0 frames, it throws the SAME
// `undefined.duration` TypeError the real library does (phaser.js getFirstTick).
interface RecordedAnim {
  key: string;
  frames: ReadonlyArray<{ key: string; frame: string }>;
  frameRate: number;
  repeat: number;
}

function makeAnimsMock() {
  const anims = new Map<string, RecordedAnim>();
  return {
    _recorded: anims,
    create(config: {
      key: string;
      frames: ReadonlyArray<{ key: string; frame: string }>;
      frameRate: number;
      repeat: number;
    }): unknown {
      anims.set(config.key, config);
      return config;
    },
    exists(key: string): boolean {
      return anims.has(key);
    },
    get(key: string): RecordedAnim | undefined {
      return anims.get(key);
    },
  };
}

// Phaser's getFirstTick reads `state.currentFrame.duration`; load() sets
// currentFrame = anim.frames[0]. A 0-frame anim makes frames[0] undefined →
// the real crash. We reproduce it so the test fails the SAME way on the bug.
function playLikePhaser(animsMock: ReturnType<typeof makeAnimsMock>, key: string): void {
  const anim = animsMock.get(key);
  if (!anim) return; // missing key is a no-op warning in Phaser, not a throw
  // load(): currentFrame = anim.frames[startFrame ?? 0]
  const currentFrame = anim.frames[0]; // undefined when 0 frames — the bug
  // getFirstTick(): state.currentFrame.duration || msPerFrame
  // Reading `.duration` on undefined reproduces the production crash exactly.
  void (currentFrame as { duration?: number } | undefined)?.duration;
  if (currentFrame === undefined) {
    throw new TypeError("Cannot read properties of undefined (reading 'duration')");
  }
}

// ── A minimal scene mock with only the surface LightPropRenderer touches ───
function makeSceneMock() {
  const anims = makeAnimsMock();
  const sprites: Array<{
    x: number;
    y: number;
    texture: string;
    frame: string;
    animKeyPlayed: string | null;
    tint: number | null;
    destroyed: boolean;
  }> = [];
  return {
    anims,
    _sprites: sprites,
    add: {
      sprite(
        x: number,
        y: number,
        texture: string,
        frame: string,
      ): {
        x: number;
        y: number;
        texture: string;
        frame: string;
        animKeyPlayed: string | null;
        tint: number | null;
        destroyed: boolean;
        setOrigin(): unknown;
        setDepth(): unknown;
        setRotation(): unknown;
        setScale(): unknown;
        setTint(tint: number): unknown;
        play(config: { key: string }): unknown;
        destroy(): unknown;
      } {
        const sprite = {
          x,
          y,
          texture,
          frame,
          animKeyPlayed: null as string | null,
          tint: null as number | null,
          destroyed: false,
          setOrigin() {
            return sprite;
          },
          setDepth() {
            return sprite;
          },
          setRotation() {
            return sprite;
          },
          setScale() {
            return sprite;
          },
          setTint(tint: number) {
            // Record the tint (the per-placement `color` override path).
            sprite.tint = tint;
            return sprite;
          },
          play(config: { key: string }) {
            // Reproduce Phaser's crash path: a registered 0-frame anim throws
            // at getFirstTick. This is the line that crashed in production.
            playLikePhaser(anims, config.key);
            sprite.animKeyPlayed = config.key;
            return sprite;
          },
          destroy() {
            sprite.destroyed = true;
          },
        };
        sprites.push(sprite);
        return sprite;
      },
    },
    textures: {
      get(_: string): { has(frame: string): boolean } {
        // Pretend every referenced frame exists (atlas completeness is covered
        // by LightPropResolver.test.ts; this test is about the anim wiring).
        return { has: () => true };
      },
    },
  };
}

type SceneMock = ReturnType<typeof makeSceneMock>;

function placement(kind: LightPlacementTiled['kind'], gridX = 0, gridY = 0): LightPlacementTiled {
  return {
    gridX,
    gridY,
    kind,
    rotation: 0,
    flipH: false,
    flipV: false,
    isScatter: false,
  } as LightPlacementTiled;
}

describe('LightPropRenderer — anim wiring (ensureAnims → spawn)', () => {
  describe('ensureAnims registers each flame kind under its OWN key with non-empty frames', () => {
    it('never registers a 0-frame anim (the crash precondition)', () => {
      const scene = makeSceneMock() as unknown as Parameters<typeof ensureAnims>[0];
      ensureAnims(scene);
      const recorded = scene.anims as unknown as ReturnType<typeof makeAnimsMock>;
      for (const [key, anim] of recorded._recorded) {
        expect(anim.frames.length, `anim ${key} must have frames`).toBeGreaterThan(0);
      }
    });

    it('registers NO flame-kind anims (static fixtures) — only the biome-glow pulse', () => {
      // c83ecd8's pixel-art fixture redesign emptied every LIGHT_PROP_ANIMS
      // entry, so ensureAnims registers NOTHING for torch/candle/brazier/
      // lantern — the only registered key is the biome-glow pulse (a single
      // static frame looped). This keeps the "each kind under its own key"
      // guard from the flicker era satisfied vacuously: no flame key exists,
      // so none can alias onto another.
      const scene = makeSceneMock() as unknown as Parameters<typeof ensureAnims>[0];
      ensureAnims(scene);
      const recorded = scene.anims as unknown as ReturnType<typeof makeAnimsMock>;
      const keys = Array.from(recorded._recorded.keys());
      expect(keys).toEqual(['__lightProp_biome_glow_pulse']);
      for (const kind of Object.keys(LIGHT_PROP_ANIMS) as Array<keyof typeof LIGHT_PROP_ANIMS>) {
        expect(LIGHT_PROP_ANIMS[kind], `${kind} must be static (empty anim list)`).toEqual([]);
      }
    });

    it('no 0-frame flame anim is registered under a key spawn would play (the original crash guard)', () => {
      // The historical bug: empty campfire/fireplace lists were aliased onto
      // the candle key, registering a 0-frame anim that crashed Phaser's
      // getFirstTick when played. With the static redesign NOTHING flame-ish
      // registers at all, so the crash precondition cannot arise — but the
      // guard stays: every registered anim must have frames, and no flame
      // kind's key may exist.
      const scene = makeSceneMock() as unknown as Parameters<typeof ensureAnims>[0];
      ensureAnims(scene);
      const recorded = scene.anims as unknown as ReturnType<typeof makeAnimsMock>;
      for (const [key, anim] of recorded._recorded) {
        expect(anim.frames.length, `anim ${key} must have frames`).toBeGreaterThan(0);
      }
      expect(recorded.exists('__lightProp_torch_flicker')).toBe(false);
      expect(recorded.exists('__lightProp_candle_flicker')).toBe(false);
      expect(recorded.exists('__lightProp_brazier_flicker')).toBe(false);
      expect(recorded.exists('__lightProp_lantern_flicker')).toBe(false);
    });

    it('registers the biome-glow pulse (the single static crystal frame)', () => {
      const scene = makeSceneMock() as unknown as Parameters<typeof ensureAnims>[0];
      ensureAnims(scene);
      const recorded = scene.anims as unknown as ReturnType<typeof makeAnimsMock>;
      const biomeAnim = Array.from(recorded._recorded.values()).find((a) =>
        a.frames.every((f) => f.frame.startsWith('biome-glow_')),
      );
      expect(biomeAnim).toBeDefined();
      expect(biomeAnim!.frames.length).toBe(BIOME_GLOW_PULSE_FRAMES.length);
    });

    it('reproduces the historical crash if a 0-frame anim is registered under a played key', () => {
      // Direct lock-down of the crash signature: Phaser's getFirstTick reads
      // `currentFrame.duration` where currentFrame = anim.frames[0]. A 0-frame
      // anim → frames[0] undefined → TypeError. This test documents the exact
      // failure mode so a future regression (any path that registers an empty
      // anim under a key spawn will play) is unmistakable.
      const anims = makeAnimsMock();
      anims.create({ key: 'candle', frames: [], frameRate: 9, repeat: -1 });
      expect(() => playLikePhaser(anims, 'candle')).toThrowError(
        /Cannot read properties of undefined \(reading 'duration'\)/,
      );
    });

    it('is idempotent (second call does not duplicate registrations)', () => {
      const scene = makeSceneMock() as unknown as Parameters<typeof ensureAnims>[0];
      ensureAnims(scene);
      const recorded1 = scene.anims as unknown as ReturnType<typeof makeAnimsMock>;
      const count1 = recorded1._recorded.size;
      ensureAnims(scene);
      const count2 = recorded1._recorded.size;
      expect(count2).toBe(count1);
    });
  });

  describe('spawn does not crash on any flame-kind placement', () => {
    const flameKinds = [
      'torch',
      'candle',
      'brazier',
      'lantern',
      'biome-glow',
      'campfire',
      'fireplace',
    ] as const;

    flameKinds.forEach((kind) => {
      it(`does not throw on a single ${kind} placement`, () => {
        const scene = makeSceneMock();
        const renderer = new LightPropRenderer(scene as unknown as never);
        // Must not throw — the regression crashed here for candle (and would
        // for brazier/lantern if their animKey were mapped under the old code).
        expect(() => renderer.spawn([placement(kind)], 128)).not.toThrow();
      });
    });

    it('survives a mixed batch of every flame kind (no anim crash)', () => {
      const scene = makeSceneMock();
      const renderer = new LightPropRenderer(scene as unknown as never);
      const placements = flameKinds.map((k, i) => placement(k, i, 0));
      expect(() => renderer.spawn(placements, 128)).not.toThrow();
      // Every non-scatter kind resolves to a sprite (campfire/fireplace reuse
      // game/campfire; barrel-fire is excluded below).
      expect(renderer.count).toBe(flameKinds.length);
    });
  });

  describe('spawn plays the correct per-kind anim (no aliasing)', () => {
    function playedKeyFor(scene: SceneMock, kind: LightPlacementTiled['kind']): string | null {
      const renderer = new LightPropRenderer(scene as unknown as never);
      renderer.spawn([placement(kind)], 128);
      return scene._sprites[0]?.animKeyPlayed ?? null;
    }

    it('plays NO anim for the static flame kinds; biome-glow plays the pulse (tinted crystals stay static)', () => {
      // Static-fixture redesign: torch/candle/brazier/lantern are static
      // sprites (no flame key exists to play — animKeyPlayed stays null).
      // Untinted biome-glow (in-game) plays the pulse; a TINTED crystal (the
      // menu's per-variant crystals, `color` override present) stays static —
      // c83ecd8's `!tintedCrystal` condition in the animKey chain.
      const expectNoAnim = (kind: LightPlacementTiled['kind']) => {
        expect(playedKeyFor(makeSceneMock(), kind)).toBeNull();
      };
      expectNoAnim('torch');
      expectNoAnim('candle');
      expectNoAnim('brazier');
      expectNoAnim('lantern');
      // Untinted biome-glow → the pulse key.
      expect(playedKeyFor(makeSceneMock(), 'biome-glow')).toBe('__lightProp_biome_glow_pulse');
      // Tinted crystal (per-placement `color` override) → static + the NEUTRAL
      // crystal frame + the hue applied as a sprite tint (c83ecd8's swap).
      const tintedScene = makeSceneMock();
      const renderer = new LightPropRenderer(tintedScene as unknown as never);
      renderer.spawn(
        [
          {
            ...placement('biome-glow'),
            color: [0.3, 0.4, 0.52],
          },
        ],
        128,
      );
      expect(tintedScene._sprites[0]!.animKeyPlayed).toBeNull();
      expect(tintedScene._sprites[0]!.frame).toBe('biome-crystal_01');
      expect(tintedScene._sprites[0]!.tint).not.toBeNull();
    });

    it('does NOT play any anim for campfire or fireplace (static game/campfire sprite)', () => {
      const scene = makeSceneMock();
      ensureAnims(scene as unknown as Parameters<typeof ensureAnims>[0]);
      expect(playedKeyFor(scene, 'campfire')).toBeNull();
      expect(playedKeyFor(scene, 'fireplace')).toBeNull();
    });

    it('does NOT spawn a sprite for scatter placements (light-only fill)', () => {
      const scene = makeSceneMock();
      const renderer = new LightPropRenderer(scene as unknown as never);
      const scatter: LightPlacementTiled = {
        gridX: 0,
        gridY: 0,
        kind: 'torch',
        rotation: 0,
        flipH: false,
        flipV: false,
        isScatter: true,
      } as LightPlacementTiled;
      renderer.spawn([scatter], 128);
      expect(renderer.count).toBe(0);
    });
  });

  describe('removeAt — per-tile fixture teardown on destructible destruction', () => {
    it('destroys the sprite at the given tile and drops the count', () => {
      const scene = makeSceneMock();
      const renderer = new LightPropRenderer(scene as unknown as never);
      renderer.spawn([placement('campfire', 3, 7), placement('campfire', 10, 2)], 128);
      expect(renderer.count).toBe(2);
      renderer.removeAt(3, 7);
      expect(renderer.count).toBe(1);
      // The destroyed sprite was the one at tile (3,7); the one at (10,2) is
      // untouched. The mock tracks `destroyed` so we assert the sprite at the
      // removed tile was destroyed and the other was not.
      const destroyed = scene._sprites.filter((s) => s.destroyed);
      expect(destroyed.length).toBe(1);
    });

    it('is a no-op on a tile that never carried a placement (never throws)', () => {
      const scene = makeSceneMock();
      const renderer = new LightPropRenderer(scene as unknown as never);
      renderer.spawn([placement('campfire', 3, 7)], 128);
      expect(renderer.count).toBe(1);
      expect(() => renderer.removeAt(99, 99)).not.toThrow();
      expect(renderer.count).toBe(1); // unchanged
    });

    it('does not double-destroy on repeated calls for the same tile', () => {
      const scene = makeSceneMock();
      const renderer = new LightPropRenderer(scene as unknown as never);
      renderer.spawn([placement('campfire', 3, 7)], 128);
      renderer.removeAt(3, 7);
      renderer.removeAt(3, 7); // second call — sprite already gone
      expect(renderer.count).toBe(0);
      // Only one destroy() call reached the sprite (the second removeAt found
      // no sprite in the map and early-returned).
      expect(scene._sprites.filter((s) => s.destroyed).length).toBe(1);
    });

    it('clear() destroys every spawned sprite (shutdown path)', () => {
      const scene = makeSceneMock();
      const renderer = new LightPropRenderer(scene as unknown as never);
      renderer.spawn([placement('campfire', 1, 1), placement('torch', 2, 2)], 128);
      renderer.clear();
      expect(renderer.count).toBe(0);
      expect(scene._sprites.filter((s) => s.destroyed).length).toBe(2);
    });
  });
});

// ── Ticket 11: per-kind vertical offset (universal placement fix) ──────────
// The bright core of every light-prop frame sits in the LOWER half of its
// 128×128 cell (flame bases, coal beds, fixture sockets are drawn below the
// cell center). Without a per-kind raise, the visible flame lands BELOW its
// light disk. spawn() must consult LIGHT_PROP_Y_OFFSETS and lift the sprite
// so the core meets the disk center. These tests lock (a) the table is
// complete for every LightKind, (b) the pure resolver, and (c) spawn applies
// the raise to the spawned sprite's world Y (disk position stays at grid).
describe('LightPropRenderer — per-kind Y offset (ticket 11)', () => {
  // Every LightKind the shared contract can emit (packages/shared map/tiledTypes).
  const ALL_KINDS: LightKind[] = [
    'torch',
    'campfire',
    'candle',
    'biome-glow',
    'barrel-fire',
    'fireplace',
    'brazier',
    'lantern',
  ];

  describe('LIGHT_PROP_Y_OFFSETS table', () => {
    it('has an entry for every LightKind (no kind falls through to default)', () => {
      // A missing entry would silently leave that kind unraised — the bug
      // ticket 11 fixes. Every shared LightKind must be explicitly listed.
      for (const kind of ALL_KINDS) {
        expect(
          Object.prototype.hasOwnProperty.call(LIGHT_PROP_Y_OFFSETS, kind),
          `LIGHT_PROP_Y_OFFSETS must cover kind "${kind}"`,
        ).toBe(true);
      }
    });

    it('every offset is a non-negative integer (the bug is "core sits below" — we only raise)', () => {
      // Offsets are pixel raises applied as `worldY -= offset`. A negative
      // value would LOWER a sprite (none of the art has its core above the
      // cell center by a material amount). A non-integer would fight the
      // pixel grid. Lock both invariants.
      for (const kind of ALL_KINDS) {
        const off = LIGHT_PROP_Y_OFFSETS[kind];
        expect(Number.isInteger(off), `${kind} offset must be an integer`).toBe(true);
        expect(off, `${kind} offset must be >= 0`).toBeGreaterThanOrEqual(0);
      }
    });

    it('torch/candle/brazier/lantern are raised (their art cores sit below center)', () => {
      // The kinds whose generator scripts draw the fixture/flame in the lower
      // cell half MUST get a positive raise. biome-glow/campfire/fireplace are
      // already centered (0 is correct); barrel-fire has no sprite (0 is moot).
      expect(LIGHT_PROP_Y_OFFSETS.torch).toBeGreaterThan(0);
      expect(LIGHT_PROP_Y_OFFSETS.candle).toBeGreaterThan(0);
      expect(LIGHT_PROP_Y_OFFSETS.brazier).toBeGreaterThan(0);
      expect(LIGHT_PROP_Y_OFFSETS.lantern).toBeGreaterThan(0);
    });

    it('torch is raised the most (its bracket/socket is drawn lowest in the cell)', () => {
      // torch's iron socket sits at cy+12..cy+24 (the lowest fixture anchor of
      // any kind), so it needs the largest raise. Lock the relative ordering
      // so a future art regen that shifts the torch core can't silently make
      // another kind's offset exceed it without this test flagging the change.
      const torch = LIGHT_PROP_Y_OFFSETS.torch;
      for (const kind of ALL_KINDS) {
        if (kind === 'torch') continue;
        expect(torch, `torch must be raised >= ${kind}`).toBeGreaterThanOrEqual(
          LIGHT_PROP_Y_OFFSETS[kind],
        );
      }
    });

    it('fireplace inherits campfire alignment (both reuse game/campfire)', () => {
      // LightPropResolver maps BOTH campfire + fireplace → game/campfire, so
      // their offsets must match (a divergence would float one of the two).
      expect(LIGHT_PROP_Y_OFFSETS.fireplace).toBe(LIGHT_PROP_Y_OFFSETS.campfire);
    });

    it('the measured values are locked (regression guard for the derived offsets)', () => {
      // Exact values derived from the rendered atlas pixel centroids (see the
      // docstring on LIGHT_PROP_Y_OFFSETS). Pinning them catches accidental
      // retunes; a deliberate change should update these + that docstring.
      expect(LIGHT_PROP_Y_OFFSETS).toEqual({
        torch: 21,
        campfire: 0,
        candle: 12,
        'biome-glow': 0,
        'barrel-fire': 0,
        fireplace: 0,
        brazier: 9,
        lantern: 9,
        // Map-redesign ticket 04: the beacon fixture (neutral-crystal frame)
        // has its bright core at the cell center — no vertical raise.
        beacon: 0,
      });
    });
  });

  describe('lightPropYOffset resolver', () => {
    it('returns the table value for every known kind', () => {
      for (const kind of ALL_KINDS) {
        expect(lightPropYOffset(kind)).toBe(LIGHT_PROP_Y_OFFSETS[kind]);
      }
    });

    it('defaults to 0 for an unknown kind (never throws, never lowers)', () => {
      // Defensive: a future shared-enum addition must not crash spawn. The
      // fallback is 0 (no raise) — matching the pre-ticket-11 behavior — so the
      // sprite still renders (just unraised) rather than disappearing.
      expect(lightPropYOffset('future-kind' as LightKind)).toBe(0);
    });
  });

  describe('spawn applies the raise to the sprite world Y (disk stays at grid)', () => {
    it('raises a torch sprite by its offset (base worldY - offset)', () => {
      // gridY=0, tileSize=128 → tile center (== disk center) at worldY 64.
      // The sprite must be placed at 64 - torchOffset so its lower-half core
      // lands at the disk center.
      const scene = makeSceneMock();
      const renderer = new LightPropRenderer(scene as unknown as never);
      renderer.spawn([placement('torch', 0, 0)], 128);
      const sprite = scene._sprites[0]!;
      expect(sprite.y).toBe(64 - LIGHT_PROP_Y_OFFSETS.torch);
      expect(sprite.x).toBe(64); // X is unaffected — only Y is nudged.
    });

    it('raises a torch at a non-zero gridY (offset is constant, not scaled by grid)', () => {
      // gridY=5 → tile center 5*128+64 = 704; raised sprite at 704 - torchOffset.
      // Guards against a regression that ties the offset to tileSize or grid.
      const scene = makeSceneMock();
      const renderer = new LightPropRenderer(scene as unknown as never);
      renderer.spawn([placement('torch', 0, 5)], 128);
      expect(scene._sprites[0]!.y).toBe(5 * 128 + 64 - LIGHT_PROP_Y_OFFSETS.torch);
    });

    it('leaves a campfire sprite at the tile center (offset 0 — already centered)', () => {
      // campfire's warm centroid is at/above the cell center, so no raise.
      // Its sprite Y must equal the tile center (== disk center) exactly.
      const scene = makeSceneMock();
      const renderer = new LightPropRenderer(scene as unknown as never);
      renderer.spawn([placement('campfire', 0, 0)], 128);
      expect(scene._sprites[0]!.y).toBe(64);
    });

    it('leaves biome-glow at the tile center (offset 0)', () => {
      const scene = makeSceneMock();
      const renderer = new LightPropRenderer(scene as unknown as never);
      renderer.spawn([placement('biome-glow', 0, 0)], 128);
      expect(scene._sprites[0]!.y).toBe(64);
    });

    it('respects a non-128 tileSize for the offset (offset is px, not cell-fraction)', () => {
      // The offset is an absolute pixel raise derived from the 128×128 art
      // cell; it does NOT scale with tileSize (the art cell is always 128).
      // At tileSize=64 the tile center is 32, and the torch raise is still 21.
      const scene = makeSceneMock();
      const renderer = new LightPropRenderer(scene as unknown as never);
      renderer.spawn([placement('torch', 0, 0)], 64);
      expect(scene._sprites[0]!.y).toBe(32 - LIGHT_PROP_Y_OFFSETS.torch);
    });

    it('raises every flame kind that has a positive offset (brazier + lantern)', () => {
      const brazierScene = makeSceneMock();
      new LightPropRenderer(brazierScene as unknown as never).spawn(
        [placement('brazier', 0, 0)],
        128,
      );
      expect(brazierScene._sprites[0]!.y).toBe(64 - LIGHT_PROP_Y_OFFSETS.brazier);

      const lanternScene = makeSceneMock();
      new LightPropRenderer(lanternScene as unknown as never).spawn(
        [placement('lantern', 0, 0)],
        128,
      );
      expect(lanternScene._sprites[0]!.y).toBe(64 - LIGHT_PROP_Y_OFFSETS.lantern);

      const candleScene = makeSceneMock();
      new LightPropRenderer(candleScene as unknown as never).spawn(
        [placement('candle', 0, 0)],
        128,
      );
      expect(candleScene._sprites[0]!.y).toBe(64 - LIGHT_PROP_Y_OFFSETS.candle);
    });
  });
});
