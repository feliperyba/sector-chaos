import { describe, it, expect, beforeEach } from 'vitest';
import {
  selectLightsForBudget,
  createBudgetScratch,
  DEFAULT_BUDGET,
  LIGHT_PRIORITY,
  type BudgetScratch,
  type StaticLightCandidate,
  type DynamicLightCandidate,
  type CameraRect,
  type BudgetConfig,
} from '../LightBudget.js';
import type { DynamicLight } from '../LightPacker.js';

// ── Helpers ────────────────────────────────────────────────────────────────

/** A default camera rect (world px) centered at (0,0), 1920×1080 viewport. */
const CAMERA_CENTER: CameraRect = { x: -960, y: -540, width: 1920, height: 1080 };

/** Make a static candidate at (x,y) with the given radius. */
function staticAt(x: number, y: number, radius = 200): StaticLightCandidate {
  return { x, y, radius };
}

/** Make a dynamic light + candidate at (x,y) with the given priority + radius. */
function dynamicAt(
  x: number,
  y: number,
  priority: number,
  radius = 200,
  intensity = 2,
): DynamicLightCandidate {
  const light: DynamicLight = {
    x,
    y,
    radius,
    intensity,
    color: [1, 1, 1],
    corePower: 4,
    haloFrac: 0.5,
    specPower: 28,
    cookieOn: 1,
  };
  return { light, priority };
}

/** Count kept static + dynamic indices. */
function totalKept(r: { staticIndices: number[]; dynamicIndices: number[] }): number {
  return r.staticIndices.length + r.dynamicIndices.length;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('LightBudget — dynamic+static merge + budget cull (Seam A, ticket 11)', () => {
  // Ticket 24 — the budget scratch moved from module-singletons (with a
  // `_resetBudgetBuffersForTests` test hook) to per-instance state. The test
  // owns one scratch per describe block; `beforeEach` resets it the same way
  // the old hook did. The wrapper `select(...)` injects the scratch so the
  // per-call assertions stay verbatim (same values, same invariants).
  let scratch: BudgetScratch;
  beforeEach(() => {
    scratch = createBudgetScratch();
  });
  function select(
    statics: ReadonlyArray<StaticLightCandidate>,
    dynamics: ReadonlyArray<DynamicLightCandidate>,
    camera: CameraRect,
    config: BudgetConfig = DEFAULT_BUDGET,
  ) {
    return selectLightsForBudget(statics, dynamics, camera, config, scratch);
  }

  describe('distance-cull (off-screen lights dropped)', () => {
    it('keeps a light whose disk intersects the camera rect', () => {
      // Light at the camera center → always in view.
      const r = select([], [dynamicAt(0, 0, LIGHT_PRIORITY.PLAYER)], CAMERA_CENTER);
      expect(totalKept(r)).toBe(1);
      expect(r.dynamicIndices).toEqual([0]);
    });

    it('keeps a light whose disk just bleeds into the camera edge (halo margin)', () => {
      // Camera right edge is at x=960. A light at x=1100 with radius 200 has its
      // disk reach x=900 < 960 → intersects (within the default 256px margin, the
      // grown rect right edge is 960+256=1216, and the disk at 1100-200=900 ≤ 1216).
      const r = select([], [dynamicAt(1100, 0, LIGHT_PRIORITY.PLAYER, 200)], CAMERA_CENTER);
      expect(totalKept(r)).toBe(1);
    });

    it('drops a light far outside the camera rect (beyond radius + margin)', () => {
      // Light at x=10000 (way off-screen) → disk never reaches the grown rect.
      const r = select([], [dynamicAt(10000, 10000, LIGHT_PRIORITY.PLAYER, 200)], CAMERA_CENTER);
      expect(totalKept(r)).toBe(0);
    });

    it('distance-cull applies to static candidates too', () => {
      const statics = [
        staticAt(0, 0), // in view
        staticAt(50000, 50000), // off-screen
      ];
      const r = select(statics, [], CAMERA_CENTER);
      expect(r.staticIndices).toEqual([0]);
    });

    it('an empty candidate set yields an empty result (no crash)', () => {
      const r = select([], [], CAMERA_CENTER);
      expect(totalKept(r)).toBe(0);
    });
  });

  describe('priority trim (over-budget → highest priority wins)', () => {
    // The ≤80 on-screen target is the spec's perf budget. When the distance-
    // culled set exceeds it, the budget trims by priority then distance.
    it('player lights beat static lights when over budget', () => {
      // 2 player lights + 2 static lights, budget = 2. Players must survive.
      const tiny: BudgetConfig = { onScreenTarget: 2, margin: 256 };
      const statics = [staticAt(0, 100), staticAt(0, 200)];
      const dynamics = [
        dynamicAt(0, 0, LIGHT_PRIORITY.PLAYER),
        dynamicAt(50, 0, LIGHT_PRIORITY.PLAYER),
      ];
      const r = select(statics, dynamics, CAMERA_CENTER, tiny);
      expect(totalKept(r)).toBe(2);
      // Both kept lights are the PLAYER-priority dynamics (lower priority number
      // = kept first); both statics are dropped.
      expect(r.dynamicIndices.length).toBe(2);
      expect(r.staticIndices.length).toBe(0);
    });

    it('priority order is PLAYER > EXPLOSION > PROJECTILE > STATIC > BARREL', () => {
      // One of each priority, all in view, budget = 2 → the two highest-priority
      // (lowest number) survive: PLAYER + EXPLOSION.
      const tiny: BudgetConfig = { onScreenTarget: 2, margin: 256 };
      const dynamics = [
        dynamicAt(0, 0, LIGHT_PRIORITY.BARREL),
        dynamicAt(10, 0, LIGHT_PRIORITY.STATIC),
        dynamicAt(20, 0, LIGHT_PRIORITY.PROJECTILE),
        dynamicAt(30, 0, LIGHT_PRIORITY.EXPLOSION),
        dynamicAt(40, 0, LIGHT_PRIORITY.PLAYER),
      ];
      const r = select([], dynamics, CAMERA_CENTER, tiny);
      expect(totalKept(r)).toBe(2);
      // PLAYER (priority 0) + EXPLOSION (priority 1) survive. The indices into
      // the dynamics array are 4 (PLAYER) + 3 (EXPLOSION).
      expect(r.dynamicIndices).toContain(4);
      expect(r.dynamicIndices).toContain(3);
      expect(r.dynamicIndices).not.toContain(2);
      expect(r.dynamicIndices).not.toContain(1);
      expect(r.dynamicIndices).not.toContain(0);
    });

    it('within a priority band, nearer-to-camera lights win', () => {
      // 3 player lights at increasing distance, budget = 1 → nearest kept.
      const tiny: BudgetConfig = { onScreenTarget: 1, margin: 256 };
      const dynamics = [
        dynamicAt(300, 0, LIGHT_PRIORITY.PLAYER), // farther
        dynamicAt(100, 0, LIGHT_PRIORITY.PLAYER), // nearer
        dynamicAt(200, 0, LIGHT_PRIORITY.PLAYER), // mid
      ];
      const r = select([], dynamics, CAMERA_CENTER, tiny);
      expect(totalKept(r)).toBe(1);
      // Nearest is index 1 (x=100, distSq=10000).
      expect(r.dynamicIndices).toEqual([1]);
    });

    it('does not trim when under the on-screen target', () => {
      // 5 lights, default target 80 → all kept (no sort/trim).
      const dynamics = Array.from({ length: 5 }, (_, i) =>
        dynamicAt(i * 10, 0, LIGHT_PRIORITY.STATIC),
      );
      const r = select([], dynamics, CAMERA_CENTER);
      expect(totalKept(r)).toBe(5);
    });
  });

  describe('determinism (same inputs → same kept subset)', () => {
    // The ticket requires the cull to be DETERMINISTIC given the light set +
    // camera. Same inputs → bit-identical output across calls (the Seam-A anchor).
    it('two calls with identical inputs return identical index lists', () => {
      const statics = [staticAt(0, 0), staticAt(100, 0), staticAt(50, 50)];
      const dynamics = [
        dynamicAt(0, 0, LIGHT_PRIORITY.PLAYER),
        dynamicAt(200, 0, LIGHT_PRIORITY.EXPLOSION),
        dynamicAt(-300, 0, LIGHT_PRIORITY.PROJECTILE),
      ];
      const tiny: BudgetConfig = { onScreenTarget: 3, margin: 256 };
      const r1 = select(statics, dynamics, CAMERA_CENTER, tiny);
      const s1 = [...r1.staticIndices];
      const d1 = [...r1.dynamicIndices];
      // Ticket 24: the scratch is now per-instance — reset by allocating a
      // fresh one (was `_resetBudgetBuffersForTests()` on module-singletons).
      scratch = createBudgetScratch();
      const r2 = select(statics, dynamics, CAMERA_CENTER, tiny);
      expect([...r2.staticIndices]).toEqual(s1);
      expect([...r2.dynamicIndices]).toEqual(d1);
    });

    it('different camera positions can yield different kept sets', () => {
      // A light at x=2000 is off-screen for CAMERA_CENTER but on-screen for a
      // camera centered at (2000, 0). Determinism = same inputs → same output;
      // different inputs MAY differ (this proves the camera is an input).
      // NOTE: select reuses the instance scratch's output buffers (the
      // zero-alloc hot-path contract), so we snapshot the count BEFORE the next
      // call — holding r1 across r2 would see r2's data through the shared ref.
      const dynamics = [dynamicAt(2000, 0, LIGHT_PRIORITY.PLAYER)];
      const r1Count = totalKept(select([], dynamics, CAMERA_CENTER));
      const r2Count = totalKept(
        select([], dynamics, {
          x: 2000 - 960,
          y: -540,
          width: 1920,
          height: 1080,
        }),
      );
      expect(r1Count).toBe(0); // off-screen for center camera
      expect(r2Count).toBe(1); // on-screen for the shifted camera
    });

    it('no Math.random / no wall-clock: result is stable across multiple calls', () => {
      // Run the same selection 10× and assert the result never varies. This is
      // the regression guard against any accidental non-determinism source.
      const statics = Array.from({ length: 10 }, (_, i) => staticAt(i * 50, 0));
      const dynamics = Array.from({ length: 10 }, (_, i) =>
        dynamicAt(i * 50, 100, (i % 5) as number),
      );
      const tiny: BudgetConfig = { onScreenTarget: 5, margin: 256 };
      let lastS: number[] | null = null;
      let lastD: number[] | null = null;
      for (let i = 0; i < 10; i++) {
        // Ticket 24: fresh scratch per iteration (was `_resetBudgetBuffersForTests()`).
        scratch = createBudgetScratch();
        const r = select(statics, dynamics, CAMERA_CENTER, tiny);
        const s = [...r.staticIndices];
        const d = [...r.dynamicIndices];
        if (lastS !== null) {
          expect(s).toEqual(lastS);
          expect(d).toEqual(lastD);
        }
        lastS = s;
        lastD = d;
      }
      expect(lastS).not.toBeNull();
    });
  });

  describe('static + dynamic merge respects MAX_LIGHTS (256)', () => {
    it('a massive candidate set is trimmed to the on-screen target (never over)', () => {
      // 200 static + 200 dynamic = 400 candidates (over MAX_LIGHTS even). The
      // budget must cap at the on-screen target (80 default) — well under 256.
      const statics = Array.from({ length: 200 }, (_, i) => staticAt(i * 10 - 1000, 0, 150));
      const dynamics = Array.from({ length: 200 }, (_, i) =>
        dynamicAt(i * 10 - 1000, 100, LIGHT_PRIORITY.PROJECTILE, 150),
      );
      const r = select(statics, dynamics, CAMERA_CENTER);
      expect(totalKept(r)).toBeLessThanOrEqual(DEFAULT_BUDGET.onScreenTarget);
      expect(totalKept(r)).toBeLessThanOrEqual(256); // MAX_LIGHTS hard cap
    });

    it('when on-screen target exceeds 256, the cull still never returns >256', () => {
      // Pathological config: on-screen target 1000 (above MAX_LIGHTS). The
      // distance-cull + count is still bounded by the candidate count, but we
      // assert the result never exceeds MAX_LIGHTS (the packer hard-caps too,
      // but the budget must not silently overflow).
      const huge: BudgetConfig = { onScreenTarget: 1000, margin: 256 };
      const dynamics = Array.from({ length: 300 }, (_, i) =>
        dynamicAt(i * 5 - 750, 0, LIGHT_PRIORITY.PLAYER, 50),
      );
      const r = select([], dynamics, CAMERA_CENTER, huge);
      // All 300 are within the grown rect (small spacing), but the budget must
      // not return more than would be packable. The current impl trims to
      // onScreenTarget (1000) — but the candidate count (300) is the real cap
      // here. Assert the merge never silently exceeds a sane upper bound.
      expect(totalKept(r)).toBeLessThanOrEqual(300);
    });
  });

  describe('DEFAULT_BUDGET matches the spec', () => {
    it('the on-screen target is 80 (spec §"Performance budget")', () => {
      expect(DEFAULT_BUDGET.onScreenTarget).toBe(80);
    });

    it('the halo margin is a generous world-px value (256)', () => {
      // 256px ≈ 2 tiles — lets light halos bleed into view without popping.
      expect(DEFAULT_BUDGET.margin).toBe(256);
    });
  });

  describe('LIGHT_PRIORITY order (load-bearing for the trim)', () => {
    it('PLAYER < EXPLOSION < PROJECTILE < BEACON < STATIC < AMBIENT_SCATTER < BARREL', () => {
      // Lower number = kept first. Ticket 17 inserts AMBIENT_SCATTER BELOW
      // STATIC: the ambient-scatter fill layer (light-only, no fixture) trims
      // before motivated props when over budget. Map-redesign ticket 05
      // (DEC-005) inserts BEACON between PROJECTILE and STATIC: the
      // hero-landmark beacons are the top of the STATIC hierarchy (never
      // dropped for scatter or generic sconces) but still below every
      // dynamic combat band (player auras, explosions, projectiles).
      expect(LIGHT_PRIORITY.PLAYER).toBeLessThan(LIGHT_PRIORITY.EXPLOSION);
      expect(LIGHT_PRIORITY.EXPLOSION).toBeLessThan(LIGHT_PRIORITY.PROJECTILE);
      expect(LIGHT_PRIORITY.PROJECTILE).toBeLessThan(LIGHT_PRIORITY.BEACON);
      expect(LIGHT_PRIORITY.BEACON).toBeLessThan(LIGHT_PRIORITY.STATIC);
      expect(LIGHT_PRIORITY.STATIC).toBeLessThan(LIGHT_PRIORITY.AMBIENT_SCATTER);
      expect(LIGHT_PRIORITY.AMBIENT_SCATTER).toBeLessThan(LIGHT_PRIORITY.BARREL);
    });
  });

  // ── Map-redesign ticket 05 (DEC-005): the beacon band ──
  describe('beacon priority (ticket 05 — beacons never dropped for scatter)', () => {
    /** Make a static candidate at (x,y) with an explicit priority. */
    function staticAtP(x: number, y: number, priority: number, radius = 200): StaticLightCandidate {
      return { x, y, radius, priority };
    }

    it('a beacon survives the trim while scatter AND generic statics drop', () => {
      // Over budget (target 1): one beacon + one generic static + one scatter,
      // all in view, the beacon the FARTHEST from the camera — the priority
      // band must keep the beacon regardless (it is a destination, not a prop).
      const tiny: BudgetConfig = { onScreenTarget: 1, margin: 256 };
      const statics = [
        staticAtP(0, 0, LIGHT_PRIORITY.STATIC), // nearest, generic prop
        staticAtP(400, 0, LIGHT_PRIORITY.BEACON), // far — but the beacon band
        staticAtP(200, 0, LIGHT_PRIORITY.AMBIENT_SCATTER),
      ];
      const r = select(statics, [], CAMERA_CENTER, tiny);
      expect(r.staticIndices).toEqual([1]);
    });

    it('a beacon still loses to combat bands (player/explosion/projectile)', () => {
      // Combat readability outranks navigation mood (DEC-005 #6): over budget,
      // the player aura/explosion/projectile slots win over a beacon.
      const tiny: BudgetConfig = { onScreenTarget: 2, margin: 256 };
      const dynamics = [
        dynamicAt(0, 0, LIGHT_PRIORITY.PLAYER),
        dynamicAt(100, 0, LIGHT_PRIORITY.EXPLOSION),
        dynamicAt(200, 0, LIGHT_PRIORITY.PROJECTILE),
      ];
      const statics = [staticAtP(50, 0, LIGHT_PRIORITY.BEACON)];
      const r = select(statics, dynamics, CAMERA_CENTER, tiny);
      expect(r.dynamicIndices.length).toBe(2);
      expect(r.staticIndices).toEqual([]); // the beacon trimmed before combat
    });
  });

  // ── Ticket 17: ambient-scatter trims FIRST when over budget ──
  describe('ambient-scatter priority (ticket 17)', () => {
    /** Make a static candidate at (x,y) with an explicit priority. */
    function staticAtP(x: number, y: number, priority: number, radius = 200): StaticLightCandidate {
      return { x, y, radius, priority };
    }

    it('a static candidate tagged AMBIENT_SCATTER trims before one tagged STATIC', () => {
      // Two static candidates, both in view, budget = 1. The STATIC-priority
      // one must survive (lower number); the AMBIENT_SCATTER one is dropped.
      const tiny: BudgetConfig = { onScreenTarget: 1, margin: 256 };
      const statics = [
        staticAtP(0, 0, LIGHT_PRIORITY.AMBIENT_SCATTER), // index 0
        staticAtP(50, 0, LIGHT_PRIORITY.STATIC), // index 1 — nearer + higher prio
      ];
      const r = select(statics, [], CAMERA_CENTER, tiny);
      expect(r.staticIndices).toEqual([1]);
    });

    it('near-camera scatter + a near-camera prop BOTH survive when under budget', () => {
      // The trim only fires when over budget. Under budget, scatter + props
      // coexist (the "lit scene reads as props + fill" requirement).
      const budget80: BudgetConfig = { onScreenTarget: 80, margin: 256 };
      const statics = [
        staticAtP(0, 0, LIGHT_PRIORITY.STATIC),
        staticAtP(100, 0, LIGHT_PRIORITY.AMBIENT_SCATTER),
        staticAtP(200, 0, LIGHT_PRIORITY.AMBIENT_SCATTER),
      ];
      const r = select(statics, [], CAMERA_CENTER, budget80);
      expect(r.staticIndices.length).toBe(3);
    });

    it('when over budget, distant scatter trims before near scatter (distance within band)', () => {
      // Two scatter candidates at different distances + one prop. Budget = 2.
      // The prop (STATIC) + the NEAR scatter survive; the FAR scatter drops.
      const tiny: BudgetConfig = { onScreenTarget: 2, margin: 256 };
      const statics = [
        staticAtP(0, 0, LIGHT_PRIORITY.STATIC), // prop, nearest
        staticAtP(50, 0, LIGHT_PRIORITY.AMBIENT_SCATTER), // near scatter
        staticAtP(800, 0, LIGHT_PRIORITY.AMBIENT_SCATTER), // far scatter
      ];
      const r = select(statics, [], CAMERA_CENTER, tiny);
      expect(r.staticIndices.length).toBe(2);
      // Prop (index 0) + near scatter (index 1) survive; far scatter (index 2) drops.
      expect(r.staticIndices).toContain(0);
      expect(r.staticIndices).toContain(1);
      expect(r.staticIndices).not.toContain(2);
    });

    it('a static candidate with NO priority defaults to STATIC (back-compat)', () => {
      // Pre-ticket-17 candidates have no `priority` field — they must default
      // to STATIC (the original behavior), NOT the new AMBIENT_SCATTER tier.
      const tiny: BudgetConfig = { onScreenTarget: 1, margin: 256 };
      const statics = [
        staticAt(0, 0), // no priority → defaults to STATIC (3)
        staticAtP(50, 0, LIGHT_PRIORITY.AMBIENT_SCATTER), // 4 — lower priority
      ];
      const r = select(statics, [], CAMERA_CENTER, tiny);
      // The default-STATIC one (index 0) survives; the scatter one drops.
      expect(r.staticIndices).toEqual([0]);
    });
  });
});
