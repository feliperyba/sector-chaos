import { describe, it, expect } from 'vitest';
import { AttackType, WeaponType } from '@sector-battle/shared';
import {
  getProjectileLight,
  resolveAttackTypeForProjectile,
  ProjectileTrailBuffer,
  TRAIL_DIM_FACTORS,
  TRAIL_MAX_POSITIONS,
  SHIELD_ATTACK_TYPE,
  FALLBACK_ATTACK_TYPE,
  FALLBACK_PROJECTILE_LIGHT,
  POISON_OVERRIDE,
} from '../ProjectileLightTuning.js';

/**
 * Ticket 20 + ticket 09 — per-AttackType projectile light tuning + trail (Seam A).
 *
 * `ProjectileLightTuning.ts` is a pure data + pure logic module (no Phaser, no
 * GPU, no wall-clock), so this test asserts the ticket facts deterministically:
 *
 *   1. Per-AttackType tuning is a deterministic lookup — only RANGED resolves to
 *      a real entry; every other AttackType returns null (ticket 09 / A3 ruling:
 *      arrows-only; physical throws are inert). Pre-ticket-09 every kinetic type
 *      had a warm entry; the assertions were flipped to "returns null" for
 *      LINE/THROWN/ARC.
 *   2. The trail ring buffer records past head positions + dims them correctly
 *      (×0.5 most-recent past, ×0.25 older past; oldest rolls off; dead ids
 *      pruned; no leak). NOTE: in prod the trail is auto-gated to RANGED-only
 *      via the populator's `tuning === null` check — the buffer itself is
 *      AttackType-agnostic (it just records positions); the gate lives in the
 *      populator, asserted there.
 *   3. SHIELD / unknown weaponType handling — SHIELD emits no traveling light
 *      (melee pulse); under ticket 09 the unknown-weaponType fallback (THROWN)
 *      ALSO resolves to null (a mystery weapon shouldn't glow).
 *
 * Cosmetic-only (GDD `docs/GDD.md:210` — lights are mood accents, not vision).
 */

describe('ProjectileLightTuning — per-AttackType table (ticket 20 + ticket 09 RANGED-only)', () => {
  describe('getProjectileLight — deterministic per-AttackType lookup', () => {
    it('RANGED (crossbow bolt / short-bow arrow) = tiny + hot + warm-biased (a fast streak)', () => {
      const e = getProjectileLight(AttackType.RANGED)!;
      expect(e).toBeDefined();
      expect(e.attackType).toBe(AttackType.RANGED);
      // Tiny radius (a bolt is a sliver). Ticket 07: 58 → 72 (modest bump); still < 80.
      expect(e.radius).toBeLessThan(80);
      // Hot near-white core (lightning-fast tracer convention): R and G high,
      // only a faint warm bias (B slightly below R but not deeply warm).
      expect(e.color[0]).toBeGreaterThanOrEqual(0.95);
      expect(e.color[1]).toBeGreaterThanOrEqual(0.9);
      // Tight tracer core + small halo (the streak comes from the trail).
      // Ticket 07 softened: corePower 5.0 → 4.3, haloFrac 0.35 → 0.50.
      expect(e.corePower).toBeGreaterThanOrEqual(4.0); // tight tracer core
      expect(e.haloFrac).toBeLessThanOrEqual(0.55); // small halo
      // Warm cookie (light_01).
      expect(e.cookieOn).toBe(1);
    });

    it('LINE (spear/polearm/staff) emits NO traveling light (ticket 09 — physical throw)', () => {
      // A3 §3: SPEAR/POLEARM/STAFF are LINE AttackType, all physical throws.
      // Pre-ticket-09 LINE had a pale-gold entry; ticket 09 removed it.
      expect(getProjectileLight(AttackType.LINE)).toBeNull();
    });

    it('THROWN (throwing axe) emits NO traveling light (ticket 09 — physical throw)', () => {
      // A3 §3: THROWING_AXE is THROWN, a physical throw.
      expect(getProjectileLight(AttackType.THROWN)).toBeNull();
    });

    it('ARC (dagger/sword/axe thrown-arc) emits NO traveling light (ticket 09 — physical throw)', () => {
      // A3 §3: DAGGER→DOUBLE_AXE are ARC, all physical throws.
      expect(getProjectileLight(AttackType.ARC)).toBeNull();
    });

    it('SHIELD emits NO traveling light (melee pulse, not a disk)', () => {
      expect(getProjectileLight(AttackType.SHIELD)).toBeNull();
      expect(SHIELD_ATTACK_TYPE).toBe(AttackType.SHIELD);
    });

    it('RANGED is the ONLY AttackType that resolves to a non-null entry', () => {
      // The headline ticket-09 fact: arrows-only. Every other AttackType is null.
      for (const at of [
        AttackType.LINE,
        AttackType.THROWN,
        AttackType.ARC,
        AttackType.SHIELD,
      ]) {
        expect(getProjectileLight(at)).toBeNull();
      }
      expect(getProjectileLight(AttackType.RANGED)).not.toBeNull();
    });

    it('intensity is tuned DOWN (accent, not the main light)', () => {
      // Pre-ticket-20: arrow 0.9. Now ≤ ~1.0 so the bolt doesn't out-compete
      // the motivated prop layer (ticket 17).
      const e = getProjectileLight(AttackType.RANGED)!;
      expect(e.intensity).toBeLessThanOrEqual(1.0);
      expect(e.intensity).toBeLessThan(0.9); // lower than the pre-ticket-20 value.
    });

    it('deterministic — same AttackType → same entry every call (stable references)', () => {
      const e1 = getProjectileLight(AttackType.RANGED)!;
      const e2 = getProjectileLight(AttackType.RANGED)!;
      expect(e1).toBe(e2); // same object reference (pure-data lookup).
      expect(e1.color).toEqual(e2.color);
      expect(e1.radius).toBe(e2.radius);
    });

    it('POISON_OVERRIDE is a ready green-tint hook (the documented elemental future)', () => {
      // No poison discriminator exists on weapons today (A3 §4 — no element/
      // affinity field on WeaponDefinition/Projectile/wire), but the override is
      // wired + distinct (green, light_03 cookie) so it slots in cleanly when an
      // elemental system lands.
      expect(POISON_OVERRIDE.color[1]).toBeGreaterThan(POISON_OVERRIDE.color[0]); // G > R = green.
      expect(POISON_OVERRIDE.cookieOn).toBe(3); // light_03 poison radial.
      // Distinct from the surviving RANGED entry's color (so wiring the hook
      // doesn't silently collide).
      const ranged = getProjectileLight(AttackType.RANGED)!;
      const same =
        ranged.color[0] === POISON_OVERRIDE.color[0] &&
        ranged.color[1] === POISON_OVERRIDE.color[1] &&
        ranged.color[2] === POISON_OVERRIDE.color[2];
      expect(same).toBe(false);
    });
  });

  describe('resolveAttackTypeForProjectile — weaponType → AttackType (defensive)', () => {
    it('resolves real weapons to their registry AttackType (mirrors the renderer)', () => {
      // Verified mappings from packages/shared/src/weapons/definitions.ts.
      expect(resolveAttackTypeForProjectile(WeaponType.DAGGER)).toBe(AttackType.ARC);
      expect(resolveAttackTypeForProjectile(WeaponType.SPEAR)).toBe(AttackType.LINE);
      expect(resolveAttackTypeForProjectile(WeaponType.THROWING_AXE)).toBe(AttackType.THROWN);
      expect(resolveAttackTypeForProjectile(WeaponType.SHORT_BOW)).toBe(AttackType.RANGED);
      expect(resolveAttackTypeForProjectile(WeaponType.CROSSBOW)).toBe(AttackType.RANGED);
      expect(resolveAttackTypeForProjectile(WeaponType.SMALL_SHIELD)).toBe(AttackType.SHIELD);
    });

    it('unknown weaponType falls back to THROWN (never throws)', () => {
      // Out-of-range weaponType — the registry lookup throws internally; the
      // resolver catches it + returns the fallback (THROWN = the shared helper
      // convention). Ticket 09: the fallback AttackType is still THROWN (the
      // enum value), but under the RANGED-only ruling THROWN resolves to a NULL
      // light (asserted separately below) — a mystery weapon emits no glow.
      expect(() => resolveAttackTypeForProjectile(99999)).not.toThrow();
      expect(resolveAttackTypeForProjectile(99999)).toBe(FALLBACK_ATTACK_TYPE);
      expect(FALLBACK_ATTACK_TYPE).toBe(AttackType.THROWN);
    });

    it('unknown weaponType resolves to a NULL light (ticket 09 — no surprise glow)', () => {
      // The fallback AttackType (THROWN) is a physical throw → null light under
      // the RANGED-only ruling. The exported FALLBACK_PROJECTILE_LIGHT constant
      // is now null (was the THROWN entry pre-ticket-09). A mystery weapon
      // emits no glow rather than a stray arrow streak.
      expect(FALLBACK_PROJECTILE_LIGHT).toBeNull();
      expect(getProjectileLight(resolveAttackTypeForProjectile(99999))).toBeNull();
    });

    it('deterministic — same weaponType → same AttackType every call', () => {
      expect(resolveAttackTypeForProjectile(WeaponType.CROSSBOW)).toBe(
        resolveAttackTypeForProjectile(WeaponType.CROSSBOW),
      );
    });

    it('arrows (SHORT_BOW + CROSSBOW) are the ONLY weapons that cast a traveling light', () => {
      // The end-to-end ticket-09 ruling expressed at the resolver+table seam:
      // resolve each weapon's AttackType, look up its light, assert only the
      // two RANGED weapons glow. Every physical throw (axe/spear/dagger/etc.)
      // resolves to null. This is the load-bearing acceptance assertion.
      const arrows = [WeaponType.SHORT_BOW, WeaponType.CROSSBOW];
      const physicalThrows = [
        WeaponType.DAGGER,
        WeaponType.SHORT_SWORD,
        WeaponType.LONG_SWORD,
        WeaponType.HAMMER,
        WeaponType.LARGE_AXE,
        WeaponType.BLADED_AXE,
        WeaponType.DOUBLE_AXE,
        WeaponType.SPEAR,
        WeaponType.POLEARM,
        WeaponType.STAFF,
        WeaponType.THROWING_AXE,
      ];
      for (const w of arrows) {
        const at = resolveAttackTypeForProjectile(w);
        expect(getProjectileLight(at), `arrow weapon ${WeaponType[w]} should glow`).not.toBeNull();
      }
      for (const w of physicalThrows) {
        const at = resolveAttackTypeForProjectile(w);
        expect(
          getProjectileLight(at),
          `physical-throw weapon ${WeaponType[w]} should NOT glow`,
        ).toBeNull();
      }
    });
  });
});

describe('ProjectileTrailBuffer — fade trail ring buffer (ticket 20)', () => {
  it('TRAIL_DIM_FACTORS = [0.5, 0.25] (most-recent past brightest; quick fade)', () => {
    expect(TRAIL_DIM_FACTORS).toEqual([0.5, 0.25]);
    expect(TRAIL_MAX_POSITIONS).toBe(2);
  });

  it('emits NO trail for a projectile with no recorded positions', () => {
    const buf = new ProjectileTrailBuffer();
    expect(buf.collect('p1')).toHaveLength(0);
  });

  it('records ONE past position after the first record (no trail yet — head only)', () => {
    // record() is called BEFORE emitting the head, so after one record the
    // buffer holds 1 position. collect() returns 1 trailing descriptor, but a
    // 1-position trail has no "streak" yet — it's the spawn frame. The dim
    // factor for a single position is TRAIL_DIM_FACTORS[0] (0.5).
    const buf = new ProjectileTrailBuffer();
    buf.record('p1', 100, 100);
    const trail = buf.collect('p1');
    expect(trail).toHaveLength(1);
    expect(trail[0]!.x).toBe(100);
    expect(trail[0]!.dim).toBe(0.5);
  });

  it('records TWO past positions after two records — the streak is established', () => {
    const buf = new ProjectileTrailBuffer();
    buf.record('p1', 100, 100); // oldest past position.
    buf.record('p1', 200, 200); // most-recent past position.
    const trail = buf.collect('p1');
    expect(trail).toHaveLength(2);
    // Emitted oldest→newest: first the older (dim 0.25), then the newer (dim 0.5).
    expect(trail[0]!.x).toBe(100);
    expect(trail[0]!.dim).toBe(0.25); // older past = dimmer.
    expect(trail[1]!.x).toBe(200);
    expect(trail[1]!.dim).toBe(0.5); // most-recent past = brighter.
  });

  it('rolls off the OLDEST position once the cap is reached (windowed ring buffer)', () => {
    // After 3 records only the last 2 positions survive (TRAIL_MAX_POSITIONS = 2).
    const buf = new ProjectileTrailBuffer();
    buf.record('p1', 100, 100); // will roll off.
    buf.record('p1', 200, 200);
    buf.record('p1', 300, 300);
    const trail = buf.collect('p1');
    expect(trail).toHaveLength(2);
    expect(trail[0]!.x).toBe(200); // older survivor.
    expect(trail[1]!.x).toBe(300); // newest.
    // The oldest position (100) is gone.
    expect(trail.find((t) => t.x === 100)).toBeUndefined();
  });

  it('keeps per-projectile state separate (two projectiles do not collide)', () => {
    const buf = new ProjectileTrailBuffer();
    buf.record('p1', 100, 100);
    buf.record('p1', 110, 110);
    buf.record('p2', 500, 500);
    buf.record('p2', 510, 510);
    const t1 = buf.collect('p1');
    const t2 = buf.collect('p2');
    expect(t1.every((t) => t.x < 200)).toBe(true);
    expect(t2.every((t) => t.x > 400)).toBe(true);
  });

  it('pruneDead drops trail state for ids no longer live (no leak)', () => {
    const buf = new ProjectileTrailBuffer();
    buf.record('alive', 100, 100);
    buf.record('dead', 200, 200);
    expect(buf.size).toBe(2);
    buf.pruneDead(new Set(['alive']));
    expect(buf.size).toBe(1);
    // The dead projectile's trail is gone.
    expect(buf.collect('dead')).toHaveLength(0);
    // The alive projectile's trail survives.
    expect(buf.collect('alive')).toHaveLength(1);
  });

  it('pruneDead with an empty live set clears everything (mass despawn)', () => {
    const buf = new ProjectileTrailBuffer();
    buf.record('p1', 100, 100);
    buf.record('p2', 200, 200);
    buf.pruneDead(new Set());
    expect(buf.size).toBe(0);
  });

  it('does not leak across many record/prune cycles (steady-state bounded)', () => {
    const buf = new ProjectileTrailBuffer();
    // Simulate 50 frames of one projectile moving + 5 despawns/respawns.
    for (let cycle = 0; cycle < 5; cycle++) {
      const id = `p${cycle}`;
      buf.record(id, cycle * 10, cycle * 10);
      buf.record(id, cycle * 10 + 1, cycle * 10 + 1);
      // Prune everyone except the current cycle's id.
      buf.pruneDead(new Set([id]));
    }
    // Only the last cycle's id survives.
    expect(buf.size).toBe(1);
  });

  it('caps tracked projectiles (evicts oldest when MAX_TRAIL_PROJECTILES exceeded)', () => {
    const buf = new ProjectileTrailBuffer();
    const cap = ProjectileTrailBuffer.MAX_TRAIL_PROJECTILES;
    for (let i = 0; i < cap + 10; i++) {
      buf.record(`p${i}`, i, i);
    }
    expect(buf.size).toBeLessThanOrEqual(cap);
  });

  it('deterministic — same record sequence → same trail descriptors', () => {
    const run = () => {
      const buf = new ProjectileTrailBuffer();
      buf.record('p1', 100, 100);
      buf.record('p1', 200, 200);
      buf.record('p1', 300, 300);
      return buf.collect('p1').map((t) => ({ x: t.x, y: t.y, dim: t.dim }));
    };
    expect(run()).toEqual(run());
  });
});
