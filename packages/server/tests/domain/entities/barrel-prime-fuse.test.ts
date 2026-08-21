import { describe, it, expect } from 'vitest';
import { Destructible } from '../../../src/domain/entities/Destructible.ts';
import { Position } from '../../../src/domain/value-objects/index.ts';
import { BARREL } from '@sector-battle/shared';

/**
 * Juice-pass-1 ticket 05 — primed-barrel contract at the entity level
 * (GDD §5.5/§5.5.1/§7.15, locked by ticket 01's Resolution):
 *
 * - flat two-hit barrels: HP 2, every melee/thrown/arrow hit costs exactly
 *   1 HP regardless of the weapon's destructibleDamage
 * - any surviving hit primes a 5 s tick-based fuse (barrels only)
 * - the next destroying hit detonates immediately, exactly as before
 * - explosions keep their full damage and one-shot barrels (chains intact)
 * - crates/walls/light keep per-weapon damage and never prime
 */
describe('Barrel prime + fuse (juice-pass-1 ticket 05)', () => {
  describe('BARREL fuse constants', () => {
    it('FUSE_MS is 5000 (5 s)', () => {
      expect(BARREL.FUSE_MS).toBe(5000);
    });

    it('FUSE_TICKS is tick-derived from FUSE_MS at 60 ticks/s', () => {
      expect(BARREL.FUSE_TICKS).toBe(300);
      expect(BARREL.FUSE_TICKS).toBe((BARREL.FUSE_MS / 1000) * 60);
    });
  });

  describe('prime on surviving hit from every source', () => {
    it.each(['melee', 'thrown', 'arrow'] as const)(
      '%s hit: exactly 1 HP regardless of rawDamage, primes fuse at hitTick + FUSE_TICKS',
      (source) => {
        for (const rawDamage of [1, 3, 30]) {
          const barrel = Destructible.create(
            `b-${source}-${rawDamage}`,
            'barrel',
            new Position(0, 0),
          );
          const result = barrel.takeDamage({ source, rawDamage, currentTick: 120 });

          expect(result.destroyed).toBe(false);
          expect(result.shouldExplode).toBe(false);
          expect(barrel.hp).toBe(1);
          expect(barrel.primed).toBe(true);
          expect(barrel.fuseExpiresAtTick).toBe(120 + BARREL.FUSE_TICKS);
        }
      },
    );

    it('fists-strength and hammer-strength hits prime identically', () => {
      const weak = Destructible.create('b-weak', 'barrel', new Position(0, 0));
      weak.takeDamage({ source: 'melee', rawDamage: 1, currentTick: 5 });
      const strong = Destructible.create('b-strong', 'barrel', new Position(0, 0));
      strong.takeDamage({ source: 'melee', rawDamage: 30, currentTick: 5 });

      expect(weak.hp).toBe(strong.hp);
      expect(weak.primed).toBe(strong.primed);
      expect(weak.fuseExpiresAtTick).toBe(strong.fuseExpiresAtTick);
    });

    it('barrels spawn unprimed', () => {
      const barrel = Destructible.create('b-fresh', 'barrel', new Position(0, 0));
      expect(barrel.primed).toBe(false);
      expect(barrel.fuseExpiresAtTick).toBe(0);
    });
  });

  describe('second hit detonates immediately', () => {
    it.each(['melee', 'thrown', 'arrow', 'other'] as const)(
      '%s killing blow after a priming hit explodes on the spot',
      (source) => {
        const barrel = Destructible.create('b-2hit', 'barrel', new Position(0, 0));
        barrel.takeDamage({ source: 'melee', rawDamage: 2, currentTick: 0 });
        expect(barrel.primed).toBe(true);

        const result = barrel.takeDamage({ source, rawDamage: 3, currentTick: 1 });
        expect(result.destroyed).toBe(true);
        expect(result.shouldExplode).toBe(true);
        expect(barrel.hp).toBe(0);
      },
    );
  });

  describe('explosions still one-shot (chains preserved)', () => {
    it('explosion source keeps full rawDamage: 50 destroys a primed barrel in one hit', () => {
      const barrel = Destructible.create('b-exp', 'barrel', new Position(0, 0));
      barrel.takeDamage({ source: 'melee', rawDamage: 1, currentTick: 0 });
      expect(barrel.primed).toBe(true);

      const result = barrel.takeDamage({ source: 'explosion', rawDamage: 50, currentTick: 10 });
      expect(result.destroyed).toBe(true);
      expect(result.shouldExplode).toBe(true);
    });

    it('explosion of a neighbor destroys the next barrel instantly (chain semantics)', () => {
      const barrels = [0, 1, 2].map((i) =>
        Destructible.create(`b-chain-${i}`, 'barrel', new Position(i * 128, 0)),
      );

      // Explosion-origin barrel destroyed outright by an explosion source...
      const first = barrels[0]!.takeDamage({ source: 'explosion', rawDamage: 50, currentTick: 0 });
      expect(first.destroyed).toBe(true);
      expect(first.shouldExplode).toBe(true);

      // ...and each chained barrel is likewise one-shot by the explosion
      // damage (50 >> 2 HP) — the pre-ticket chain behavior, unchanged.
      for (const barrel of barrels.slice(1)) {
        const result = barrel.takeDamage({ source: 'explosion', rawDamage: 50, currentTick: 0 });
        expect(result.destroyed).toBe(true);
        expect(result.shouldExplode).toBe(true);
      }
    });

    it('an explosion hit never primes (it can never leave a barrel alive)', () => {
      const barrel = Destructible.create('b-noprime', 'barrel', new Position(0, 0));
      barrel.takeDamage({ source: 'explosion', rawDamage: 50, currentTick: 0 });
      expect(barrel.isDestroyed).toBe(true);
      expect(barrel.primed).toBe(false);
      expect(barrel.fuseExpiresAtTick).toBe(0);
    });
  });

  describe('override never touches crates/walls/light', () => {
    it('crate keeps per-weapon damage and never primes', () => {
      const crate = Destructible.create('c1', 'crate', new Position(0, 0));
      crate.takeDamage({ source: 'melee', rawDamage: 1, currentTick: 0 });
      expect(crate.hp).toBe(1); // per-weapon 1 HP applied (NOT the barrel flat rule)
      expect(crate.primed).toBe(false);
      expect(crate.fuseExpiresAtTick).toBe(0);
    });

    it('wall keeps per-weapon damage and never primes', () => {
      const wall = Destructible.create('w1', 'wall', new Position(0, 0));
      wall.takeDamage({ source: 'melee', rawDamage: 3, currentTick: 0 });
      expect(wall.hp).toBe(7); // 10 - 3 per-weapon, unchanged
      expect(wall.primed).toBe(false);
      expect(wall.fuseExpiresAtTick).toBe(0);
    });

    it('light keeps per-weapon damage (1 HP — any hit destroys) and never primes', () => {
      const light = Destructible.create('l1', 'light', new Position(0, 0));
      const result = light.takeDamage({ source: 'melee', rawDamage: 5, currentTick: 0 });
      expect(result.destroyed).toBe(true);
      expect(light.primed).toBe(false);
      expect(light.fuseExpiresAtTick).toBe(0);
    });

    it('arrow/thrown also keep per-weapon damage on non-barrels', () => {
      const wallArrow = Destructible.create('w-a', 'wall', new Position(0, 0));
      wallArrow.takeDamage({ source: 'arrow', rawDamage: 3, currentTick: 0 });
      expect(wallArrow.hp).toBe(7);

      const wallThrown = Destructible.create('w-t', 'wall', new Position(0, 0));
      wallThrown.takeDamage({ source: 'thrown', rawDamage: 4, currentTick: 0 });
      expect(wallThrown.hp).toBe(6);
    });
  });

  describe('fuse anchoring rules', () => {
    it('fuse is anchored to the hit tick, not wall-clock', () => {
      const barrel = Destructible.create('b-anchor', 'barrel', new Position(0, 0));
      barrel.takeDamage({ source: 'melee', rawDamage: 1, currentTick: 4321 });
      expect(barrel.fuseExpiresAtTick).toBe(4321 + BARREL.FUSE_TICKS);
    });

    it('a surviving hit on an already-primed barrel never extends the fuse', () => {
      const barrel = Destructible.create('b-reprime', 'barrel', new Position(0, 0));
      barrel.takeDamage({ source: 'melee', rawDamage: 1, currentTick: 100 });
      expect(barrel.fuseExpiresAtTick).toBe(100 + BARREL.FUSE_TICKS);

      // A 0-damage 'other' hit survives without destroying — the first
      // surviving hit's expiry must stand.
      barrel.takeDamage({ source: 'other', rawDamage: 0, currentTick: 9999 });
      expect(barrel.fuseExpiresAtTick).toBe(100 + BARREL.FUSE_TICKS);
    });
  });
});
