/**
 * Pure TS-only runtime validator for the Weapon subsystem's three parallel
 * sources of truth: the {@link WeaponType} enum, the `ALL_WEAPON_TYPES`
 * spawnable-types array, and the `getDefaultDefinitions()` Map.
 *
 * TS-only by design — {@link https://github.com/.../FILE_CONSTRAINTS #7} forbids
 * new runtime deps in `@sector-battle/shared` (no Zod, no class-validator,
 * no reflect-metadata). Same precedent as tickets #05/#08.
 *
 * Called once from the {@link WeaponRegistry} constructor; throws on the first
 * violation with a descriptive message so bad definitions fail fast at module
 * load, not deep inside gameplay code.
 */
import { AttackType } from '../enums/AttackType.js';
import { WeaponType } from '../enums/WeaponType.js';
import type { WeaponDefinition } from './Weapon.js';

/** Human-readable name for a definition, used in error messages. */
function describeWeapon(def: WeaponDefinition): string {
  return `${WeaponType[def.type] ?? def.type} (AttackType.${def.attackType})`;
}

/**
 * Returns the numeric values of the {@link WeaponType} enum. TS string-enums
 * would produce values directly, but {@link WeaponType} is a numeric enum, so
 * `Object.values` includes reverse-mapping string keys — filter those out.
 */
function getAllWeaponTypeValues(): WeaponType[] {
  return Object.values(WeaponType).filter((v): v is WeaponType => typeof v === 'number');
}

/**
 * Check #1 + #3: triad coverage. Every `WeaponType` enum value must have a map
 * entry (#1), and `allSpawnableTypes` must NOT include {@link WeaponType.FISTS}
 * (#3 — FISTS is the bare-handed fallback, never spawned as loot).
 */
function checkTriad(
  definitions: Map<WeaponType, WeaponDefinition>,
  allSpawnableTypes: readonly WeaponType[],
): void {
  for (const type of getAllWeaponTypeValues()) {
    if (!definitions.has(type)) {
      throw new Error(
        `Weapon definition invalid: missing definition for WeaponType.${WeaponType[type]}`,
      );
    }
  }
  if (allSpawnableTypes.includes(WeaponType.FISTS)) {
    throw new Error(
      'Weapon definition invalid: ALL_WEAPON_TYPES must not include WeaponType.FISTS',
    );
  }
}

/**
 * Check #2 + #4 + #5: every map key is a valid enum value, the stored
 * definition's `type` field matches the map key, and the top-level
 * `attackType` agrees with `baseStats.attackType`.
 */
function checkSelfConsistency(def: WeaponDefinition, key: WeaponType): void {
  if (
    !Object.values(WeaponType)
      .filter((v): v is WeaponType => typeof v === 'number')
      .includes(key)
  ) {
    throw new Error(`Weapon definition invalid: map key ${key} is not a valid WeaponType`);
  }
  if (def.type !== key) {
    throw new Error(
      `Weapon definition invalid: ${WeaponType[key]} entry has def.type ${WeaponType[def.type] ?? def.type}`,
    );
  }
  if (def.attackType !== def.baseStats.attackType) {
    throw new Error(
      `Weapon definition invalid: ${describeWeapon(def)} top-level attackType ${def.attackType} disagrees with baseStats.attackType ${def.baseStats.attackType}`,
    );
  }
}

/**
 * Check #6: per-{@link AttackType} required fields on `baseStats`. Each shape
 * uses different gameplay code paths (arc swing vs projectile vs shield block)
 * and silently missing the key field produces subtle runtime bugs.
 */
function checkPerAttackTypeFields(def: WeaponDefinition): void {
  const s = def.baseStats;
  const requirePositive = (value: number | undefined, field: string): void => {
    if (value === undefined || value <= 0) {
      throw new Error(
        `Weapon definition invalid: ${describeWeapon(def)} is missing required field '${field}'`,
      );
    }
  };
  const requireNonNegative = (value: number | undefined, field: string): void => {
    if (value === undefined || value < 0) {
      throw new Error(
        `Weapon definition invalid: ${describeWeapon(def)} is missing required field '${field}'`,
      );
    }
  };
  switch (s.attackType) {
    case AttackType.ARC:
      requirePositive(s.arcAngle, 'arcAngle');
      break;
    case AttackType.RANGED:
      requirePositive(s.projectileSpeed, 'projectileSpeed');
      break;
    case AttackType.THROWN:
      requirePositive(s.throwSpeed, 'throwSpeed');
      requirePositive(s.throwRange, 'throwRange');
      break;
    case AttackType.SHIELD:
      requireNonNegative(s.blockReduction, 'blockReduction');
      requireNonNegative(s.blockArcDegrees, 'blockArcDegrees');
      break;
    case AttackType.LINE:
      // No AttackType.LINE-specific required fields today.
      break;
  }
}

/**
 * Check #7: sanity bounds for shared numeric stats. These are invariants every
 * weapon must satisfy regardless of AttackType — e.g. a zero cooldown would
 * let a weapon fire every tick.
 */
function checkSanityBounds(def: WeaponDefinition): void {
  const s = def.baseStats;
  const fail = (field: string): never => {
    throw new Error(
      `Weapon definition invalid: ${describeWeapon(def)} has out-of-bounds '${field}'`,
    );
  };
  if (s.damage < 0) fail('damage');
  if (s.range <= 0) fail('range');
  if (s.cooldown <= 0) fail('cooldown');
  if (s.windupMs < 0) fail('windupMs');
  if (s.weightTier < 0) fail('weightTier');
  if (s.knockback < 0) fail('knockback');
  if (s.destructibleDamage < 0) fail('destructibleDamage');
  if (def.durabilityMultiplier !== undefined && def.durabilityMultiplier <= 0) {
    fail('durabilityMultiplier');
  }
}

/**
 * Check #8: FISTS invariants. The bare-handed fallback weapon must have
 * `tier === null` (it is never tier-rolled) and `canThrow === false` (no throw
 * animation/sprite exists for fists).
 */
function checkFistsInvariants(def: WeaponDefinition): void {
  if (def.type !== WeaponType.FISTS) return;
  if (def.tier !== null) {
    throw new Error(`Weapon definition invalid: ${describeWeapon(def)} must have tier === null`);
  }
  if (def.canThrow) {
    throw new Error(
      `Weapon definition invalid: ${describeWeapon(def)} must have canThrow === false`,
    );
  }
}

/**
 * Validates a Weapon definitions Map plus the spawnable-types list. Throws a
 * descriptive `Error` on the first violation; returns void on success.
 *
 * Per-definition checks (self-consistency, per-AttackType fields, sanity
 * bounds, FISTS invariants) run before the triad-coverage check, so a malformed
 * individual definition surfaces its specific error before the coarser
 * "missing entry" message. Runs once at {@link WeaponRegistry} construction
 * time, so a faulty definitions.ts fails the process at boot rather than
 * mid-combat.
 *
 * @param definitions - The full `WeaponType -> WeaponDefinition` map (must
 *   contain one entry per `WeaponType` enum value, including FISTS).
 * @param allSpawnableTypes - The exported `ALL_WEAPON_TYPES` array — every
 *   lootable/spawnable weapon. Must NOT include `WeaponType.FISTS`.
 */
export function validateWeaponDefinitions(
  definitions: Map<WeaponType, WeaponDefinition>,
  allSpawnableTypes: readonly WeaponType[],
): void {
  for (const [key, def] of definitions) {
    checkSelfConsistency(def, key);
    checkPerAttackTypeFields(def);
    checkSanityBounds(def);
    checkFistsInvariants(def);
  }
  checkTriad(definitions, allSpawnableTypes);
}
