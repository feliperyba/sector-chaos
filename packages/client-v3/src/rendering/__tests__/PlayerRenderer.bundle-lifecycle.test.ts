/**
 * Ticket gpu-player-render-bundle — single-owner lifecycle stress tests.
 *
 * These are the ticket's REQUIRED acceptance tests:
 *
 *   1. Rapid join/leave churn — add/remove players (overlapping keys, re-adds
 *      without matching removes) interleaved with live update frames; the
 *      scene display list must return to the exact baseline object set
 *      (zero orphaned sprites: every leaked sprite — a surviving arm segment,
 *      a leaked label, a body whose map entry died — keeps the count high).
 *
 *   2. The TELEPORT TRAP — the historical ghost-arms trigger. A player is
 *      rendered IN-VIEW at coordinate A (the IK arms get posed at A), then the
 *      server teleports them far off-screen to B (reconciliation snap), they
 *      go view-culled, and are then eliminated (removePlayer). At HEAD the
 *      teardown was scattered across 6 separately-keyed maps and a remove
 *      that missed the arm map left the 4 arm segments alive at A forever
 *      ("ghost arms at the teleport trap"). With the single-owner bundle the
 *      remove destroys ALL 9 display objects of that player or none.
 *
 *   3. destroy() full teardown, re-add-without-remove no-op safety, and
 *      remove-of-unknown-key no-op safety (the scenarios the old defensive
 *      loops in ArmRenderer.addPlayer / PlayerRenderer.removePlayer patched —
 *      they must stay safe WITHOUT the loops).
 *
 * The harness uses a recording scene stub whose display list is authoritative:
 * `add.sprite/text/graphics` register objects, `destroy()` removes them (and
 * counts calls, so a double-destroy in the teardown would be caught too).
 * Per-player objects are identified by capturing the slice of the display
 * list created between two points in time.
 */
import { describe, it, expect } from 'vitest';
import { WeaponType } from '@sector-battle/shared';
import { PlayerRenderer } from '../PlayerRenderer.js';
import type { PlayerRenderBundle } from '../PlayerRendererTypes.js';
import type { TrailData } from '../WeaponTrailRenderer.js';
import type { PlayerState } from '../../types.js';

/** Recording display object: chainable setters + removal on destroy. */
interface StubObject {
  kind: 'sprite' | 'text' | 'graphics';
  x: number;
  y: number;
  visible: boolean;
  alpha: number;
  destroyed: boolean;
  destroyCalls: number;
  setOrigin: () => StubObject;
  setDisplaySize: () => StubObject;
  setDepth: () => StubObject;
  setFlipX: () => StubObject;
  setScale: () => StubObject;
  setVisible: (v: boolean) => StubObject;
  setAlpha: (a: number) => StubObject;
  setTint: () => StubObject;
  clearTint: () => StubObject;
  setPosition: (x: number, y: number) => StubObject;
  setRotation: () => StubObject;
  setTexture: () => StubObject;
  clear: () => StubObject;
  destroy: () => void;
}

/**
 * Scene stub with a LIVE DISPLAY LIST. `list` holds exactly the live (not yet
 * destroyed) display objects; `all` records every object ever created (with
 * its destroy-call count) so tests can assert single-destroy teardown.
 */
interface StubScene {
  list: StubObject[];
  all: StubObject[];
  textures: unknown;
  add: unknown;
  cameras: unknown;
}

function makeStubObject(kind: StubObject['kind'], x = 0, y = 0, list: StubObject[]): StubObject {
  const obj: StubObject = {
    kind,
    x,
    y,
    visible: true,
    alpha: 1,
    destroyed: false,
    destroyCalls: 0,
    setOrigin: () => obj,
    setDisplaySize: () => obj,
    setDepth: () => obj,
    setFlipX: () => obj,
    setScale: () => obj,
    setVisible: (v: boolean) => {
      obj.visible = v;
      return obj;
    },
    setAlpha: (a: number) => {
      obj.alpha = a;
      return obj;
    },
    setTint: () => obj,
    clearTint: () => obj,
    setPosition: (nx: number, ny: number) => {
      obj.x = nx;
      obj.y = ny;
      return obj;
    },
    setRotation: () => obj,
    setTexture: () => obj,
    // Graphics no-ops (trail/VFX render calls):
    clear: () => obj,
    destroy: () => {
      obj.destroyCalls++;
      if (obj.destroyed) return; // Phaser tolerates double-destroy; count it anyway
      obj.destroyed = true;
      const idx = list.indexOf(obj);
      if (idx >= 0) list.splice(idx, 1);
    },
  };
  list.push(obj);
  return obj;
}

function makeScene(): StubScene {
  const list: StubObject[] = [];
  const all: StubObject[] = [];
  const register = (obj: StubObject): StubObject => {
    all.push(obj);
    return obj;
  };
  return {
    list,
    all,
    textures: {
      // The factory probes `textures.get('game').has(frameKey)`; report every
      // frame present so `createPlayerRenderBundle` builds the full unit.
      get: () => ({ has: () => true }),
      // ArmRenderer.ensureTexture: pretend the 4x1 arm texture exists (skip
      // the canvas-creation path that needs a real Phaser texture manager).
      exists: () => true,
    },
    add: {
      sprite: (x: number, y: number) => register(makeStubObject('sprite', x, y, list)),
      text: (x: number, y: number) => register(makeStubObject('text', x, y, list)),
      graphics: () => register(makeStubObject('graphics', 0, 0, list)),
    },
    cameras: {
      main: {
        scrollX: 0,
        scrollY: 0,
        width: 1280,
        height: 720,
        worldView: { x: 0, y: 0, right: 1280, bottom: 720 },
      },
    },
  };
}

/** Minimal PlayerState (only fields the factory + update loop read). */
function makePlayerState(over: Partial<PlayerState> = {}): PlayerState {
  return {
    name: 'Test',
    x: 0,
    y: 0,
    color: 0,
    health: 100,
    maxHealth: 100,
    facingAngle: 0,
    speed: 0,
    activeSlot: 0,
    isBot: false,
    ...over,
  } as unknown as PlayerState;
}

/** Test-only escape hatch into the renderer's private per-player owner map. */
function internals(renderer: PlayerRenderer): {
  bundles: Map<string, PlayerRenderBundle>;
  trailRenderer: { active: Array<{ trail: TrailData; bundle: PlayerRenderBundle }> };
} {
  return renderer as unknown as {
    bundles: Map<string, PlayerRenderBundle>;
    trailRenderer: { active: Array<{ trail: TrailData; bundle: PlayerRenderBundle }> };
  };
}

/** Display objects that did NOT exist before `mark` (i.e. created since). */
function createdSince(scene: StubScene, mark: number): StubObject[] {
  return scene.all.slice(mark);
}

describe('PlayerRenderBundle single-owner lifecycle (ticket gpu-player-render-bundle)', () => {
  it('constructor baseline is exactly the 2 shared Graphics (VFX + trail)', () => {
    const scene = makeScene();
    const renderer = new PlayerRenderer(scene as never);
    expect(scene.list.length).toBe(2);
    expect(scene.list.every((o) => o.kind === 'graphics')).toBe(true);
    // No per-player state exists yet.
    expect(internals(renderer).bundles.size).toBe(0);
  });

  it('rapid join/leave churn returns the display list to the exact baseline set', () => {
    const scene = makeScene();
    const renderer = new PlayerRenderer(scene as never);
    const baseline = [...scene.list];

    // Churn: overlapping keys, interleaved adds/removes/re-adds + update
    // frames between every mutation (the state a missed teardown leaks).
    const KEYS = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'];
    const live = new Set<string>();
    for (let i = 0; i < 60; i++) {
      const key = KEYS[i % KEYS.length]!;
      if (!live.has(key)) {
        renderer.addPlayer(key, makePlayerState({ name: key, x: 200 + i * 13, y: 200 }));
        live.add(key);
      }
      renderer.update(16);
      // Remove a DIFFERENT key every other iteration (staggered lifetimes).
      if (i % 2 === 1) {
        const victim = KEYS[(i + 3) % KEYS.length]!;
        if (live.has(victim)) {
          renderer.removePlayer(victim);
          live.delete(victim);
        }
      }
      // Invariant: live display objects == baseline + 9 per live player
      // (body, 2 hands, weapon, label, 4 arm segments).
      expect(scene.list.length).toBe(baseline.length + 9 * live.size);
    }

    // Drain: remove everyone.
    for (const key of live) renderer.removePlayer(key);
    live.clear();

    // ZERO orphaned sprites: the display list IS the baseline again (same
    // objects, same order — nothing created during the churn survived).
    expect(scene.list).toEqual(baseline);
    expect(internals(renderer).bundles.size).toBe(0);
    // Every created object was destroyed EXACTLY once (no double-destroy in
    // the single-owner teardown, no object left alive).
    const churned = scene.all.filter((o) => !baseline.includes(o));
    expect(churned.length).toBeGreaterThan(0);
    for (const obj of churned) {
      expect(obj.destroyed).toBe(true);
      expect(obj.destroyCalls).toBe(1);
    }
  });

  it('teleport trap: player culled at a teleport then removed leaves ZERO objects at the trap', () => {
    const scene = makeScene();
    const renderer = new PlayerRenderer(scene as never);
    renderer.setLocalPlayerId('local');

    const baselineCount = scene.list.length;

    // Victim rendered IN-VIEW at the trap coordinate A.
    const TRAP_X = 300;
    const TRAP_Y = 300;
    const mark = scene.all.length; // before the victim is added
    renderer.addPlayer('victim', makePlayerState({ name: 'victim', x: TRAP_X, y: TRAP_Y }));
    // Local player IN-VIEW but far from the trap zone (the near-trap sweep at
    // the end must only flag ghost geometry, not the legitimately-placed local).
    renderer.addPlayer('local', makePlayerState({ name: 'local', x: 1100, y: 650 }));
    const created = createdSince(scene, mark);
    expect(created.length).toBe(18); // victim + local, 9 each
    const victimSlice = created.slice(0, 9); // victim was added first

    // Frames in view: the IK arms get posed near the trap coordinate.
    for (let i = 0; i < 6; i++) renderer.update(16);
    const victimBundle = internals(renderer).bundles.get('victim')!;
    const armSprites = [
      victimBundle.arms.leftUpper,
      victimBundle.arms.leftForearm,
      victimBundle.arms.rightUpper,
      victimBundle.arms.rightForearm,
    ] as unknown as StubObject[];
    // Arms were IK-posed at the trap (near the body, i.e. NOT at origin 0,0).
    for (const arm of armSprites) {
      expect(arm.x).toBeGreaterThan(TRAP_X - 200);
      expect(arm.x).toBeLessThan(TRAP_X + 200);
    }

    // Start an attack trail mid-capture at the trap (a teardown that misses
    // the trail registry leaks the capture — the third scattered owner).
    renderer.startWindup('victim', WeaponType.LONG_SWORD);
    renderer.update(16);
    expect(internals(renderer).trailRenderer.active.length).toBe(1);

    // TELEPORT: server correction snaps the victim far off-screen (the
    // historical trigger — reconciliation snap while culled-bound).
    const FAR_X = 9000;
    const FAR_Y = 9000;
    renderer.snapPosition('victim', FAR_X, FAR_Y);
    for (let i = 0; i < 4; i++) renderer.update(16);

    // Culled: arms hidden AND pinned onto the live body at B (not at the trap).
    expect(victimBundle.visual.culled).toBe(true);
    for (const arm of armSprites) {
      expect(arm.visible).toBe(false);
      expect(arm.x).toBe(FAR_X);
      expect(arm.y).toBe(FAR_Y);
    }

    // Elimination at the far side: full single-owner teardown.
    renderer.removePlayer('victim');

    // ZERO orphaned sprites: every one of the victim's 9 display objects is
    // destroyed (display list back to baseline + the local player's 9).
    expect(scene.list.length).toBe(baselineCount + 9);
    for (const obj of victimSlice) {
      expect(obj.destroyed).toBe(true);
      expect(obj.destroyCalls).toBe(1);
    }
    // The trail capture was unregistered with the bundle (third owner gone).
    expect(internals(renderer).trailRenderer.active.length).toBe(0);
    expect(victimBundle.trail).toBeNull();
    // No live object lingers at/near the trap coordinate (the ghost-arms
    // symptom: arm segments frozen at the trap the player left).
    for (const obj of scene.list) {
      const nearTrap =
        Math.abs(obj.x - TRAP_X) < 400 &&
        Math.abs(obj.y - TRAP_Y) < 400 &&
        obj.kind !== 'graphics';
      expect(nearTrap).toBe(false);
    }
    // The local player's render unit is untouched by the victim's teardown.
    expect(internals(renderer).bundles.get('local')!.visual.body).toBeDefined();
  });

  it('teleport trap + rapid rejoin: the re-added player gets fresh objects, the old set stays destroyed', () => {
    const scene = makeScene();
    const renderer = new PlayerRenderer(scene as never);
    const baselineCount = scene.list.length;

    renderer.addPlayer('p', makePlayerState({ name: 'p', x: 300, y: 300 }));
    const firstMark = scene.all.length;
    const firstBody = internals(renderer).bundles.get('p')!.visual.body as unknown as StubObject;
    renderer.update(16);
    renderer.snapPosition('p', 9000, 9000);
    renderer.update(16); // culled at the far side
    renderer.removePlayer('p');
    expect(scene.list.length).toBe(baselineCount);

    // Colyseus re-join with the SAME session id — a re-add after a remove.
    renderer.addPlayer('p', makePlayerState({ name: 'p', x: 500, y: 500 }));
    expect(scene.list.length).toBe(baselineCount + 9);
    const secondBundle = internals(renderer).bundles.get('p')!;
    // New unit, new objects — the destroyed set was not resurrected/reused.
    expect(secondBundle.visual.body as unknown as StubObject).not.toBe(firstBody);
    expect(firstBody.destroyed).toBe(true);
    expect(scene.all.length).toBe(firstMark + 9);
    renderer.update(16);
    renderer.removePlayer('p');
    expect(scene.list.length).toBe(baselineCount);
  });

  it('re-add WITHOUT remove is a safe no-op (scenario of the removed ArmRenderer defensive branch)', () => {
    const scene = makeScene();
    const renderer = new PlayerRenderer(scene as never);
    renderer.addPlayer('p', makePlayerState({ name: 'p', x: 100, y: 100 }));
    const first = internals(renderer).bundles.get('p')!;

    // Re-add with a DIFFERENT position: must early-return, not rebuild/leak.
    renderer.addPlayer('p', makePlayerState({ name: 'p', x: 999, y: 999 }));
    const internalsView = internals(renderer);
    expect(internalsView.bundles.size).toBe(1);
    expect(internalsView.bundles.get('p')).toBe(first);
    // Exactly 9 objects for this player exist — the overwrite orphan
    // (4 ghost arm segments) cannot happen anymore.
    expect(scene.list.length).toBe(2 + 9);

    renderer.removePlayer('p');
    expect(scene.list.length).toBe(2);
  });

  it('remove of an unknown key is a safe no-op (scenario of the removed always-teardown guard)', () => {
    const scene = makeScene();
    const renderer = new PlayerRenderer(scene as never);
    renderer.addPlayer('p', makePlayerState({ name: 'p', x: 100, y: 100 }));
    const before = scene.list.length;

    expect(() => renderer.removePlayer('never-added')).not.toThrow();
    expect(scene.list.length).toBe(before);
    renderer.removePlayer('p');
    expect(scene.list.length).toBe(2);
  });

  it('destroy() tears down every player unit AND the shared renderers', () => {
    const scene = makeScene();
    const renderer = new PlayerRenderer(scene as never);
    for (let i = 0; i < 5; i++) {
      renderer.addPlayer(`p${i}`, makePlayerState({ name: `p${i}`, x: 100 + i * 50, y: 100 }));
    }
    renderer.update(16);
    expect(scene.list.length).toBe(2 + 5 * 9);

    renderer.destroy();

    // The ENTIRE display list is empty — every per-player object and both
    // shared Graphics destroyed, each exactly once.
    expect(scene.list.length).toBe(0);
    for (const obj of scene.all) {
      expect(obj.destroyed).toBe(true);
      expect(obj.destroyCalls).toBe(1);
    }
    expect(internals(renderer).bundles.size).toBe(0);
  });
});
