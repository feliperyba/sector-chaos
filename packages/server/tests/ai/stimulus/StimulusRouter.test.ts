import { describe, it, expect } from 'vitest';
import { AttackType, ChestRarity, DamageType, EntityType, WeaponType } from '@sector-battle/shared';
import type { GameEvent } from '../../../src/domain/events/index.ts';
import {
  StimulusRouter,
  extractStimulus,
  type StimulusRouterDeps,
} from '../../../src/ai/stimulus/StimulusRouter.ts';
import {
  writeFightMemory,
  isFightStimulus,
  FIGHT_MEMORY_MIN_SEPARATION_PX,
} from '../../../src/ai/stimulus/StimulusFightMemory.ts';
import {
  STIMULUS_HEARING_RADII,
  STIMULUS_BASE_STRENGTH,
} from '../../../src/ai/stimulus/StimulusConfig.ts';
import type { CombatHotspotMemory } from '../../../src/ai/TickBlackboard.ts';
import { HOTSPOT_MEMORY_TICKS } from '../../../src/ai/BotSystemConstants.ts';
import type { Stimulus } from '../../../src/ai/stimulus/StimulusTypes.ts';

// ---------------------------------------------------------------------------
// Test doubles — the router is pure over its deps (no room, no BotSystem).
// ---------------------------------------------------------------------------

interface TestPlayer {
  id: string;
  x: number;
  y: number;
  alive: boolean;
}

interface Harness {
  router: StimulusRouter;
  hotspot: CombatHotspotMemory;
  damageNotes: { botId: string; tick: number }[];
  // bot-ai-v2 ticket 05 (DEC-003): the believed-state hook recordings.
  heardNotes: Array<{ botId: string; firerId: string; x: number; y: number; tick: number }>;
  damageDirNotes: Array<{
    botId: string;
    attackerId: string | null;
    x: number;
    y: number;
    dirX: number;
    dirY: number;
    tick: number;
  }>;
  elimNotes: Array<{ botId: string; victimId: string | null }>;
}

function makeHarness(players: TestPlayer[]): Harness {
  const hotspot: CombatHotspotMemory = { x: 0, y: 0, tick: -9999 };
  const damageNotes: { botId: string; tick: number }[] = [];
  // TICKET-05 UPDATE: the router's deps grew the three believed-state hooks
  // (heard shots / damage direction / eliminations feeding the per-bot
  // belief store). They are recorded here exactly like damageNotes so the
  // fan-out assertions below can observe them.
  const heardNotes: Harness['heardNotes'] = [];
  const damageDirNotes: Harness['damageDirNotes'] = [];
  const elimNotes: Harness['elimNotes'] = [];
  const bots = new Map<string, { isAlive: boolean }>();
  for (const p of players) {
    if (p.id.startsWith('bot_')) bots.set(p.id, { isAlive: p.alive });
  }
  const deps: StimulusRouterDeps = {
    bots,
    // Mirror the grid contract loosely: hand the router EVERY alive player
    // (cell-aligned candidate over-delivery) — the router re-checks exact
    // Euclidean membership itself, which is exactly what these tests pin.
    queryPlayers: (cx, cy, range, cb) => {
      for (const p of players) {
        if (p.alive) cb({ id: p.id, x: p.x, y: p.y });
      }
    },
    resolvePlayerPos: (id) => {
      const p = players.find((q) => q.id === id);
      return p ? { x: p.x, y: p.y } : null;
    },
    combatHotspot: hotspot,
    noteDamageStimulus: (botId, tick) => damageNotes.push({ botId, tick }),
    noteAttackHeard: (botId, firerId, x, y, tick) =>
      heardNotes.push({ botId, firerId, x, y, tick }),
    noteDamageDirection: (botId, attackerId, x, y, dirX, dirY, tick) =>
      damageDirNotes.push({ botId, attackerId, x, y, dirX, dirY, tick }),
    noteEliminationHeard: (botId, victimId) => elimNotes.push({ botId, victimId }),
    // KILL PROGRESS (bot-ai-v2 ticket 06, DEC-005.3): the killer-side
    // lastProgressTick stamp — no-op here (no assertion on it in this suite;
    // BotProgressMask.test.ts covers the hook).
    noteKillScored: () => {},
  };
  const router = new StimulusRouter(deps);
  // Same lifecycle as BotSystem.registerBot — a bot's stimulus state exists
  // from registration (death flips isAlive; the state survives until
  // unregisterBot, mirroring the skill-tracker lifecycle).
  for (const p of players) {
    if (p.id.startsWith('bot_')) router.registerBot(p.id);
  }
  return { router, hotspot, damageNotes, heardNotes, damageDirNotes, elimNotes };
}

/** (id, x, y) shorthand — all test bots alive unless suffixed otherwise. */
function bot(id: string, x: number, y: number, alive = true): TestPlayer {
  return { id, x, y, alive };
}

function queueOf(h: Harness, id: string): Stimulus[] {
  return h.router.getState(id)!.queue.entries;
}

// --- domain event factories (full literal shapes, tick-stamped only) -------

const ev = {
  barrel: (x: number, y: number, tick = 100): GameEvent =>
    ({
      type: 'BarrelExploded',
      tick,
      timestamp: 0,
      id: 'b1',
      position: { x, y },
      radius: 256,
      damage: 50,
    }) as GameEvent,
  fired: (playerId: string, x: number, y: number, tick = 100): GameEvent =>
    ({
      type: 'WeaponFired',
      tick,
      timestamp: 0,
      playerId,
      weaponType: WeaponType.DAGGER,
      attackType: AttackType.LINE,
      direction: 0,
      x,
      y,
    }) as GameEvent,
  shattered: (x: number, y: number, tick = 100): GameEvent =>
    ({
      type: 'WeaponShattered',
      tick,
      timestamp: 0,
      projectileId: 'p1',
      weaponType: WeaponType.THROWING_AXE,
      x,
      y,
    }) as GameEvent,
  eliminated: (x: number, y: number, tick = 100, victimId = 'victim'): GameEvent =>
    ({
      type: 'PlayerEliminated',
      tick,
      timestamp: 0,
      playerId: victimId,
      playerName: 'v',
      killedBy: 'killer',
      killerName: 'k',
      placement: 2,
      weapon: WeaponType.DAGGER,
      x,
      y,
      cause: 'melee',
    }) as GameEvent,
  chest: (playerId: string, tick = 100): GameEvent =>
    ({
      type: 'ChestOpened',
      tick,
      timestamp: 0,
      chestId: 'c1',
      playerId,
      tier: ChestRarity.COMMON,
      lootContents: null,
    }) as GameEvent,
  zone: (x: number, y: number, tick = 0): GameEvent =>
    ({
      type: 'ZoneWarning',
      tick,
      timestamp: 0,
      nextPhaseIndex: 2,
      nextCenterX: x,
      nextCenterY: y,
      nextRadius: 900,
      transitionStartsInMs: 5000,
    }) as GameEvent,
  damaged: (
    victimId: string,
    sourceId: string,
    x: number,
    y: number,
    tick = 100,
    knockbackX = 0,
    knockbackY = 0,
  ): GameEvent =>
    ({
      type: 'PlayerDamaged',
      tick,
      timestamp: 0,
      playerId: victimId,
      damage: 10,
      sourceId,
      sourceType: EntityType.PLAYER,
      damageType: DamageType.MELEE_HIT,
      knockbackX,
      knockbackY,
      killed: false,
      x,
      y,
    }) as GameEvent,
  other: (tick = 100): GameEvent =>
    ({
      type: 'ProjectileBounced',
      tick,
      timestamp: 0,
      projectileId: 'p9',
      x: 0,
      y: 0,
    }) as GameEvent,
};

// ---------------------------------------------------------------------------
// extractStimulus — the per-event mapping (radii/emitter/global of record)
// ---------------------------------------------------------------------------

describe('extractStimulus (event → routed stimulus mapping)', () => {
  const resolve = (id: string) => (id === 'human_1' ? { x: 50, y: 60 } : null);

  it('maps every routed family to its type, position, and hearing radius', () => {
    const cases: [GameEvent, Stimulus['type']][] = [
      [ev.barrel(10, 20), 'explosion'],
      [ev.fired('bot_1', 30, 40), 'attack'],
      [ev.shattered(50, 60), 'thrownLanded'],
      [ev.eliminated(70, 80), 'elimination'],
      [ev.chest('human_1'), 'chest'],
      [ev.zone(90, 100), 'zoneTelegraph'],
      [ev.damaged('bot_1', 'bot_2', 1, 2), 'damage'],
    ];
    for (const [event, type] of cases) {
      const routed = extractStimulus(event, 999, resolve);
      expect(routed, event.type).not.toBeNull();
      expect(routed!.stimulus.type).toBe(type);
      expect(routed!.radius).toBe(STIMULUS_HEARING_RADII[type]);
      expect(routed!.stimulus.strength).toBe(STIMULUS_BASE_STRENGTH[type]);
    }
  });

  it('positions each stimulus from the source event fields', () => {
    expect(extractStimulus(ev.barrel(10, 20), 999, resolve)!.stimulus).toMatchObject({
      worldX: 10,
      worldY: 20,
    });
    // ChestOpened carries no coordinates — placed at the OPENER's position.
    expect(extractStimulus(ev.chest('human_1'), 999, resolve)!.stimulus).toMatchObject({
      worldX: 50,
      worldY: 60,
    });
    expect(extractStimulus(ev.zone(90, 100), 999, resolve)!.stimulus).toMatchObject({
      worldX: 90,
      worldY: 100,
    });
  });

  it('non-stimulus events route to null', () => {
    expect(extractStimulus(ev.other(), 999, resolve)).toBeNull();
  });

  it('uses the event tick when stamped; the ingest fallback for tick-0 events; never the timestamp', () => {
    expect(extractStimulus(ev.fired('bot_1', 0, 0, 4242), 9999, resolve)!.stimulus.tick).toBe(4242);
    // ZoneService stamps tick 0 (wall-clock-free) → fallback tick.
    expect(extractStimulus(ev.zone(0, 0, 0), 777, resolve)!.stimulus.tick).toBe(777);
  });

  it('zone telegraphs are global (no radius); attacks carry their emitter; damage its emitter+subject', () => {
    expect(extractStimulus(ev.zone(0, 0), 1, resolve)!.global).toBe(true);
    expect(extractStimulus(ev.zone(0, 0), 1, resolve)!.radius).toBe(Infinity);
    const fired = extractStimulus(ev.fired('bot_1', 0, 0), 1, resolve)!;
    expect(fired.global).toBe(false);
    expect(fired.emitterId).toBe('bot_1');
    expect(fired.subjectId).toBeNull();
    const dmg = extractStimulus(ev.damaged('bot_2', 'bot_1', 0, 0), 1, resolve)!;
    expect(dmg.emitterId).toBe('bot_1');
    expect(dmg.subjectId).toBe('bot_2');
  });

  it('ChestOpened with an unresolvable opener position is dropped', () => {
    expect(extractStimulus(ev.chest('unknown_id'), 999, resolve)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Fan-out: radius membership, emitter exclusion, humans, global delivery
// ---------------------------------------------------------------------------

describe('StimulusRouter.ingest (hearing-radius fan-out)', () => {
  it('delivers to bots within the radius and not one pixel beyond (exact membership)', () => {
    const h = makeHarness([
      bot('bot_in', 400, 0), // dist 400 ≤ 900
      bot('bot_edge', 900, 0), // dist exactly 900 → member
      bot('bot_out', 901, 0), // dist 901 > 900
      bot('bot_far', 5000, 5000),
    ]);
    h.router.ingest([ev.fired('human_1', 0, 0)], 100);
    const has = (id: string) => queueOf(h, id).some((s) => s.type === 'attack');
    expect(has('bot_in')).toBe(true);
    expect(has('bot_edge')).toBe(true);
    expect(has('bot_out')).toBe(false);
    expect(has('bot_far')).toBe(false);
  });

  it('the emitter does not hear its own event; other bots nearby do', () => {
    const h = makeHarness([bot('bot_shooter', 0, 0), bot('bot_watcher', 300, 0)]);
    h.router.ingest([ev.fired('bot_shooter', 0, 0)], 100);
    expect(queueOf(h, 'bot_shooter').some((s) => s.type === 'attack')).toBe(false);
    expect(queueOf(h, 'bot_watcher').some((s) => s.type === 'attack')).toBe(true);
  });

  it('players in range that are not registered bots (humans) receive nothing', () => {
    const h = makeHarness([bot('bot_1', 0, 0), bot('human_1', 100, 0)]);
    h.router.ingest([ev.barrel(50, 0)], 100);
    expect(h.router.getState('human_1')).toBeUndefined();
    expect(queueOf(h, 'bot_1').some((s) => s.type === 'explosion')).toBe(true);
  });

  it('dead bots hear nothing', () => {
    const h = makeHarness([bot('bot_dead', 0, 0, false), bot('bot_live', 0, 0)]);
    h.router.ingest([ev.barrel(0, 0)], 100);
    expect(h.router.getState('bot_dead')!.queue.length).toBe(0);
    expect(queueOf(h, 'bot_live').length).toBe(1);
  });

  it('zone telegraphs deliver globally to every ALIVE bot regardless of distance', () => {
    const h = makeHarness([
      bot('bot_a', 0, 0),
      bot('bot_b', 9000, 9000),
      bot('bot_dead', 0, 0, false),
    ]);
    h.router.ingest([ev.zone(5120, 5120)], 555);
    expect(queueOf(h, 'bot_a').some((s) => s.type === 'zoneTelegraph' && s.tick === 555)).toBe(
      true,
    );
    expect(queueOf(h, 'bot_b').some((s) => s.type === 'zoneTelegraph')).toBe(true);
    expect(h.router.getState('bot_dead')!.queue.length).toBe(0);
  });

  it('delivers full stimulus entries: type/worldX/worldY/tick/strength', () => {
    const h = makeHarness([bot('bot_1', 0, 0)]);
    h.router.ingest([ev.barrel(120, 240, 4242)], 9999);
    expect(queueOf(h, 'bot_1')).toEqual([
      {
        type: 'explosion',
        worldX: 120,
        worldY: 240,
        tick: 4242,
        strength: STIMULUS_BASE_STRENGTH.explosion,
      },
    ]);
  });

  it('a damage stimulus reaches its VICTIM and bystanders; only the victim is noted for believability', () => {
    const h = makeHarness([
      bot('bot_victim', 0, 0),
      bot('bot_bystander', 200, 0),
      bot('bot_far', 3000, 0),
    ]);
    h.router.ingest([ev.damaged('bot_victim', 'human_1', 100, 0, 777)], 9999);
    expect(queueOf(h, 'bot_victim').some((s) => s.type === 'damage')).toBe(true);
    expect(queueOf(h, 'bot_bystander').some((s) => s.type === 'damage')).toBe(true);
    expect(queueOf(h, 'bot_far').some((s) => s.type === 'damage')).toBe(false);
    expect(h.damageNotes).toEqual([{ botId: 'bot_victim', tick: 777 }]);
  });

  it('per-bot queues stay bounded under a burst (cap enforced end-to-end)', () => {
    const h = makeHarness([bot('bot_1', 0, 0)]);
    const burst: GameEvent[] = [];
    for (let i = 0; i < 30; i++) burst.push(ev.barrel(i * 10, 0, 100 + i));
    h.router.ingest(burst, 100);
    expect(h.router.getState('bot_1')!.queue.length).toBeLessThanOrEqual(8);
  });
});

// ---------------------------------------------------------------------------
// Fight memory (the hotspot migration target) + delivery counters
// ---------------------------------------------------------------------------

describe('StimulusFightMemory (hotspot migration write guards)', () => {
  it('attack and explosion are the fight stimulus types', () => {
    expect(isFightStimulus('attack')).toBe(true);
    expect(isFightStimulus('explosion')).toBe(true);
    for (const t of ['thrownLanded', 'elimination', 'chest', 'zoneTelegraph', 'damage'] as const) {
      expect(isFightStimulus(t)).toBe(false);
    }
  });

  it('a fresh fight within the separation radius is the SAME fight — skipped', () => {
    const mem: CombatHotspotMemory = { x: 100, y: 100, tick: 1000 };
    writeFightMemory(mem, {
      type: 'attack',
      worldX: 100 + FIGHT_MEMORY_MIN_SEPARATION_PX,
      worldY: 100,
      tick: 1100,
      strength: 0.7,
    });
    expect(mem).toEqual({ x: 100, y: 100, tick: 1000 });
  });

  it('a fresh fight BEYOND the separation radius overwrites the memory', () => {
    const mem: CombatHotspotMemory = { x: 100, y: 100, tick: 1000 };
    writeFightMemory(mem, {
      type: 'attack',
      worldX: 100 + FIGHT_MEMORY_MIN_SEPARATION_PX + 1,
      worldY: 100,
      tick: 1100,
      strength: 0.7,
    });
    expect(mem).toEqual({ x: 100 + FIGHT_MEMORY_MIN_SEPARATION_PX + 1, y: 100, tick: 1100 });
  });

  it('an aged-out memory is overwritten even at the same location', () => {
    const mem: CombatHotspotMemory = { x: 100, y: 100, tick: 1000 };
    writeFightMemory(mem, {
      type: 'explosion',
      worldX: 100,
      worldY: 100,
      tick: 1000 + HOTSPOT_MEMORY_TICKS,
      strength: 1,
    });
    expect(mem).toEqual({ x: 100, y: 100, tick: 1000 + HOTSPOT_MEMORY_TICKS });
  });
});

describe('StimulusRouter counters + fight-memory fold', () => {
  it('attack/explosion stimuli fold into the shared fight memory and count as writes', () => {
    const h = makeHarness([bot('bot_1', 0, 0), bot('bot_2', 7900, 7900)]);
    h.router.ingest([ev.fired('human_1', 300, 300, 4242), ev.barrel(8000, 8000, 4243)], 9999);
    // Both are fight stimuli: the LAST one wins the memory.
    expect(h.hotspot).toEqual({ x: 8000, y: 8000, tick: 4243 });
    const summary = h.router.getDeliverySummary();
    expect(summary.fightMemoryWrites).toBe(2);
    expect(summary.routedByType.attack).toBe(1);
    expect(summary.routedByType.explosion).toBe(1);
    // bot_1 heard the attack only; bot_2 heard the explosion only.
    expect(summary.deliveredByType.attack).toBe(1);
    expect(summary.deliveredByType.explosion).toBe(1);
    expect(summary.deliveredTotal).toBe(2);
  });

  it('unregisterBot drops the bot state but keeps the counters', () => {
    const h = makeHarness([bot('bot_1', 0, 0)]);
    h.router.ingest([ev.barrel(0, 0)], 100);
    h.router.unregisterBot('bot_1');
    expect(h.router.getState('bot_1')).toBeUndefined();
    expect(h.router.getDeliverySummary().deliveredTotal).toBe(1);
  });

  it('clearStates drops every state; the summary survives for the benchmark read', () => {
    const h = makeHarness([bot('bot_1', 0, 0)]);
    h.router.ingest([ev.barrel(0, 0)], 100);
    h.router.clearStates();
    expect(h.router.getState('bot_1')).toBeUndefined();
    expect(h.router.getDeliverySummary().deliveredByType.explosion).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Routing purity / determinism (DEC-002 hard gate)
// ---------------------------------------------------------------------------

describe('routing purity (same event stream → same deliveries)', () => {
  const STREAM: GameEvent[] = [
    ev.fired('bot_shooter', 0, 0, 100),
    ev.barrel(500, 0, 101),
    ev.damaged('bot_victim', 'human_1', 300, 0, 102),
    ev.chest('human_1', 103),
    ev.eliminated(700, 0, 104),
    ev.shattered(450, 0, 105),
    ev.zone(5120, 5120, 0),
    ev.other(106),
    ev.fired('bot_shooter', 0, 0, 107),
  ];
  const WORLD: TestPlayer[] = [
    bot('bot_shooter', 0, 0),
    bot('bot_victim', 300, 0),
    bot('bot_bystander', 900, 0),
    bot('bot_far', 6000, 6000),
    bot('human_1', 450, 0),
  ];

  it('two routers fed the identical stream produce identical deliveries', () => {
    const h1 = makeHarness(WORLD);
    const h2 = makeHarness(WORLD);
    h1.router.ingest(STREAM, 9999);
    h2.router.ingest(STREAM, 9999);
    expect(h1.router.getDeliverySummary()).toEqual(h2.router.getDeliverySummary());
    for (const p of WORLD) {
      if (!p.id.startsWith('bot_')) continue;
      expect(queueOf(h1, p.id)).toEqual(queueOf(h2, p.id));
    }
    expect(h1.hotspot).toEqual(h2.hotspot);
    expect(h1.damageNotes).toEqual(h2.damageNotes);
  });

  it('the stream is consumed read-only — re-ingesting the same batch is idempotent per router', () => {
    const h1 = makeHarness(WORLD);
    const h2 = makeHarness(WORLD);
    h1.router.ingest(STREAM, 9999);
    // h2 ingests the SAME array object twice what h1 saw once each — the
    // second h2 pass must NOT see the array drained (read-only contract):
    // totals for h2 are exactly double h1's per-batch totals.
    h2.router.ingest(STREAM, 9999);
    h2.router.ingest(STREAM, 9999);
    expect(STREAM).toHaveLength(9);
    const s1 = h1.router.getDeliverySummary();
    const s2 = h2.router.getDeliverySummary();
    expect(s2.deliveredTotal).toBe(2 * s1.deliveredTotal);
    for (const key of Object.keys(s1.deliveredByType)) {
      expect(s2.deliveredByType[key]).toBe(2 * s1.deliveredByType[key]!);
    }
  });

  it('fan-out involves no RNG: deliveries are a pure function of stream + positions', () => {
    // A replay into a fresh harness after full state disposal reproduces the
    // exact same queues (exercises register/unregister lifecycle neutrality).
    const h1 = makeHarness(WORLD);
    h1.router.ingest(STREAM, 9999);
    const before = WORLD.filter((p) => p.id.startsWith('bot_')).map((p) => ({
      id: p.id,
      snapshot: [...queueOf(h1, p.id)],
    }));
    h1.router.clearStates();
    for (const p of WORLD) {
      if (p.id.startsWith('bot_')) h1.router.registerBot(p.id);
    }
    h1.router.ingest(STREAM, 9999);
    for (const { id, snapshot } of before) {
      expect(queueOf(h1, id)).toEqual(snapshot);
    }
  });

  it('refreshScanFor publishes the merged per-scan view from the routed queue', () => {
    const h = makeHarness([bot('bot_1', 0, 0)]);
    h.router.ingest([ev.barrel(0, 0, 100), ev.fired('human_1', 100, 0, 110)], 9999);
    h.router.refreshScanFor('bot_1', 110);
    const view = h.router.getState('bot_1')!.scan;
    expect(view.entries.map((e) => e.type)).toEqual(['explosion', 'attack']);
    expect(view.strongestByType.explosion).toBeDefined();
    expect(view.heardFightTick).toBe(110);
    // Unknown bot ids are a no-op (defensive — perception-phase call site).
    expect(() => h.router.refreshScanFor('bot_missing', 110)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Believed-state hooks (bot-ai-v2 ticket 05, DEC-003): delivered stimuli
// fan out to the belief-store writers with the WHO (event identity — the
// same info the kill feed carries) and, for damage, the direction TOWARD the
// attacker (negated knockback). Position truth beyond the event's own seat
// never rides these calls.
// ---------------------------------------------------------------------------

describe('StimulusRouter believed-state hooks (ticket 05)', () => {
  it('a delivered attack informs the HEARD hook with the firer id (emitter excluded)', () => {
    const h = makeHarness([bot('bot_shooter', 0, 0), bot('bot_watcher', 300, 0)]);
    h.router.ingest([ev.fired('bot_shooter', 120, 40, 555)], 9999);
    expect(h.heardNotes).toEqual([
      { botId: 'bot_watcher', firerId: 'bot_shooter', x: 120, y: 40, tick: 555 },
    ]);
  });

  it('a damage stimulus informs the DAMAGE-DIRECTION hook for the VICTIM ONLY, with the negated knockback direction', () => {
    const h = makeHarness([bot('bot_victim', 0, 0), bot('bot_bystander', 200, 0)]);
    // Knockback pushed the victim WEST (−x): the attacker lies EAST (+x).
    h.router.ingest([ev.damaged('bot_victim', 'human_1', 300, 0, 777, -60, 0)], 9999);
    expect(h.damageDirNotes).toEqual([
      {
        botId: 'bot_victim',
        attackerId: 'human_1',
        x: 300,
        y: 0,
        dirX: 1, // normalized −knockback: toward the attacker
        dirY: 0,
        tick: 777,
      },
    ]);
    // Zero knockback → unknown direction (0,0) — still delivered.
    h.damageDirNotes.length = 0;
    h.router.ingest([ev.damaged('bot_victim', 'human_1', 300, 0, 778, 0, 0)], 9999);
    expect(h.damageDirNotes).toEqual([
      { botId: 'bot_victim', attackerId: 'human_1', x: 300, y: 0, dirX: 0, dirY: 0, tick: 778 },
    ]);
  });

  it('an elimination informs the ELIMINATION hook with the victim id for every hearing bot', () => {
    const h = makeHarness([bot('bot_a', 0, 0), bot('bot_b', 400, 0), bot('bot_far', 5000, 0)]);
    h.router.ingest([ev.eliminated(0, 0, 901, 'bot_dead_guy')], 9999);
    expect(h.elimNotes).toEqual([
      { botId: 'bot_a', victimId: 'bot_dead_guy' },
      { botId: 'bot_b', victimId: 'bot_dead_guy' },
    ]);
  });
});
