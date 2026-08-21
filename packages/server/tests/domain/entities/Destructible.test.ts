import { describe, it, expect } from 'vitest';
import {
  Destructible,
  type DestructibleDamageContext,
} from '../../../src/domain/entities/Destructible.ts';
import { Position } from '../../../src/domain/value-objects/index.ts';
import { CRATE_LOOT, BARREL } from '@sector-battle/shared';

describe('Destructible', () => {
  describe('crate', () => {
    it('has 2 HP', () => {
      const crate = Destructible.create('c1', 'crate', new Position(0, 0));
      expect(crate.maxHp).toBe(2);
      expect(crate.hp).toBe(2);
    });

    it('is destroyed by a single melee hit', () => {
      const crate = Destructible.create('c1', 'crate', new Position(0, 0));
      const result = crate.takeDamage({ source: 'melee', rawDamage: 5 });
      expect(result.destroyed).toBe(true);
      expect(result.shouldExplode).toBe(false);
      expect(crate.isDestroyed).toBe(true);
    });

    it('is destroyed by a single arrow hit', () => {
      const crate = Destructible.create('c1', 'crate', new Position(0, 0));
      const result = crate.takeDamage({ source: 'arrow', rawDamage: 10 });
      expect(result.destroyed).toBe(true);
      expect(result.shouldExplode).toBe(false);
    });

    it('does not trigger explosion', () => {
      const crate = Destructible.create('c1', 'crate', new Position(0, 0));
      const result = crate.takeDamage({ source: 'melee', rawDamage: 5 });
      expect(result.shouldExplode).toBe(false);
    });
  });

  describe('barrel', () => {
    // Juice-pass-1 ticket 05 (GDD §5.5): flat two-hit barrels — HP 2, every
    // melee/thrown/arrow hit costs exactly 1 regardless of weapon damage.
    it('has 2 HP and spawns unprimed', () => {
      const barrel = Destructible.create('b1', 'barrel', new Position(0, 0));
      expect(barrel.maxHp).toBe(2);
      expect(barrel.hp).toBe(2);
      expect(barrel.primed).toBe(false);
      expect(barrel.fuseExpiresAtTick).toBe(0);
    });

    it('triggers explosion when destroyed by explosion source', () => {
      const barrel = Destructible.create('b1', 'barrel', new Position(0, 0));
      const result = barrel.takeDamage({ source: 'explosion', rawDamage: 50 });
      expect(result.destroyed).toBe(true);
      expect(result.shouldExplode).toBe(true);
    });

    it('does not explode from single melee hit; primes a 15s fuse', () => {
      const barrel = Destructible.create('b1', 'barrel', new Position(0, 0));
      const result = barrel.takeDamage({ source: 'melee', rawDamage: 1, currentTick: 500 });
      expect(result.destroyed).toBe(false);
      expect(result.shouldExplode).toBe(false);
      expect(barrel.hp).toBe(1);
      expect(barrel.primed).toBe(true);
      expect(barrel.fuseExpiresAtTick).toBe(500 + BARREL.FUSE_TICKS);
    });

    it('explodes on second melee kill', () => {
      const barrel = Destructible.create('b1', 'barrel', new Position(0, 0));
      barrel.takeDamage({ source: 'melee', rawDamage: 2, currentTick: 0 });
      expect(barrel.hp).toBe(1);

      const result = barrel.takeDamage({ source: 'melee', rawDamage: 2, currentTick: 1 });
      expect(result.destroyed).toBe(true);
      expect(result.shouldExplode).toBe(true);
    });
  });

  describe('iron', () => {
    it('has infinite HP', () => {
      const iron = Destructible.create('i1', 'iron', new Position(0, 0));
      expect(iron.maxHp).toBe(Infinity);
    });

    it('is never destroyed', () => {
      const iron = Destructible.create('i1', 'iron', new Position(0, 0));
      const meleeResult = iron.takeDamage({ source: 'melee', rawDamage: 1 });
      expect(meleeResult.destroyed).toBe(false);
      expect(meleeResult.shouldExplode).toBe(false);

      const explosionResult = iron.takeDamage({ source: 'explosion', rawDamage: 99999 });
      expect(explosionResult.destroyed).toBe(false);
      expect(explosionResult.shouldExplode).toBe(false);
      expect(iron.isDestroyed).toBe(false);
    });

    it('damage state is always intact', () => {
      const iron = Destructible.create('i1', 'iron', new Position(0, 0));
      iron.takeDamage({ source: 'melee', rawDamage: 99999 });
      expect(iron.hp).toBe(Infinity);
      expect(iron.isDestroyed).toBe(false);
    });
  });

  describe('chain reaction', () => {
    it('barrel chain reaction max depth 5', () => {
      const barrels: Destructible[] = [];
      for (let i = 0; i < 6; i++) {
        barrels.push(Destructible.create(`b${i}`, 'barrel', new Position(i * 100, 0)));
      }

      const CHAIN_RADIUS = 150;
      const MAX_DEPTH = 5;
      const destroyedIds: string[] = [];

      function chainExplode(source: Destructible, depth: number): void {
        if (depth > MAX_DEPTH) return;
        for (const target of barrels) {
          if (target.isDestroyed || target.id === source.id) continue;
          const dist = source.position.distanceTo(target.position);
          if (dist <= CHAIN_RADIUS) {
            const result = target.takeDamage({ source: 'explosion', rawDamage: 4 });
            if (result.destroyed) {
              destroyedIds.push(target.id);
              if (result.shouldExplode) {
                chainExplode(target, depth + 1);
              }
            }
          }
        }
      }

      const firstResult = barrels[0].takeDamage({ source: 'explosion', rawDamage: 4 });
      expect(firstResult.destroyed).toBe(true);
      destroyedIds.push(barrels[0].id);
      if (firstResult.shouldExplode) {
        chainExplode(barrels[0], 1);
      }

      expect(destroyedIds.length).toBe(6);
    });
  });

  // Map-polish ticket 07 — the light-prop fixture entity (sconce/brazier/
  // crystal). maxHp 1 (any single hit smashes it), no explosion, no loot
  // (the loot branch keys on type === 'crate' only). GDD-silent values
  // flagged for owner ratification (ticket 09's GDD §5.5 amendment).
  describe('light', () => {
    it('has 1 HP', () => {
      const light = Destructible.create('l1', 'light', new Position(0, 0));
      expect(light.maxHp).toBe(1);
      expect(light.hp).toBe(1);
    });

    it('is destroyed by any single melee hit', () => {
      const light = Destructible.create('l1', 'light', new Position(0, 0));
      const result = light.takeDamage({ source: 'melee', rawDamage: 1 });
      expect(result.destroyed).toBe(true);
      expect(result.shouldExplode).toBe(false);
      expect(light.isDestroyed).toBe(true);
    });

    it('is destroyed by thrown/arrow/explosion sources without exploding', () => {
      for (const source of ['thrown', 'arrow', 'explosion'] as const) {
        const light = Destructible.create('l1', 'light', new Position(0, 0));
        const result = light.takeDamage({ source, rawDamage: 1 });
        expect(result.destroyed).toBe(true);
        expect(result.shouldExplode).toBe(false);
      }
    });

    // Map-polish ticket 09 (sanctioned micro-improvement): the loot sweep's
    // tick-1 guard + the hurtbox contact fallback key on this property, not
    // the type string — future non-solid destructible types inherit both.
    it('is nonSolid; every other destructible type is solid', () => {
      expect(Destructible.create('l1', 'light', new Position(0, 0)).nonSolid).toBe(true);
      for (const type of ['crate', 'barrel', 'wall', 'iron'] as const) {
        expect(Destructible.create(`s-${type}`, type, new Position(0, 0)).nonSolid).toBe(false);
      }
    });
  });

  describe('wall', () => {
    it('has 10 HP', () => {
      const wall = Destructible.create('w1', 'wall', new Position(0, 0));
      expect(wall.maxHp).toBe(10);
      expect(wall.hp).toBe(10);
    });

    it('takes 2 melee hits to destroy', () => {
      const wall = Destructible.create('w1', 'wall', new Position(0, 0));
      const result = wall.takeDamage({ source: 'melee', rawDamage: 5 });
      expect(result.destroyed).toBe(false);
      expect(result.shouldExplode).toBe(false);

      const finalResult = wall.takeDamage({ source: 'melee', rawDamage: 5 });
      expect(finalResult.destroyed).toBe(true);
      expect(finalResult.shouldExplode).toBe(false);
      expect(wall.isDestroyed).toBe(true);
    });

    it('does not trigger explosion when destroyed', () => {
      const wall = Destructible.create('w1', 'wall', new Position(0, 0));
      const result = wall.takeDamage({ source: 'explosion', rawDamage: 50 });
      expect(result.destroyed).toBe(true);
      expect(result.shouldExplode).toBe(false);
    });

    it('takes full raw damage from explosion source', () => {
      const wall = Destructible.create('w1', 'wall', new Position(0, 0));
      const result = wall.takeDamage({ source: 'explosion', rawDamage: 50 });
      expect(result.destroyed).toBe(true);
      expect(wall.hp).toBe(0);
    });

    it('returns idempotent result when damaged after destruction', () => {
      const wall = Destructible.create('w1', 'wall', new Position(0, 0));
      wall.takeDamage({ source: 'explosion', rawDamage: 50 });
      const result = wall.takeDamage({ source: 'melee', rawDamage: 5 });
      expect(result.destroyed).toBe(true);
      expect(result.shouldExplode).toBe(false);
    });

    it('takes 3 HP from arrow hit', () => {
      const wall = Destructible.create('w1', 'wall', new Position(0, 0));
      const result = wall.takeDamage({ source: 'arrow', rawDamage: 3 });
      expect(result.destroyed).toBe(false);
      expect(wall.hp).toBe(7);
    });

    it('takes 4 HP from thrown weapon', () => {
      const wall = Destructible.create('w1', 'wall', new Position(0, 0));
      const result = wall.takeDamage({ source: 'thrown', rawDamage: 4 });
      expect(result.destroyed).toBe(false);
      expect(wall.hp).toBe(6);
    });

    it('takes 1 HP from other source', () => {
      const wall = Destructible.create('w1', 'wall', new Position(0, 0));
      const result = wall.takeDamage({ source: 'other', rawDamage: 1 });
      expect(result.destroyed).toBe(false);
      expect(wall.hp).toBe(9);
    });
  });

  describe('static create', () => {
    it('creates with correct defaults', () => {
      const d = Destructible.create('test', 'crate', new Position(10, 20));
      expect(d.id).toBe('test');
      expect(d.type).toBe('crate');
      expect(d.position.x).toBe(10);
      expect(d.position.y).toBe(20);
      expect(d.isDestroyed).toBe(false);
      expect(d.hp).toBe(2);
    });

    it('creates barrel with 2 HP', () => {
      const d = Destructible.create('d2', 'barrel', new Position(10, 10));
      expect(d.id).toBe('d2');
      expect(d.type).toBe('barrel');
      expect(d.hp).toBe(2);
      expect(d.maxHp).toBe(2);
      expect(d.isDestroyed).toBe(false);
    });

    it('creates wall with 10 HP', () => {
      const d = Destructible.create('d3', 'wall', new Position(20, 20));
      expect(d.hp).toBe(10);
      expect(d.maxHp).toBe(10);
      expect(d.isDestroyed).toBe(false);
    });

    it('creates iron with infinite HP', () => {
      const d = Destructible.create('d4', 'iron', new Position(30, 30));
      expect(d.hp).toBe(Infinity);
      expect(d.maxHp).toBe(Infinity);
      expect(d.isDestroyed).toBe(false);
    });
  });

  describe('crate loot drop', () => {
    it('has CRATE_LOOT_DROP_CHANCE of 0.6', () => {
      expect(Destructible.CRATE_LOOT_DROP_CHANCE).toBe(0.6);
    });

    it('matches shared CRATE_LOOT.DROP_CHANCE', () => {
      expect(Destructible.CRATE_LOOT_DROP_CHANCE).toBe(CRATE_LOOT.DROP_CHANCE);
    });
  });

  describe('damage context rules', () => {
    it('TestMeleeDamage_flatBarrelOverride: melee deals exactly 1 HP to barrels regardless of weapon', () => {
      const fists: DestructibleDamageContext = { source: 'melee', rawDamage: 1, currentTick: 0 };
      const axe: DestructibleDamageContext = { source: 'melee', rawDamage: 3, currentTick: 0 };

      const barrel1 = Destructible.create('b1', 'barrel', new Position(0, 0));
      const r1 = barrel1.takeDamage(fists);
      expect(r1.destroyed).toBe(false);
      expect(barrel1.hp).toBe(1);
      expect(barrel1.primed).toBe(true);

      const barrel2 = Destructible.create('b2', 'barrel', new Position(0, 0));
      const r2 = barrel2.takeDamage(axe);
      expect(r2.destroyed).toBe(false);
      expect(barrel2.hp).toBe(1);
      expect(barrel2.primed).toBe(true);
    });

    it('TestExplosionDamage_fullPassThrough: barrel explosion passes raw damage unmodified', () => {
      const barrel = Destructible.create('b1', 'barrel', new Position(0, 0));
      const result = barrel.takeDamage({ source: 'explosion', rawDamage: 50 });
      expect(result.destroyed).toBe(true);
      expect(result.shouldExplode).toBe(true);
      expect(barrel.hp).toBe(0);
    });

    it('TestArrowHitBarrel_killingBlow: arrow delivers killing blow to barrel at 1 HP, triggers explosion chain', () => {
      const barrel = Destructible.create('b1', 'barrel', new Position(0, 0));
      barrel.takeDamage({ source: 'melee', rawDamage: 3, currentTick: 0 });
      expect(barrel.hp).toBe(1);

      const result = barrel.takeDamage({ source: 'arrow', rawDamage: 10, currentTick: 1 });
      expect(result.destroyed).toBe(true);
      expect(result.shouldExplode).toBe(true);
    });

    it('TestIron_takesNoDamage: iron takes 0 damage from all sources including explosion', () => {
      const iron = Destructible.create('i1', 'iron', new Position(0, 0));
      const r1 = iron.takeDamage({ source: 'melee', rawDamage: 30 });
      expect(r1.destroyed).toBe(false);
      expect(iron.hp).toBe(Infinity);

      const r2 = iron.takeDamage({ source: 'explosion', rawDamage: 100 });
      expect(r2.destroyed).toBe(false);
      expect(iron.hp).toBe(Infinity);

      const r3 = iron.takeDamage({ source: 'arrow', rawDamage: 50 });
      expect(r3.destroyed).toBe(false);
      expect(iron.hp).toBe(Infinity);
    });

    it('TestThrown_countsAsBounce: thrown weapon deals exactly 1 HP per collision (barrel override)', () => {
      const barrel = Destructible.create('b1', 'barrel', new Position(0, 0));
      const result = barrel.takeDamage({ source: 'thrown', rawDamage: 1, currentTick: 0 });
      expect(result.destroyed).toBe(false);
      expect(barrel.hp).toBe(1);
    });

    it('TestAlreadyDestroyed_idempotent: calling takeDamage on destroyed destructible returns destroyed true', () => {
      const crate = Destructible.create('c1', 'crate', new Position(0, 0));
      crate.takeDamage({ source: 'melee', rawDamage: 5 });
      expect(crate.isDestroyed).toBe(true);

      const result = crate.takeDamage({ source: 'melee', rawDamage: 5 });
      expect(result.destroyed).toBe(true);
      expect(result.shouldExplode).toBe(false);
    });

    it('TestUnknownSource_usesRawDamage: other source deals rawDamage to destructibles (no barrel flat override)', () => {
      const barrel = Destructible.create('b1', 'barrel', new Position(0, 0));
      const result = barrel.takeDamage({ source: 'other', rawDamage: 1, currentTick: 0 });
      expect(result.destroyed).toBe(false);
      expect(barrel.hp).toBe(1);
    });
  });
});
