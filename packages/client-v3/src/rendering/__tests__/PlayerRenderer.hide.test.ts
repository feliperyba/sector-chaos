/**
 * Regression test for ticket C1 — weapon hide must survive stale state patches.
 *
 * WHY THE `PlayerRenderer.updateWeapon` SEAM (the missing seam from iteration 3):
 * The prior B1 fix (commit 9973956) added the event-driven `hideWeapon()` + a
 * per-frame `!weaponHidden` guard, but `updateWeapon` runs on EVERY server state
 * patch via `PlayerVisualSync.handlePlayerChange` and UNCONDITIONALLY re-armed
 * the weapon (`setVisible(true)` + `weaponHidden = false`), defeating the
 * event-driven hide within ~1 RTT. The per-frame guard is structurally inert
 * once any post-event patch re-arms via `updateWeapon`. Iteration 3 had NO test
 * exercising the event → stale-patch → re-arm race — that's why this shipped.
 *
 * THE BUG THIS PINS:
 *   hideWeapon(key) hides the weapon (event-driven). Then a STALE state patch
 *   carrying the SAME pre-event weapon arrives → `updateWeapon` re-armed it.
 *   The fix (Approach A): only re-arm when the incoming weapon genuinely
 *   differs from the one that was hidden (`weapon.weaponType !==
 *   equippedWeaponType`) OR no hide is in effect (`!weaponHidden`). A stale
 *   patch carrying the same weapon must NOT re-arm.
 *
 * WHY THIS CAN RUN IN VITEST:
 * `PlayerRenderer`'s constructor instantiates `AttackVFXRenderer`,
 * `WeaponTrailRenderer`, `ArmRenderer`, each of which calls `scene.add.graphics()`
 * / `scene.add.sprite()` / `scene.textures.createCanvas()` at construction time
 * (Phaser has no headless mode in vitest). We provide a STUB SCENE whose
 * `add.*` / `textures.*` surface returns chainable no-op stubs so the three
 * sub-renderers construct without a real WebGL context. `updateWeapon` itself
 * only touches `scene.textures.get('game').has(sk)` + the `weapon` sprite on
 * the pre-seeded `PlayerVisual` (a recording stub). `weaponRegistry`,
 * `getTierColor`, `WEAPON_SPRITE_MAP` are pure data and run clean in jsdom. We
 * pre-seed the renderer's `bundles` map directly (cast through
 * `unknown` — same test-only escape hatch as `buildEmptyContext` in
 * `PlayerRendererUpdate.test.ts`), so we never touch the Phaser-bound
 * `createPlayerRenderBundle` factory.
 *
 * Reference: `.scratch/lighting-system-3/01-findings/C1-weapon-still-visible-throw-break.md`
 * (root-cause-per-file:line + stale-patch race proof + gameplay preservation).
 */
import { describe, it, expect } from 'vitest';
import { WeaponType } from '@sector-battle/shared';
import { PlayerRenderer } from '../PlayerRenderer.js';
import type { PlayerState } from '../../types.js';
import type { PlayerRenderBundle, PlayerVisual } from '../PlayerRendererTypes.js';

/**
 * Chainable no-op stub for any `Phaser.GameObjects.*` returned by `scene.add.*`.
 * Every method returns `this` so `.setDepth(20)` / `.setOrigin(...)` chains
 * (used by AttackVFXRenderer/WeaponTrailRenderer/ArmRenderer constructors)
 * don't throw. The weapon sprite used in the seeded visual overrides `setVisible`
 * + `visible` to be a recording assertion target (see `makeWeaponSpriteStub`).
 */
function makeChainableGameObject() {
  const obj: Record<string, unknown> = {};
  const chain = function () {} as unknown as Record<string, unknown>;
  // Common Phaser GameObject methods used at construction; return `chain` so
  // any `.setX().setY().setDepth()` chain resolves. New methods proxy through.
  const methods = [
    'setDepth', 'setOrigin', 'setScale', 'setTint', 'setAlpha', 'setVisible',
    'setFlipX', 'setFlipY', 'setRotation', 'setPosition', 'setTexture',
    'setInteractive', 'setScrollFactor', 'setData', 'setName', 'clearTint',
    'setBlendMode', 'setDisplaySize', 'setSize', 'setCollideWorldBounds',
  ];
  for (const m of methods) chain[m] = () => chain;
  // `clear` is called every frame by AttackVFXRenderer.drawAttacks — not used
  // here but stubbed for safety.
  chain.clear = () => chain;
  // `destroy` returns void.
  chain.destroy = () => {};
  // `getContext` + `refresh` for the ArmRenderer canvas texture.
  chain.getContext = () => ({ fillStyle: '', fillRect: () => {} });
  chain.refresh = () => chain;
  // Storage for arbitrary property reads (`visible`, `x`, `y`, etc.).
  return new Proxy(chain as object, {
    get(target, prop) {
      if (prop in target) return (target as Record<string | symbol, unknown>)[prop];
      return obj[prop as string];
    },
    set(target, prop, value) {
      (target as Record<string | symbol, unknown>)[prop] = value;
      return true;
    },
  });
}

/**
 * Minimal scene stub. Covers the construction-time surface of
 * `AttackVFXRenderer` (`scene.add.graphics().setDepth(20)`),
 * `WeaponTrailRenderer` (`scene.add.graphics().setDepth(19)`),
 * `ArmRenderer` (`scene.textures.exists/createCanvas` + `scene.add.sprite`),
 * and the `updateWeapon` runtime surface (`scene.textures.get('game').has(sk)`
 * → false so the `setTexture` branch is skipped).
 */
function makeSceneStub() {
  const gameTexture = { has: () => false };
  return {
    add: {
      graphics: () => makeChainableGameObject(),
      sprite: () => makeChainableGameObject(),
      text: () => makeChainableGameObject(),
      image: () => makeChainableGameObject(),
    },
    textures: {
      get: () => gameTexture,
      exists: () => true, // ArmRenderer.ensureTexture skips createCanvas when exists
      createCanvas: () => makeChainableGameObject(),
    },
    cameras: { main: { scrollX: 0, width: 0, scrollY: 0, height: 0 } },
    events: { on: () => {}, off: () => {}, emit: () => {} },
  };
}

/**
 * Recording weapon-sprite stub. `setVisible` mutates `visible` (mirroring how a
 * real Phaser `Sprite.setVisible(v)` updates the `.visible` flag that
 * `getWeaponWorldState` and the per-frame pipeline read) so the test can assert
 * visibility transitions. Other mutators are no-ops; `updateWeapon` doesn't
 * read back from them.
 */
function makeWeaponSpriteStub() {
  const sprite = {
    visible: true,
    setVisible(v: boolean) {
      sprite.visible = v;
      return sprite;
    },
    setTexture: () => sprite,
    setScale: () => sprite,
    setOrigin: () => sprite,
    setFlipX: () => sprite,
    setTint: () => sprite,
    setAlpha: () => sprite,
    setRotation: () => sprite,
    setPosition: () => sprite,
    destroy: () => {},
  };
  return sprite;
}

/**
 * Pre-seeded `PlayerVisual` carrying only the fields `updateWeapon` reads or
 * mutates. Cast through `unknown` (test-only escape hatch): the full
 * `PlayerVisual` surface (Phaser sprites, juice springs, victim impact state)
 * is not exercised by `updateWeapon` and cannot be constructed in jsdom anyway.
 */
function makeMinimalVisual(): PlayerVisual {
  return {
    weapon: makeWeaponSpriteStub() as unknown as PlayerVisual['weapon'],
    equippedWeaponType: -1,
    weaponHidden: false,
  } as unknown as PlayerVisual;
}

/** Builds a `PlayerState` with `weapons[slot]` carrying the given weapon type. */
function makePlayerWithWeapon(weaponType: number, slot = 0): PlayerState {
  return {
    activeSlot: slot,
    weapons: [
      {
        id: 'w0',
        weaponType,
        tier: 0,
        ammo: 0,
        maxAmmo: 0,
      },
    ],
  } as unknown as PlayerState;
}

/**
 * Constructs a `PlayerRenderer` and pre-seeds player `key` with a minimal
 * `PlayerVisual` (stub weapon sprite, no hide in effect, fists equipped). The
 * `drivers` map gets a no-op `setWeapon` stub so the genuine-re-equip branch
 * runs without instantiating `AnimSimDriver`.
 */
function makeRendererWithPlayer(key: string): PlayerRenderer {
  const scene = makeSceneStub();
  const renderer = new PlayerRenderer(
    scene as unknown as ConstructorParameters<typeof PlayerRenderer>[0],
  );
  // Pre-seed the private bundles map (test-only escape hatch). The driver
  // stub's `setWeapon` is the only method `updateWeapon` dereferences on the
  // real-weapon branch when the incoming weapon differs from the held one.
  const internals = renderer as unknown as {
    bundles: Map<string, PlayerRenderBundle>;
  };
  internals.bundles.set(key, {
    visual: makeMinimalVisual(),
    driver: { setWeapon: () => {} },
  } as unknown as PlayerRenderBundle);
  return renderer;
}

/** Read-only view of the seeded visual's weapon flag + hide flag. */
function readVisual(renderer: PlayerRenderer, key: string) {
  const v = (renderer as unknown as { bundles: Map<string, PlayerRenderBundle> }).bundles.get(
    key,
  )!.visual;
  return {
    visible: (v.weapon as unknown as { visible: boolean }).visible,
    weaponHidden: v.weaponHidden,
    equippedWeaponType: v.equippedWeaponType,
  };
}

const W = WeaponType.DAGGER; // weaponType W (the pre-event weapon)
const X = WeaponType.LONG_SWORD; // weaponType X (genuine re-equip)

describe('ticket C1 — weapon hide survives stale state patches (regression of B1)', () => {
  it('the event → stale-patch race: a stale patch carrying the SAME weapon does NOT re-arm', () => {
    // Step 1+2: renderer seeded with player armed with weaponType W; updateWeapon
    // with W shows the weapon and clears the hide flag.
    const key = 'p1';
    const renderer = makeRendererWithPlayer(key);
    renderer.updateWeapon(key, makePlayerWithWeapon(W));
    {
      const s = readVisual(renderer, key);
      expect(s.visible).toBe(true);
      expect(s.weaponHidden).toBe(false);
      expect(s.equippedWeaponType).toBe(W);
    }

    // Step 3: hideWeapon fires (throw/break event). Weapon hidden, flag armed.
    renderer.hideWeapon(key);
    {
      const s = readVisual(renderer, key);
      expect(s.visible).toBe(false);
      expect(s.weaponHidden).toBe(true);
    }

    // Step 4: STALE PATCH — updateWeapon runs again carrying the SAME pre-event
    // weapon W (the slot-clear patch lags the event by ≥1 RTT). The prior B1
    // fix re-armed here; the C1 fix must NOT. Weapon stays hidden, flag stays
    // armed. THIS IS THE BUG THE PRIOR FIX MISSED.
    renderer.updateWeapon(key, makePlayerWithWeapon(W));
    {
      const s = readVisual(renderer, key);
      expect(s.visible).toBe(false);
      expect(s.weaponHidden).toBe(true);
      // equippedWeaponType is untouched (still W) — the patch genuinely carried
      // the same weapon, so there's no equip transition to record either.
      expect(s.equippedWeaponType).toBe(W);
    }
  });

  it('genuine re-equip (different weaponType X) re-shows the weapon', () => {
    // Pickup/switch/equip MUST still re-show the weapon (the genuine re-equip
    // path). After the stale-patch hide above, a patch carrying a DIFFERENT
    // weapon (X) is a genuine equip — the hide clears and the weapon shows.
    const key = 'p1';
    const renderer = makeRendererWithPlayer(key);
    renderer.updateWeapon(key, makePlayerWithWeapon(W));
    renderer.hideWeapon(key);
    // Stale patch carrying W (must not re-arm, per the first test).
    renderer.updateWeapon(key, makePlayerWithWeapon(W));
    expect(readVisual(renderer, key).visible).toBe(false);

    // Genuine re-equip: different weaponType X arrives.
    renderer.updateWeapon(key, makePlayerWithWeapon(X));
    {
      const s = readVisual(renderer, key);
      expect(s.visible).toBe(true);
      expect(s.weaponHidden).toBe(false);
      expect(s.equippedWeaponType).toBe(X);
    }
  });

  it('slot genuinely cleared by server (empty/fists) keeps the weapon hidden', () => {
    // The server's authoritative slot-clear patch (post-throw/break, the patch
    // that ACTUALLY empties the slot) drives `updateWeapon` into the
    // empty/fists branch. The weapon stays hidden and the hide flag stays
    // armed — this matches the existing B1 behaviour for the empty branch and
    // is independent of the stale-patch gate (which only governs the
    // real-weapon branch).
    const key = 'p1';
    const renderer = makeRendererWithPlayer(key);
    renderer.updateWeapon(key, makePlayerWithWeapon(W));
    renderer.hideWeapon(key);

    // Authoritative slot-clear: weaponType 0 (FISTS) in the slot.
    renderer.updateWeapon(key, makePlayerWithWeapon(WeaponType.FISTS));
    {
      const s = readVisual(renderer, key);
      expect(s.visible).toBe(false);
      expect(s.weaponHidden).toBe(true);
      expect(s.equippedWeaponType).toBe(-1);
    }
  });

  it('no hide in effect: normal re-patches keep the weapon visible (no false hide)', () => {
    // Sanity: when no event-driven hide is in effect, repeated patches carrying
    // the same weapon must NOT spuriously hide it. The gate only suppresses
    // re-arm when `weaponHidden === true`; with the flag clear, the
    // real-weapon branch keeps the weapon visible (status quo pre-C1).
    const key = 'p1';
    const renderer = makeRendererWithPlayer(key);
    renderer.updateWeapon(key, makePlayerWithWeapon(W));
    expect(readVisual(renderer, key).visible).toBe(true);

    renderer.updateWeapon(key, makePlayerWithWeapon(W));
    renderer.updateWeapon(key, makePlayerWithWeapon(W));
    {
      const s = readVisual(renderer, key);
      expect(s.visible).toBe(true);
      expect(s.weaponHidden).toBe(false);
    }
  });
});
