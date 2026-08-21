import { PLAYER, WeaponType, WeaponTier } from '@sector-battle/shared';
import type { GameMatch } from '../../domain/aggregates/GameMatch.ts';
import { CommandResult, type CommandResult as CommandResultType } from './CommandTypes.ts';
import { WeaponEntity } from '../../domain/entities/index.ts';
import { Position } from '../../domain/value-objects/index.ts';
import type { WeaponPickupCollectedEvent } from '../../domain/events/WeaponPickupEvents.ts';

export interface PickupWeaponInput {
  playerId: string;
  tick: number;
}

export class PickupWeaponCommand {
  constructor(private match: GameMatch) {}

  execute(input: PickupWeaponInput): CommandResultType {
    const player = this.match.getPlayer(input.playerId);
    if (!player) return CommandResult.fail('Player not found');
    if (!player.isActive) return CommandResult.fail('Player is dead');
    if (!player.canPickup()) return CommandResult.fail('Cannot pick up right now');

    const pickup = this.match.getWeaponPickupAt(
      player.movement.position.x,
      player.movement.position.y,
      PLAYER.PICKUP_RADIUS,
    );
    if (!pickup) return CommandResult.fail('No weapon pickup in range');

    if (player.hasEmptySlot()) {
      const addedSlot = player.addWeapon(pickup.weapon);
      if (addedSlot >= 0) {
        player.forceSwitchSlot(addedSlot);
        pickup.deactivate();
        this.match.removeWeaponPickup(pickup.id);
        this.emitPickupEvent(input.playerId, pickup.id, pickup.weapon.type, pickup.weapon.tier);
      }
    } else {
      const swapSlot = player.findSwapTarget(pickup.weapon.tier);
      const droppedWeapon = player.removeWeapon(swapSlot);
      if (droppedWeapon) {
        const droppedPickupId = this.match.nextId();
        const droppedPickupWeapon = new WeaponEntity(
          droppedPickupId,
          droppedWeapon.type,
          droppedWeapon.tier,
          droppedWeapon.ammo,
          droppedWeapon.maxAmmo,
          droppedWeapon.cooldown,
        );
        this.match.addWeaponPickup(
          droppedPickupId,
          droppedPickupWeapon,
          new Position(player.movement.position.x, player.movement.position.y),
        );
      }
      const swapAddedSlot = player.addWeapon(pickup.weapon);
      if (swapAddedSlot >= 0) {
        player.forceSwitchSlot(swapAddedSlot);
      }
      pickup.deactivate();
      this.match.removeWeaponPickup(pickup.id);
      this.emitPickupEvent(input.playerId, pickup.id, pickup.weapon.type, pickup.weapon.tier);
    }

    return CommandResult.ok([]);
  }

  private emitPickupEvent(
    playerId: string,
    pickupId: string,
    weaponType: WeaponType,
    tier: WeaponTier,
  ): void {
    const event: WeaponPickupCollectedEvent = {
      type: 'WeaponPickupCollected',
      tick: this.match.currentTick,
      timestamp: Date.now(),
      playerId,
      pickupId,
      weaponType,
      tier,
    };
    this.match.emitEvent(event);
  }
}
