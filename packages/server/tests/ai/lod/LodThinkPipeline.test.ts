import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vi } from 'vitest';
import { TileType } from '@sector-battle/shared';
import type { GameMatch } from '../../../src/domain/aggregates/GameMatch.ts';
import type { GameEvent } from '../../../src/domain/events/index.ts';
import { Pathfinder } from '../../../src/ai/navigation/Pathfinder.ts';
import { BotSystem } from '../../../src/ai/BotSystem.ts';
import { isThinkTick, LodReliefLevel, LodTier } from '../../../src/ai/lod/LodTiers.ts';
import { REACTION_LATENCY_MAX_TICKS } from '../../../src/ai/reactor/ReactorConfig.ts';

/**
 * LOD think-gating at the REAL BotSystem seam (bot-ai-v2 ticket 11,
 * DEC-012.1): a full BotSystem with a literal match — no room — proving the
 * always-on contract end-to-end:
 *
 *  - a T2 (far) bot SKIPS intent re-scoring on off-think ticks (cadence) but
 *    NEVER skips the Reactor, stimulus view refresh, or input submission;
 *  - a T2 bot still FLINCHES on an explosion stimulus (while remaining T2 —
 *    reactions are the visible thing and run every tick at every tier);
 *  - combat entry upgrades a far bot to full-fidelity T0 on the very next
 *    tick (immediate), the startle fires within the reaction-latency bound,
 *    and the tier falls back when the damage window expires (pure boundary).
 *
 * Determinism: both bot ids are fixed, so every RNG draw (reaction latency)
 * is byte-stable, and performance.now is FROZEN (the same contract the bench
 * harness's virtual clock provides) so the budget guard's relief valve is
 * deterministically inert — these tests measure pure cadence, never machine
 * speed. Assertions are bounds that hold for ANY legal latency draw.
 */

beforeEach(() => {
  vi.stubGlobal('performance', { now: () => 0 });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const SIZE = 64; // 64 tiles * 128px = an 8192px map — two corners are ~11.3k px apart (T2)
const TILE = 128;

function mkGrid(): boolean[][] {
  return Array.from({ length: SIZE }, () => Array.from({ length: SIZE }, () => true));
}

interface PlayerLiteral {
  id: string;
  isActive: boolean;
  isBot: boolean;
  health: { current: number; max: number };
  movement: {
    position: { x: number; y: number };
    velocityX: number;
    velocityY: number;
    facingAngle: number;
  };
  inventory: {
    activeSlot: number;
    weapons: Array<{ type: TileType; tier: number; ammo: number } | null>;
  };
  statusEffects: { freshSpawnExpiryTick: number; barrierActive: boolean };
  combat: { windupRemaining: number; lastAttackTick: number; isInWindup(): boolean };
  isFreshSpawn(): boolean;
  getActiveWeapon(): { type: TileType; tier: number } | null;
}

function mkPlayer(id: string, x: number, y: number): PlayerLiteral {
  return {
    id,
    isActive: true,
    isBot: true,
    health: { current: 100, max: 100 },
    movement: { position: { x, y }, velocityX: 0, velocityY: 0, facingAngle: 0 },
    inventory: { activeSlot: 0, weapons: [null, null, null, null] },
    statusEffects: { freshSpawnExpiryTick: 0, barrierActive: false },
    combat: { windupRemaining: 0, lastAttackTick: -9999, isInWindup: () => false },
    isFreshSpawn: () => false,
    getActiveWeapon: () => null,
  };
}

interface Fixture {
  system: BotSystem;
  players: Map<string, PlayerLiteral>;
  botA: PlayerLiteral;
  botB: PlayerLiteral;
}

function mkSystem(): Fixture {
  const grid = mkGrid();
  const players = new Map<string, PlayerLiteral>();
  const state = {
    players,
    projectiles: new Map(),
    powerUps: new Map(),
    traps: new Map(),
    chests: new Map(),
    destructibles: new Map(),
    weaponPickups: new Map(),
    exits: new Map(),
    explosions: new Map(),
    tick: 0,
    zone: {
      centerX: SIZE * TILE * 0.5,
      centerY: SIZE * TILE * 0.5,
      currentRadius: 0,
      targetRadius: 0,
      shrinkSpeed: 0,
      nextShrinkTick: 0,
    },
    grid,
  };
  const match = {
    getState: () => state,
    getGrid: () => grid,
    consumeGridDirty: () => false,
    currentTick: 0,
    getPlayer: (id: string) => players.get(id),
    // buildDestructibleMap (BotSpatialIndex) reads the collision service for
    // SAT collider centroids on 30-tick boundaries; the no-atlas fake returns
    // null centroids (aim falls back to tile-center — the graceful path).
    getCollisionService: () => ({ getColliderCentroid: () => null }),
  } as unknown as GameMatch;
  const system = new BotSystem(match, new Pathfinder(grid));
  // Two corner bots: an all-bot lobby whose nearest-bot distance (~11.3k px)
  // is far beyond the T2 bound — both bots are T2 until combat entry.
  const botA = mkPlayer('lod-bot-a', 200, 200);
  const botB = mkPlayer('lod-bot-b', SIZE * TILE - 200, SIZE * TILE - 200);
  players.set(botA.id, botA);
  players.set(botB.id, botB);
  system.registerBot(botA.id);
  system.registerBot(botB.id);
  return { system, players, botA, botB };
}

describe('T2 think cadence through the per-bot pipeline', () => {
  it('far bots are T2 every tick and skip intent re-scoring on off-think ticks', () => {
    const { system } = mkSystem();
    const a = system.bots.get('lod-bot-a')!;
    // 27 ticks = 3 stride-9 thinks + 24 skips per bot.
    for (let tick = 1; tick <= 27; tick++) {
      const inputs = system.tick(tick);
      // Input submission is NEVER cadence-gated (bots are players): at least
      // one of the two wandering bots emits a move input every tick.
      expect(inputs.length).toBeGreaterThanOrEqual(1);
      expect(a.lodTier).toBe(LodTier.T2);
      expect(a.lodCombatTier).toBe(false);
      expect(a.lodRelief).toBe(LodReliefLevel.NONE);
    }
    const lod = system.getLodTelemetry();
    expect(lod.tierBotTicks[LodTier.T2]).toBe(54); // both bots, all 27 ticks
    expect(lod.tierBotTicks[LodTier.T0]).toBe(0);
    expect(lod.tierBotTicks[LodTier.T1]).toBe(0);
    // Exactly the stride-9 cadence: 3 thinks + 24 skips per bot.
    expect(lod.thinkTicksExecuted).toBe(6);
    expect(lod.thinkTicksSkipped).toBe(48);
  });
});

describe('a T2 bot still flinches on an explosion stimulus', () => {
  it('the reactor fires the explosion reaction while the bot remains T2', () => {
    const { system, botA } = mkSystem();
    const a = system.bots.get('lod-bot-a')!;
    // Settle both bots into steady T2 cadence.
    for (let tick = 1; tick <= 10; tick++) system.tick(tick);
    const tracker = system.skillTrackers.get('lod-bot-a')!;
    expect(tracker.believability.reactionsByType.explosion ?? 0).toBe(0);

    // A barrel detonates ~300px from bot A (inside the 1400px explosion
    // hearing radius; bot B is ~11k px away and hears nothing). Ingested
    // BETWEEN ticks — exactly how GameOrchestrator.update feeds the router.
    const explosion: GameEvent = {
      type: 'BarrelExploded',
      id: 'barrel-1',
      tick: 10,
      timestamp: 0,
      position: { x: botA.movement.position.x + 300, y: botA.movement.position.y },
      radius: 256,
      damage: 50,
    } as unknown as GameEvent;
    system.ingestStimulusEvents([explosion], 10);

    // Drive past the reaction-latency bound (detect ≤ EXPLOSION_MAX_AGE + a
    // latency draw ≤ REACTION_LATENCY_MAX_TICKS). Poll for the fired
    // reaction; the bot must STILL be T2 at the flinch — reactions never
    // wait for a think tick (the every-tick stimulus view refresh is what
    // makes this work at the coarse T2 scan stride).
    let flinchTick = -1;
    for (let tick = 11; tick <= 11 + 130; tick++) {
      system.tick(tick);
      if ((tracker.believability.reactionsByType.explosion ?? 0) > 0) {
        flinchTick = tick;
        break;
      }
      // No upgrade happened along the way: hearing a blast is NOT combat.
      expect(a.lodTier).toBe(LodTier.T2);
    }
    expect(flinchTick).toBeGreaterThan(10);
    expect(flinchTick).toBeLessThanOrEqual(11 + 30 + REACTION_LATENCY_MAX_TICKS + 5);
    expect(a.lodTier).toBe(LodTier.T2);
    // And T2 cadence kept skipping thinks across the window — the flinch
    // never needed a think tick.
    expect(system.getLodTelemetry().thinkTicksSkipped).toBeGreaterThan(0);
  });
});

describe('no behavioral cliff at the tier boundary (combat entry)', () => {
  it('a far T2 bot engaged by an attacker upgrades to T0 the next tick, startles within the latency bound, and thinks at full fidelity', () => {
    const { system, botA } = mkSystem();
    const a = system.bots.get('lod-bot-a')!;
    for (let tick = 1; tick <= 20; tick++) system.tick(tick);
    expect(a.lodTier).toBe(LodTier.T2);
    const upgradesBefore = system.getLodTelemetry().combatTierUpgrades;
    const tracker = system.skillTrackers.get('lod-bot-a')!;

    // The attacker strikes: bot A's health drops between ticks. The damage
    // becomes visible during tick 21's self-state sync (lastDamageTick = 21);
    // the tier — recomputed at the TOP of every bot's pass — flips to
    // combat-tier T0 on tick 22, the very next tick (immediate upgrade).
    botA.health.current = 55;
    system.tick(21);

    system.tick(22);
    expect(a.lodTier).toBe(LodTier.T0);
    expect(a.lodCombatTier).toBe(true);
    expect(system.getLodTelemetry().combatTierUpgrades).toBe(upgradesBefore + 1);

    // FULL FIDELITY from the upgrade on: combat-tier T0 re-scores intents
    // EVERY tick (T0 thinks unconditionally). Drive through the full
    // reaction-latency bound so the startle ("reacts") lands inside this
    // same loop's window.
    let startleFired = false;
    for (let tick = 23; tick <= 22 + REACTION_LATENCY_MAX_TICKS; tick++) {
      system.tick(tick);
      if ((tracker.believability.reactionsByType.startle ?? 0) > 0) startleFired = true;
      if (tick <= 21 + 15) {
        // Inside the damage-freshness window the bot stays combat-tier T0
        // and re-scores intents EVERY tick (T0 thinks unconditionally).
        expect(a.lodTier).toBe(LodTier.T0);
        expect(a.lodCombatTier).toBe(true);
        expect(
          isThinkTick(
            a.lodTier,
            a.lodCombatTier,
            tick,
            a.perceptionPhase,
            a.perceptionPhase9,
            a.lodRelief,
          ),
        ).toBe(true);
      }
    }
    expect(startleFired).toBe(true);

    // Pure-boundary fallback: with the hit stale (damage window expired) and
    // no enemy/engagement, the bot returns to its distance tier (T2).
    for (
      let tick = 22 + REACTION_LATENCY_MAX_TICKS + 1;
      tick <= 22 + REACTION_LATENCY_MAX_TICKS + 5;
      tick++
    ) {
      system.tick(tick);
    }
    expect(a.lodTier).toBe(LodTier.T2);
    expect(a.lodCombatTier).toBe(false);
  });
});
