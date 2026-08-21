import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BotContext, BotState } from '../../src/ai/BotContext.ts';
import { updateSelfState } from '../../src/ai/BotSelfState.ts';
import { runAntiStall } from '../../src/ai/BotTickPhases.ts';
import { checkGoalStall } from '../../src/ai/BotTickUtilities.ts';
import { StimulusRouter } from '../../src/ai/stimulus/StimulusRouter.ts';
import type { StimulusRouterDeps } from '../../src/ai/stimulus/StimulusRouter.ts';
import type { GameEvent } from '../../src/domain/events/index.ts';
import type { PlayerDTO } from '../../src/ai/WorldSnapshot.ts';
import type { BotSystem } from '../../src/ai/BotSystem.ts';

/**
 * bot-ai-v2 ticket 06 — the PROGRESS-MASK fix (DEC-005.3).
 *
 * Attack emission and damage intake NO LONGER exempt a bot from relocation:
 * progress is ONLY (a) displacement toward a goal (the stall windows +
 * pursuit-closing), (b) completed pickups, (c) kills. Pre-fix, a wedged bot
 * that was whiffing attacks or being chip-damaged read as "making progress"
 * and was never relocated (AUDIT §5.6 root cause 2).
 *
 * Written under the owner's no-run directive: assertions are statically
 * reasoned against the implementation; the orchestrator's sweep runs them.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

function selfDto(over: Partial<PlayerDTO>): PlayerDTO {
  return {
    id: 'bot_pm',
    x: 0,
    y: 0,
    velocityX: 0,
    velocityY: 0,
    facingAngle: 0,
    health: 100,
    maxHealth: 100,
    barrierActive: false,
    activeSlot: 0,
    isFreshSpawn: false,
    weaponCount: 0,
    weapons: [],
    ...over,
  } as PlayerDTO;
}

describe('Progress mask: damage intake no longer counts as progress', () => {
  const system = {
    selectors: new Map(),
    skillTrackers: new Map(),
  } as unknown as BotSystem;

  it('taking damage updates lastDamageTick but NOT lastProgressTick', () => {
    const ctx = new BotContext('bot_pm_dmg');
    ctx.prevHealth = 100;
    ctx.health = 100;
    ctx.weapons = [];
    ctx.lastProgressTick = 123; // sentinel: must remain untouched
    ctx.lastDamageTick = -9999;
    ctx.tick = 50;
    updateSelfState(system, ctx, selfDto({ health: 80 }));
    expect(ctx.lastDamageTick).toBe(50); // the startle channel still works
    // PRE-FIX (red): `ctx.lastProgressTick = ctx.tick` fired here — a bot
    // being chip-damaged while wedged was permanently relocation-exempt.
    expect(ctx.lastProgressTick).toBe(123);
  });

  it('a completed pickup (heal) still counts as progress', () => {
    const ctx = new BotContext('bot_pm_heal');
    ctx.prevHealth = 50;
    ctx.health = 50;
    ctx.weapons = [];
    ctx.lastProgressTick = 5;
    ctx.tick = 60;
    updateSelfState(system, ctx, selfDto({ health: 90 }));
    expect(ctx.lastProgressTick).toBe(60);
  });

  it('attack emission no longer bumps lastProgressTick (source-shape pin)', () => {
    const src = readFileSync(join(HERE, '../../src/ai/BotTickPhases.ts'), 'utf8');
    // The removed loop assigned lastProgressTick per ATTACK input (the code
    // shape below is the historical assignment — the file must not contain
    // it anywhere; the prose comments deliberately avoid the pattern).
    expect(src).not.toMatch(/InputAction\.ATTACK[\s\S]{0,120}lastProgressTick\s*=/);
    // Damage-intake exemption removed from BotSelfState too.
    const self = readFileSync(join(HERE, '../../src/ai/BotSelfState.ts'), 'utf8');
    expect(self).not.toMatch(/lastDamageTick[\s\S]{0,120}lastProgressTick/);
  });
});

describe('Progress mask: a wedged combat bot is relocated within the bound', () => {
  function stallSystem(suspends: string[]): BotSystem {
    return {
      selectors: new Map([
        [
          'bot_pm_stall',
          {
            suspend: (family: number, until: number) => suspends.push(`${family}:${until}`),
            forceReevaluate: () => {},
          },
        ],
      ]),
      skillTrackers: new Map(),
    } as unknown as BotSystem;
  }

  it('the universal anti-stall resets a bot whose only activity was attacking (pre-fix: exempt)', () => {
    const suspends: string[] = [];
    const system = stallSystem(suspends);
    const ctx = new BotContext('bot_pm_stall');
    ctx.state = BotState.ENGAGE;
    ctx.lastProgressTick = 0; // POST-FIX: attacking no longer bumps this —
    // a whiffing wedged bot has an ancient progress tick, so the window
    // below correctly declares "no progress" and relocates it.
    ctx.x = 500;
    ctx.y = 500;
    ctx.tick = 0;
    runAntiStall(system, ctx); // snapshot
    ctx.tick = 300; // one full 300-tick window, position unchanged (wedged)
    runAntiStall(system, ctx);
    expect(ctx.forceWanderUntilTick).toBe(300 + 90); // relocated
    expect(suspends.length).toBe(1); // goal family suspended
    expect(ctx.targetId).toBeNull();
  });

  it('pursuit-closing displacement still exempts a legitimately chasing bot', () => {
    const suspends: string[] = [];
    const system = stallSystem(suspends);
    const ctx = new BotContext('bot_pm_chase');
    ctx.state = BotState.ENGAGE;
    ctx.lastProgressTick = 0;
    ctx.x = 500;
    ctx.y = 500;
    ctx.tick = 0;
    // Snapshot with a distant pursuit target; the bot closes >80px on it
    // over the window (kiting chase — displacement TOWARD the goal).
    let enemyDist = 900;
    ctx.nearestEnemy = { id: 'e1', x: 0, y: 0, distance: enemyDist } as never;
    runAntiStall(system, ctx); // snapshot at dist 900
    ctx.nearestEnemy = { id: 'e1', x: 0, y: 0, distance: (enemyDist -= 200) } as never;
    ctx.tick = 300;
    runAntiStall(system, ctx);
    expect(ctx.forceWanderUntilTick).toBe(-9999); // NOT relocated
    expect(suspends.length).toBe(0);
  });
});

describe('Progress mask: kills count as progress (stimulus router hook)', () => {
  function routerWith(kills: Array<{ killerId: string; tick: number }>) {
    const deps: StimulusRouterDeps = {
      bots: new Map(),
      queryPlayers: () => {},
      resolvePlayerPos: () => null,
      combatHotspot: { x: 0, y: 0, tick: -9999 },
      noteDamageStimulus: () => {},
      noteAttackHeard: () => {},
      noteDamageDirection: () => {},
      noteEliminationHeard: () => {},
      noteKillScored: (killerId, tick) => kills.push({ killerId, tick }),
    };
    return new StimulusRouter(deps);
  }

  it('a PlayerEliminated event forwards its killer for the progress stamp', () => {
    const kills: Array<{ killerId: string; tick: number }> = [];
    const router = routerWith(kills);
    const event = {
      type: 'PlayerEliminated',
      tick: 4242,
      playerId: 'victim_1',
      playerName: 'Victim',
      killedBy: 'bot_pm_killer',
      killerName: 'Killer',
      placement: 12,
      weapon: 0,
      x: 100,
      y: 100,
      cause: 'combat',
    } as unknown as GameEvent;
    router.ingest([event], 7);
    expect(kills).toEqual([{ killerId: 'bot_pm_killer', tick: 4242 }]);
  });

  it('wall-clock-free events (tick 0) stamp the ingest fallback tick', () => {
    const kills: Array<{ killerId: string; tick: number }> = [];
    const router = routerWith(kills);
    const event = {
      type: 'PlayerEliminated',
      tick: 0,
      playerId: 'victim_2',
      playerName: 'Victim',
      killedBy: 'bot_pm_killer',
      killerName: 'Killer',
      placement: 11,
      weapon: 0,
      x: 100,
      y: 100,
      cause: 'combat',
    } as unknown as GameEvent;
    router.ingest([event], 99);
    expect(kills).toEqual([{ killerId: 'bot_pm_killer', tick: 99 }]);
  });
});

describe('Suspension demoted to last resort: the ladder preempts the goal-stall', () => {
  it('checkGoalStall defers while the ladder is inside its budget, fires after it', () => {
    const suspends: string[] = [];
    const system = {
      selectors: new Map([
        [
          'bot_pm_gate',
          {
            suspend: (family: number, until: number) => suspends.push(`${family}:${until}`),
            forceReevaluate: () => {},
          },
        ],
      ]),
      skillTrackers: new Map(),
    } as unknown as BotSystem;
    const ctx = new BotContext('bot_pm_gate');
    ctx.state = BotState.LOOT;
    ctx.x = 500;
    ctx.y = 500;
    // Simulate an engaged ladder (as if navigateTo had escalated it).
    ctx.ladder.rung = 2; // BACK_UP
    ctx.ladder.firstStuckTick = 1000;
    ctx.tick = 1100; // age 100 < LADDER_MAX_TOTAL_TICKS
    ctx.goalStartTick = 1000;
    ctx.goalStartX = 500;
    ctx.goalStartY = 500;
    ctx.longStallStartTick = -9999;
    expect(checkGoalStall(system, ctx)).toBe(false); // ladder preempts
    expect(suspends.length).toBe(0);
    // Past the ladder budget the legacy suspend may fire again.
    ctx.tick = 1000 + 181; // > LADDER_MAX_TOTAL_TICKS (180)
    ctx.ladder.firstStuckTick = 1000;
    ctx.goalStartTick = 1080; // window elapsed (101 > 90), still wedged
    expect(checkGoalStall(system, ctx)).toBe(true);
    expect(suspends.length).toBe(1);
  });
});
