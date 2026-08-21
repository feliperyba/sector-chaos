import { describe, expect, it } from 'vitest';
import { WeaponType } from '../src/enums/WeaponType.js';
import { AttackType } from '../src/enums/AttackType.js';
import { MatchPhase } from '../src/enums/MatchPhase.js';
import { TileType } from '../src/enums/TileType.js';
import { DamageType } from '../src/enums/DamageType.js';
import { InputAction } from '../src/enums/InputAction.js';
import { TrapType } from '../src/enums/TrapType.js';
import { ChestRarity } from '../src/enums/ChestRarity.js';
import { WeaponTier } from '../src/enums/WeaponTier.js';
import { PowerUpType } from '../src/enums/PowerUpType.js';
import { EntityType } from '../src/enums/EntityType.js';
import { PlayerStatus } from '../src/enums/PlayerStatus.js';
import { Direction } from '../src/enums/Direction.js';

function numericEnumMemberCount(e: object): number {
  return Object.keys(e).filter((k) => isNaN(Number(k))).length;
}

describe('WeaponType', () => {
  it('has 16 enum members', () => {
    expect(numericEnumMemberCount(WeaponType)).toBe(16);
  });

  it('has sequential numeric IDs 0-15', () => {
    expect(WeaponType.FISTS).toBe(0);
    expect(WeaponType.DAGGER).toBe(1);
    expect(WeaponType.SHORT_SWORD).toBe(2);
    expect(WeaponType.LONG_SWORD).toBe(3);
    expect(WeaponType.HAMMER).toBe(4);
    expect(WeaponType.LARGE_AXE).toBe(5);
    expect(WeaponType.BLADED_AXE).toBe(6);
    expect(WeaponType.DOUBLE_AXE).toBe(7);
    expect(WeaponType.SPEAR).toBe(8);
    expect(WeaponType.POLEARM).toBe(9);
    expect(WeaponType.STAFF).toBe(10);
    expect(WeaponType.THROWING_AXE).toBe(11);
    expect(WeaponType.SHORT_BOW).toBe(12);
    expect(WeaponType.CROSSBOW).toBe(13);
    expect(WeaponType.SMALL_SHIELD).toBe(14);
    expect(WeaponType.LARGE_SHIELD).toBe(15);
  });

  it('has no duplicate values', () => {
    const vals = [
      WeaponType.FISTS,
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
      WeaponType.SHORT_BOW,
      WeaponType.CROSSBOW,
      WeaponType.SMALL_SHIELD,
      WeaponType.LARGE_SHIELD,
    ];
    expect(new Set(vals).size).toBe(16);
  });

  it('has reverse mappings for numeric enum', () => {
    expect((WeaponType as Record<string, number>)[0]).toBe('FISTS');
    expect((WeaponType as Record<string, number>)[15]).toBe('LARGE_SHIELD');
  });

  it('ARC weapons are FISTS through DOUBLE_AXE (0-7)', () => {
    const arcWeapons = [
      WeaponType.FISTS,
      WeaponType.DAGGER,
      WeaponType.SHORT_SWORD,
      WeaponType.LONG_SWORD,
      WeaponType.HAMMER,
      WeaponType.LARGE_AXE,
      WeaponType.BLADED_AXE,
      WeaponType.DOUBLE_AXE,
    ];
    expect(arcWeapons).toHaveLength(8);
    arcWeapons.forEach((w) => {
      expect(w).toBeGreaterThanOrEqual(0);
      expect(w).toBeLessThanOrEqual(7);
    });
  });

  it('LINE weapons are SPEAR, POLEARM, STAFF (8-10)', () => {
    expect(WeaponType.SPEAR).toBe(8);
    expect(WeaponType.POLEARM).toBe(9);
    expect(WeaponType.STAFF).toBe(10);
  });

  it('THROWN weapon is THROWING_AXE (11)', () => {
    expect(WeaponType.THROWING_AXE).toBe(11);
  });

  it('RANGED weapons are SHORT_BOW, CROSSBOW (12-13)', () => {
    expect(WeaponType.SHORT_BOW).toBe(12);
    expect(WeaponType.CROSSBOW).toBe(13);
  });

  it('SHIELD weapons are SMALL_SHIELD, LARGE_SHIELD (14-15)', () => {
    expect(WeaponType.SMALL_SHIELD).toBe(14);
    expect(WeaponType.LARGE_SHIELD).toBe(15);
  });
});

describe('AttackType', () => {
  it('has correct string values', () => {
    expect(AttackType.ARC).toBe('arc');
    expect(AttackType.LINE).toBe('line');
    expect(AttackType.THROWN).toBe('thrown');
    expect(AttackType.RANGED).toBe('ranged');
    expect(AttackType.SHIELD).toBe('shield');
  });

  it('has 5 distinct values', () => {
    const vals = [
      AttackType.ARC,
      AttackType.LINE,
      AttackType.THROWN,
      AttackType.RANGED,
      AttackType.SHIELD,
    ];
    expect(new Set(vals).size).toBe(5);
  });

  it('has no reverse mappings (string enum)', () => {
    const at = AttackType as unknown as Record<string, string>;
    expect(at['arc']).toBeUndefined();
    expect(at['line']).toBeUndefined();
  });
});

describe('MatchPhase', () => {
  it('has correct numeric values', () => {
    expect(MatchPhase.WAITING).toBe(0);
    expect(MatchPhase.COUNTDOWN).toBe(1);
    expect(MatchPhase.ACTIVE).toBe(2);
    expect(MatchPhase.ZONE_SHRINKING).toBe(3);
    expect(MatchPhase.OVERTIME).toBe(6);
    expect(MatchPhase.FINAL_CLOSURE).toBe(7);
    expect(MatchPhase.FINISHED).toBe(5);
  });

  it('has 7 enum members', () => {
    expect(numericEnumMemberCount(MatchPhase)).toBe(7);
  });

  it('has a gap at value 4', () => {
    const values = Object.values(MatchPhase).filter((v) => typeof v === 'number') as number[];
    expect(values).not.toContain(4);
  });
});

describe('TileType', () => {
  it('has correct numeric values', () => {
    expect(TileType.EMPTY).toBe(0);
    expect(TileType.INDESTRUCTIBLE_WALL).toBe(1);
    expect(TileType.DESTRUCTIBLE_WALL).toBe(2);
    expect(TileType.CHEST).toBe(3);
    expect(TileType.EXIT).toBe(4);
    expect(TileType.DOOR_CLOSED).toBe(5);
    expect(TileType.DESTRUCTIBLE_CRATE).toBe(6);
    expect(TileType.DESTRUCTIBLE_BARREL).toBe(7);
    expect(TileType.INDESTRUCTIBLE_CRATE).toBe(8);
  });

  it('has 9 enum members', () => {
    expect(numericEnumMemberCount(TileType)).toBe(9);
  });

  it('has no gaps in values', () => {
    const values = Object.values(TileType).filter((v) => typeof v === 'number') as number[];
    expect(values).toContain(5);
  });
});

describe('DamageType', () => {
  it('has 9 string-valued members', () => {
    expect(DamageType.BARREL_EXPLOSION).toBe('barrel_explosion');
    expect(DamageType.PROJECTILE_HIT).toBe('projectile_hit');
    expect(DamageType.ZONE_DAMAGE).toBe('zone_damage');
    expect(DamageType.TRAP_DAMAGE).toBe('trap_damage');
    expect(DamageType.MELEE_HIT).toBe('melee_hit');
    expect(DamageType.SUDDEN_DEATH).toBe('sudden_death');
    expect(DamageType.SIEGE_CRUSH).toBe('siege_crush');
    expect(DamageType.RANGED_HIT).toBe('ranged_hit');
    expect(DamageType.THROWN_HIT).toBe('thrown_hit');
    expect(Object.keys(DamageType)).toHaveLength(9);
  });

  it('has no reverse mappings (string enum)', () => {
    const dt = DamageType as unknown as Record<string, string>;
    expect(dt['barrel_explosion']).toBeUndefined();
  });
});

describe('InputAction', () => {
  it('has correct sequential values 0-5', () => {
    expect(InputAction.MOVE).toBe(0);
    expect(InputAction.ATTACK).toBe(1);
    expect(InputAction.THROW).toBe(2);
    expect(InputAction.PICKUP).toBe(3);
    expect(InputAction.SWITCH_SLOT).toBe(4);
    expect(InputAction.DASH).toBe(5);
  });

  it('has 6 enum members', () => {
    expect(numericEnumMemberCount(InputAction)).toBe(6);
  });
});

describe('TrapType', () => {
  it('has correct sequential values 0-2', () => {
    expect(TrapType.SPIKE).toBe(0);
    expect(TrapType.FIRE).toBe(1);
    expect(TrapType.TELEPORT).toBe(2);
  });

  it('has 3 enum members', () => {
    expect(numericEnumMemberCount(TrapType)).toBe(3);
  });
});

describe('ChestRarity', () => {
  it('has correct sequential values 0-3', () => {
    expect(ChestRarity.COMMON).toBe(0);
    expect(ChestRarity.RARE).toBe(1);
    expect(ChestRarity.EPIC).toBe(2);
    expect(ChestRarity.LEGENDARY).toBe(3);
  });

  it('has 4 enum members', () => {
    expect(numericEnumMemberCount(ChestRarity)).toBe(4);
  });
});

describe('WeaponTier', () => {
  it('has correct string values', () => {
    expect(WeaponTier.COMMON).toBe('common');
    expect(WeaponTier.UNCOMMON).toBe('uncommon');
    expect(WeaponTier.RARE).toBe('rare');
    expect(WeaponTier.LEGENDARY).toBe('legendary');
  });

  it('has 4 enum members', () => {
    expect(Object.keys(WeaponTier)).toHaveLength(4);
  });

  it('has no reverse mappings (string enum)', () => {
    const wt = WeaponTier as unknown as Record<string, string>;
    expect(wt['common']).toBeUndefined();
  });
});

describe('PowerUpType', () => {
  it('has correct sequential values 0-2', () => {
    expect(PowerUpType.HEALTH_PACK).toBe(0);
    expect(PowerUpType.BARRIER).toBe(1);
    expect(PowerUpType.SPEED_BOOST).toBe(2);
  });

  it('has 3 enum members', () => {
    expect(numericEnumMemberCount(PowerUpType)).toBe(3);
  });
});

describe('EntityType', () => {
  it('has correct sequential values 0-8', () => {
    expect(EntityType.PLAYER).toBe(0);
    expect(EntityType.PROJECTILE).toBe(1);
    expect(EntityType.POWERUP).toBe(2);
    expect(EntityType.TRAP).toBe(3);
    expect(EntityType.CHEST).toBe(4);
    expect(EntityType.DESTRUCTIBLE).toBe(5);
    expect(EntityType.EXIT_DOOR).toBe(6);
    expect(EntityType.EXPLOSION).toBe(7);
    expect(EntityType.WEAPON_PICKUP).toBe(8);
  });

  it('has 9 enum members', () => {
    expect(numericEnumMemberCount(EntityType)).toBe(9);
  });
});

describe('PlayerStatus', () => {
  it('has correct bitmask values', () => {
    expect(PlayerStatus.ALIVE).toBe(1);
    expect(PlayerStatus.DEAD).toBe(2);
    expect(PlayerStatus.SPECTATING).toBe(4);
    expect(PlayerStatus.INVINCIBLE).toBe(8);
    expect(PlayerStatus.STAGGERED).toBe(16);
    expect(PlayerStatus.FRESH_SPAWN).toBe(32);
    expect(PlayerStatus.DYING).toBe(64);
  });

  it('all values are powers of 2', () => {
    const values = Object.values(PlayerStatus);
    for (const v of values) {
      expect(v).toBeGreaterThan(0);
      expect((v & (v - 1)) === 0).toBe(true);
    }
  });

  it('can combine with bitwise OR', () => {
    expect(PlayerStatus.ALIVE | PlayerStatus.INVINCIBLE).toBe(9);
  });

  it('can test with bitwise AND', () => {
    const combined = PlayerStatus.ALIVE | PlayerStatus.INVINCIBLE;
    expect((combined & PlayerStatus.INVINCIBLE) !== 0).toBe(true);
    expect((combined & PlayerStatus.DEAD) !== 0).toBe(false);
  });

  it('has 7 members', () => {
    expect(Object.keys(PlayerStatus)).toHaveLength(7);
  });
});

describe('Direction', () => {
  it('has correct values', () => {
    expect(Direction.NONE).toBe(0);
    expect(Direction.UP).toBe(1);
    expect(Direction.DOWN).toBe(2);
    expect(Direction.LEFT).toBe(3);
    expect(Direction.RIGHT).toBe(4);
  });

  it('has 5 enum members', () => {
    expect(numericEnumMemberCount(Direction)).toBe(5);
  });
});
