/**
 * Diagnostic: trace why weaponHunt fails for unarmed bots.
 * Runs 1 round, 6 bots, procedural map, 600 ticks (10s).
 * Logs BT behavior + key state per tick for the first unarmed bot.
 */
import { createBotBenchmarkHarness } from './bot-benchmark-harness.ts';

const TICKS = 600;
const NUM_BOTS = 6;

const harness = createBotBenchmarkHarness();
const { botSystem, match, simulation } = harness.setup({
  numBots: NUM_BOTS,
  mapType: 'procedural',
  seed: 84365,
  ticks: TICKS,
  // Hook into bot ticks to trace behavior
  onBotTick: (playerId: string, tick: number, ctx: any) => {
    // Only trace first 100 ticks, first bot
    if (tick > 100) return;
    const weapons = ctx.inventory.weapons.filter((w: any) => w.type !== 0).length;
    if (weapons > 0) return; // Skip armed bots

    const zoneSafety = ctx.getBlackboard<string>('zoneSafety');
    const nearbyItems = ctx.nearbyItems.length;
    const nearbyWeapons = ctx.nearbyItems.filter((i: any) => i.type === 'weapon').length;
    const globalWeapons = ctx.globalWeapons.length;
    const behavior = ctx.lastBehaviorName;
    const goalType = ctx.movementGoal.type;
    const nearbyChests = ctx.nearbyItems.filter(
      (i: any) => i.type === 'powerup' && i.tier >= 5,
    ).length;
    const pickupIntent = ctx.getBlackboard('_pickupIntent');

    console.log(
      `t=${tick} bot=${playerId.slice(-4)} weps=${weapons} ` +
        `beh=${behavior} goal=${goalType} ` +
        `zone=${zoneSafety} items=${nearbyItems} wpns=${nearbyWeapons} ` +
        `chests=${nearbyChests} globWpns=${globalWeapons} ` +
        `pickup=${pickupIntent ? 'Y' : 'N'}`,
    );
  },
});

harness.run();
