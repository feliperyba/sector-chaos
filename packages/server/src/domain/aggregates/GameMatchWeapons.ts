import {
  WeaponType,
  WeaponTier,
  PLAYER,
  DURABILITY_BY_TIER,
  weaponRegistry,
  AttackType,
  NETWORK,
  type IdGenerator,
} from '@sector-battle/shared';
import { Position } from '../value-objects/index.ts';
import { Player, WeaponEntity, Projectile } from '../entities/index.ts';
import type { GameEvent } from '../events/index.ts';
import type { WeaponBrokenEvent } from '../events/WeaponBroken.ts';

export function isShieldWeapon(weaponType: WeaponType): boolean {
  const definition = weaponRegistry.getDefinition(weaponType);
  return definition?.baseStats.attackType === AttackType.SHIELD;
}

export function handleWeaponBreak(
  deps: {
    players: Map<string, Player>;
    tick: number;
    eventCollector: { emit(event: GameEvent): void };
  },
  playerId: string,
  slotIndex: number,
): GameEvent[] {
  const player = deps.players.get(playerId);
  if (!player || !player.isActive) return [];

  const weapon = player.inventory.weapons[slotIndex];
  if (!weapon || weapon.type === WeaponType.FISTS) return [];

  const isShield = isShieldWeapon(weapon.type);
  const weaponType = weapon.type;
  const x = player.movement.position.x;
  const y = player.movement.position.y;

  player.onWeaponBreak(slotIndex, isShield, 60);

  const event: WeaponBrokenEvent = {
    type: 'WeaponBroken',
    playerId,
    weaponType,
    slotIndex,
    x,
    y,
    tick: deps.tick,
    timestamp: Date.now(),
  };
  deps.eventCollector.emit(event);

  return [event];
}

export function dropPlayerWeapons(
  deps: {
    players: Map<string, Player>;
    idGenerator: IdGenerator;
  },
  playerId: string,
  addWeaponPickupFn: (id: string, weapon: WeaponEntity, pos: Position) => void,
): void {
  const player = deps.players.get(playerId);
  if (!player) return;

  const baseX = player.movement.position.x;
  const baseY = player.movement.position.y;
  const offset = 32;

  for (let i = 1; i < PLAYER.INVENTORY_SIZE; i++) {
    const weapon = player.inventory.weapons[i];
    if (!weapon) continue;
    player.inventory.weapons[i] = null;

    const pickupId = deps.idGenerator.next();
    const angle = (i - 1) * ((Math.PI * 2) / 3);
    const px = baseX + Math.cos(angle) * offset;
    const py = baseY + Math.sin(angle) * offset;
    const pickupWeapon = new WeaponEntity(
      pickupId,
      weapon.type,
      weapon.tier,
      weapon.ammo,
      weapon.maxAmmo,
      weapon.cooldown,
    );
    addWeaponPickupFn(pickupId, pickupWeapon, new Position(px, py));
  }

  player.inventory.activeSlot = 0;
}

export function dropBoomerangsForDeadPlayer(
  deps: {
    players: Map<string, Player>;
    projectiles: Map<string, Projectile>;
    idGenerator: IdGenerator;
  },
  playerId: string,
  addWeaponPickupFn: (id: string, weapon: WeaponEntity, pos: Position) => void,
  removeProjectileFn: (id: string) => void,
): void {
  const player = deps.players.get(playerId);
  if (!player) return;

  const toDrop: string[] = [];
  for (const projId of player.combat.throwsInFlight) {
    const projectile = deps.projectiles.get(projId);
    if (projectile && projectile.isBoomerang) {
      const definition = weaponRegistry.getDefinition(projectile.weaponType);
      const tier = definition.tier ?? WeaponTier.COMMON;
      const maxAmmo = DURABILITY_BY_TIER[tier];
      const cooldownTicks = Math.ceil(definition.baseStats.cooldown / NETWORK.TICK_INTERVAL);
      const pickupId = deps.idGenerator.next();
      const weapon = new WeaponEntity(
        pickupId,
        projectile.weaponType,
        tier,
        projectile.durability,
        maxAmmo,
        cooldownTicks,
      );
      addWeaponPickupFn(
        pickupId,
        weapon,
        new Position(projectile.position.x, projectile.position.y),
      );
      toDrop.push(projId);
    }
  }

  for (const id of toDrop) {
    removeProjectileFn(id);
    player.combat.throwsInFlight.delete(id);
  }
  player.combat.throwsInFlight.clear();
}

// ─── GameMatch delegate wrappers ───────────────────────────────────────────
// Mechanical extraction: bodies verbatim, `this.X` → `match.X`.

import type { EventCollector } from '../shared/EventCollector.ts';
import type { GameMatch } from './GameMatch.ts';

/** Mirrors the GameMatch.handleWeaponBreak method body, parameterized on match. */
export function handleWeaponBreakForMatch(
  match: GameMatch,
  playerId: string,
  slotIndex: number,
): GameEvent[] {
  return handleWeaponBreak(
    { players: match.players, tick: match.tick, eventCollector: match.eventCollector },
    playerId,
    slotIndex,
  );
}

export function dropPlayerWeaponsForMatch(match: GameMatch, playerId: string): void {
  dropPlayerWeapons(
    { players: match.players, idGenerator: match.idGenerator },
    playerId,
    (id, w, p) => match.addWeaponPickup(id, w, p),
  );
}

export function dropBoomerangsForDeadPlayerForMatch(match: GameMatch, playerId: string): void {
  dropBoomerangsForDeadPlayer(
    { players: match.players, projectiles: match.projectiles, idGenerator: match.idGenerator },
    playerId,
    (id, w, p) => match.addWeaponPickup(id, w, p),
    (id) => match.removeProjectile(id),
  );
}

export type { EventCollector };
