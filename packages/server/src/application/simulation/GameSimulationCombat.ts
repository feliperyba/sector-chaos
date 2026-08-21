import {
  PLAYER,
  SIM_TICK_DT,
  NETWORK,
  weaponRegistry,
  DURABILITY_BY_TIER,
  WeaponType,
  type WeaponTier,
} from '@sector-battle/shared';
import type { GameMatch } from '../../domain/aggregates/GameMatch.ts';
import type { IMovementService } from '../../domain/services/index.ts';
import type { ZoneService } from '../../domain/services/index.ts';
import { DeathResolutionService } from '../../domain/services/DeathResolutionService.ts';
import { WeaponEntity } from '../../domain/entities/index.ts';
import type { Projectile } from '../../domain/entities/index.ts';
import type { GameEvent } from '../../domain/events/index.ts';
import { Position } from '../../domain/value-objects/index.ts';
import { AttackCommand } from '../commands/index.ts';
import type { PickupPowerUpCommand } from '../commands/index.ts';
import { ShieldHandler } from '../../domain/handlers/ShieldHandler.ts';
import type { LootHandlerContext } from './GameSimulationLoot.ts';
import type { ActiveDash } from './GameSimulationInput.ts';
import { processDestroyedDestructibles } from './GameSimulationLoot.ts';
import type { Player } from '../../domain/entities/Player.ts';

export interface SimulationStepDeps {
  match: GameMatch;
  movementService: IMovementService;
  attackCommand: AttackCommand;
  pickupCommand: PickupPowerUpCommand;
  deathResolution: DeathResolutionService;
  shieldHandler: ShieldHandler;
  lootCtx: LootHandlerContext;
  /**
   * server-alive-scratch-hoist: the per-tick alive array built once at the top
   * of GameSimulation.step() (players-Map insertion order). Valid only while
   * that step() is on the stack — see GameSimulation._alivePlayers for the
   * within-tick aliveness invariant (steps 3-8 cannot observe an aliveness
   * change; the ALIVE bit flips in step9).
   */
  alivePlayers: Player[];
  checkTrapWalkOver: (playerId: string) => void;
  checkPowerUpWalkOver: (playerId: string) => void;
  markPlayerDead: (id: string) => void;
}

export function step3_ResolveMeleeRanged(deps: SimulationStepDeps, tick: number): void {
  // Swept melee: resolve active swings against this tick's simulated weapon
  // segments (stepped in step 2.5) before loot processing.
  deps.attackCommand.getMeleeSweepHandler()?.tick(tick);
  processDestroyedDestructibles(deps.lootCtx);
}

export function step4_AdvanceProjectiles(deps: SimulationStepDeps, _tick: number): void {
  const projectileEvents = deps.match.updateProjectiles(
    SIM_TICK_DT,
    (projectile: Projectile, position: { x: number; y: number }) => {
      const definition = weaponRegistry.getDefinition(projectile.weaponType);
      const tier = projectile.tier as WeaponTier;
      const ammo = DURABILITY_BY_TIER[tier];
      const cooldownTicks = Math.ceil(definition.baseStats.cooldown / NETWORK.TICK_INTERVAL);
      const pickupId = deps.lootCtx.lootIdGen.next();
      const weapon = new WeaponEntity(
        pickupId,
        projectile.weaponType,
        tier,
        projectile.durability,
        ammo,
        cooldownTicks,
      );
      deps.match.addWeaponPickup(pickupId, weapon, new Position(position.x, position.y));
    },
    (
      weaponType: WeaponType,
      durability: number,
      targetPlayerId: string,
      originalSlot: number,
      tier: WeaponTier,
    ) => {
      const player = deps.match.getPlayer(targetPlayerId);
      if (!player || !player.isActive) return;
      const definition = weaponRegistry.getDefinition(weaponType);
      const maxAmmo = DURABILITY_BY_TIER[tier];
      const cooldownTicks = Math.ceil(definition.baseStats.cooldown / NETWORK.TICK_INTERVAL);
      const weaponId = deps.lootCtx.lootIdGen.next();
      const weapon = new WeaponEntity(
        weaponId,
        weaponType,
        tier,
        durability,
        maxAmmo,
        cooldownTicks,
      );
      if (originalSlot >= 1 && originalSlot < PLAYER.INVENTORY_SIZE) {
        const occupying = player.inventory.weapons[originalSlot];
        if (occupying) {
          const dropId = deps.lootCtx.lootIdGen.next();
          const dropWeapon = new WeaponEntity(
            dropId,
            occupying.type,
            occupying.tier,
            occupying.ammo,
            occupying.maxAmmo,
            occupying.cooldown,
          );
          deps.match.addWeaponPickup(
            dropId,
            dropWeapon,
            new Position(player.movement.position.x, player.movement.position.y),
          );
          player.inventory.weapons[originalSlot] = null;
        }
        player.inventory.weapons[originalSlot] = weapon;
      } else {
        const boomerangSlot = player.addWeapon(weapon);
        if (boomerangSlot >= 0) {
          player.forceSwitchSlot(boomerangSlot);
        } else {
          const dropId = deps.lootCtx.lootIdGen.next();
          deps.match.addWeaponPickup(
            dropId,
            weapon,
            new Position(player.movement.position.x, player.movement.position.y),
          );
        }
      }
    },
  );
  for (const event of projectileEvents) {
    deps.match.emitEvent(event);
  }
}

export function step5_PropagateBarrels(deps: SimulationStepDeps, tick: number): void {
  // Juice-pass-1 ticket 05 (GDD §5.5/§7.15) — primed-barrel fuse expiry.
  // Tick-based (never wall-clock, so the fast-forward bench virtual clock
  // stays faithful): a primed barrel whose 15 s fuse has elapsed auto-
  // explodes through the SAME destroy path as a killing hit
  // (`match.destroyDestructible` → `destroyDestructibleAction` →
  // `resolveExplosion`) — identical explosion, no special-casing. Collect
  // first, destroy second: a chain triggered by an earlier expiry can
  // delete later expired barrels from the map mid-loop.
  const fuseExpired: string[] = [];
  for (const d of deps.match.destructibles.values()) {
    if (!d.primed || d.isDestroyed) continue;
    if (d.fuseExpiresAtTick <= tick) fuseExpired.push(d.id);
  }
  for (const id of fuseExpired) {
    // destroyDestructible no-ops on an id already deleted by a chain.
    deps.match.destroyDestructible(id);
  }
  deps.match.updateExplosions();
}

export function step6_ProcessZone(
  deps: SimulationStepDeps,
  zoneService: ZoneService | null,
  tick: number,
  _unused: number,
): void {
  if (!zoneService) return;
  if (!zoneService.shouldTick(1000 / _unused)) return;

  // server-alive-scratch-hoist: iterates the shared per-tick alive array
  // (built at step top, players-Map insertion order). Equivalent to the former
  // fresh forEachAlivePlayer scan — steps 1-5 cannot flip the ALIVE bit
  // (damage only reduces HP; the bit flips in step9).
  const zoneDamaged: { playerId: string; damage: number }[] = [];
  const alive = deps.alivePlayers;
  for (let i = 0; i < alive.length; i++) {
    const player = alive[i]!;
    if (!zoneService.isInZone(player.movement.position.x, player.movement.position.y)) {
      const damage = zoneService.getTickDamage();
      if (damage <= 0) continue;
      const result = deps.match.applyZoneDamage(player.id, damage);
      if (result.damageApplied > 0) {
        zoneDamaged.push({ playerId: player.id, damage: result.damageApplied });
      }
      if (result.killed) {
        deps.match.emitEvent({
          type: 'PlayerEliminated',
          tick,
          timestamp: Date.now(),
          playerId: player.id,
          playerName: player.name,
          killedBy: '',
          killerName: '',
          placement: deps.match.alivePlayerCount,
          weapon: WeaponType.FISTS,
          x: player.movement.position.x,
          y: player.movement.position.y,
          cause: 'zone',
        });
      }
    }
  }
  if (zoneDamaged.length > 0) {
    deps.match.emitEvent({
      type: 'ZoneDamage',
      tick,
      timestamp: Date.now(),
      playersDamaged: zoneDamaged,
    });
  }
}

export function step7_ProcessTraps(
  deps: SimulationStepDeps,
  tickFireAreas: (tick: number) => void,
  _tick: number,
): void {
  deps.match.checkTrapReveals();
  for (const trap of deps.match.getState().traps.values()) {
    const hadCooldown = trap.cooldownRemaining > 0;
    trap.tickCooldown(1);
    if (hadCooldown && trap.cooldownRemaining === 0) {
      deps.match.emitEvent({
        type: 'TrapCooldownExpired',
        tick: deps.match.currentTick,
        timestamp: Date.now(),
        trapId: trap.id,
      });
    }
  }
  tickFireAreas(deps.match.currentTick);
}

export function step8_ExpireTimers(
  deps: SimulationStepDeps,
  activeDashes: Map<
    string,
    { startTick: number; multiplier: number; directionX: number; directionY: number }
  >,
  dashDurationTicks: number,
  _unused: number,
  _tick: number,
): void {
  const tick = deps.match.currentTick;
  // server-alive-scratch-hoist: shared per-tick alive array (built at step top,
  // players-Map insertion order) — equivalent to the former fresh
  // forEachAlivePlayer scans because steps 1-7 cannot flip the ALIVE bit
  // (damage only reduces HP; the bit flips in step9, after this step).
  const alive = deps.alivePlayers;
  for (let i = 0; i < alive.length; i++) {
    const player = alive[i]!;
    player.updateDashCooldown(1);
    player.expireBarrier(tick);
    player.updateStagger(1);
    player.updateSwitch(1);
    player.expireFreshSpawn(tick);
    for (const weapon of player.inventory) {
      if (weapon) weapon.tick();
    }
  }

  const expiredDashes: string[] = [];
  for (const [playerId, dash] of activeDashes) {
    if (tick - dash.startTick >= dashDurationTicks) {
      const player = deps.match.getPlayer(playerId);
      if (player && player.movement.isDashing) {
        player.endDashSpeed();
        player.endDash();
        player.movement.velocityX = 0;
        player.movement.velocityY = 0;
        const resolvedPos = deps.movementService.resolveDashEndOverlap(
          player,
          (cb) => {
            // server-alive-scratch-hoist: dash-end overlap resolves against the
            // FIRST overlapping player in players-Map insertion order —
            // the shared array preserves exactly that order.
            for (let j = 0; j < alive.length; j++) cb(alive[j]!);
          },
          deps.match.getGrid(),
        );
        deps.match.movePlayer(playerId, resolvedPos);
        deps.checkTrapWalkOver(playerId);
      }
      expiredDashes.push(playerId);
    }
  }
  for (const id of expiredDashes) {
    activeDashes.delete(id);
  }

  deps.pickupCommand.expireEffects(tick, deps.match);

  const windupCompletions: string[] = [];
  for (let i = 0; i < alive.length; i++) {
    const player = alive[i]!;
    if (player.combat.tickWindup()) {
      windupCompletions.push(player.id);
    }
  }
  for (const playerId of windupCompletions) {
    deps.attackCommand.completeWindup(playerId);
  }

  deps.match.step8_TickChestOpenings(SIM_TICK_DT);
}

export function step9_ResolveDeaths(
  deps: SimulationStepDeps,
  activeDashes: Map<string, ActiveDash>,
  tick: number,
): void {
  const drainedEvents = deps.match.drainEvents();
  const alreadyEliminated = new Set<string>();

  for (const event of drainedEvents) {
    deps.match.emitEvent(event);
    if (event.type === 'PlayerEliminated' && event.playerId) {
      alreadyEliminated.add(event.playerId as string);
    }
  }

  const result = deps.deathResolution.processDeaths(
    deps.match.getState().players,
    tick,
    alreadyEliminated,
    {
      emitEvent: (e: GameEvent) => deps.match.emitEvent(e),
      getPlayerName: (id: string) => deps.match.getPlayer(id)?.name ?? '',
      getAliveCount: () => deps.match.alivePlayerCount,
      hasPlayer: (id: string) => deps.match.getPlayer(id) !== undefined,
      markPlayerDead: (id: string) => {
        deps.markPlayerDead(id);
      },
    },
  );

  const allEliminated = new Set([...alreadyEliminated, ...result.eliminatedPlayerIds]);
  for (const playerId of allEliminated) {
    deps.pickupCommand.clearAllEffectsForPlayer(playerId);
    deps.match.cancelChestOpeningForPlayer(playerId);
    deps.match.dropPlayerWeapons(playerId);
    deps.match.dropBoomerangsForDeadPlayer(playerId);
    const dash = activeDashes.get(playerId);
    if (dash) {
      const player = deps.match.getPlayer(playerId);
      if (player && player.movement.isDashing) {
        player.endDashSpeed();
        player.endDash();
        player.movement.velocityX = 0;
        player.movement.velocityY = 0;
      }
    }
    activeDashes.delete(playerId);
  }
}
