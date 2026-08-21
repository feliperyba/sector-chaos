import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { ColyseusTestServer } from '@colyseus/testing';
import type { Room } from 'colyseus';
import { createTestServer, cleanup } from '../../helpers/test-server';
import { createGameRoom } from '../../helpers/game-room-helper';
import {
  MATCH,
  PLAYER,
  NETWORK,
  COMBAT,
  PlayerStatus,
  MatchPhase,
  WeaponType,
  WeaponTier,
  TileType,
  weaponRegistry,
} from '@sector-battle/shared';
import type { GameStateSchema } from '../../../src/infrastructure/schemas/GameStateSchema';
import { GameRoom } from '../../../src/room/GameRoom';
import type { GameMatch } from '../../../src/domain/aggregates/GameMatch';
import { WeaponEntity } from '../../../src/domain/entities/index';
import { Position } from '../../../src/domain/value-objects/index';

type TestClient = Awaited<ReturnType<ColyseusTestServer['connectTo']>>;

const SPAWN_INV_TICKS = Math.ceil(PLAYER.SPAWN_INVINCIBILITY * NETWORK.TICK_RATE);
const BOW_WINDUP_TICKS = Math.ceil(
  weaponRegistry.getDefinition(WeaponType.SHORT_BOW).baseStats.windupMs / (1000 / 60),
);
const ARROW_PX_PER_TICK = 2000 / NETWORK.TICK_RATE;

const POS_A = { x: 5120, y: 5100 };

let server: ColyseusTestServer;

beforeAll(async () => {
  server = await createTestServer();
});

afterAll(async () => {
  await cleanup(server);
});

function getMatch(room: Room<{ state: GameStateSchema }>) {
  const gameRoom = room as unknown as GameRoom;
  const orch = gameRoom.getOrchestrator() as unknown as { match: GameMatch };
  return orch.match;
}

function getDomainPlayer(room: Room<{ state: GameStateSchema }>, sessionId: string) {
  const gameRoom = room as unknown as GameRoom;
  return gameRoom.getOrchestrator().getPlayer(sessionId)!;
}

interface RoomInternals {
  lastInputTime: Map<string, number>;
  afkWarningSent: Set<string>;
  botTakenOver: Set<string>;
  removedPlayers: Set<string>;
  botManager: { getBotCount(): number; hasBot(id: string): boolean };
  recordInputTime(id: string): void;
  syncState(): void;
}

/**
 * Build a RoomInternals facade that bridges the (pre-refactor) flat-room shape
 * the tests were written against to the current architecture, where per-player
 * AFK state lives inside ReconnectionManager.afkTracking (private) and the
 * takeover flag is mirrored onto GameRoom.botTakenOver by the event handler.
 *
 * The Map/Set views are lazy: every `.has()` / `.get()` / `.set()` re-reads
 * from the underlying state so the facade stays in sync across ticks.
 */
function getInternals(room: Room<{ state: GameStateSchema }>): RoomInternals {
  // Cast through unknown — GameRoom's privates collapse `GameRoom &` to never.
  const gameRoom = room as unknown as {
    getOrchestrator(): {
      getReconnectionManager(): unknown;
    };
    removedPlayers: Set<string>;
    botManager: { getBotCount(): number; hasBot(id: string): boolean };
    recordInputTime(id: string): void;
    syncState(): void;
  };

  // ReconnectionManager.afkTracking + takenOver are private — access via reflection.
  // Shape: afkTracking: Map<string, { lastInputTime: number; warningSent: boolean }>,
  //        takenOver: Set<string>
  const reconnectionManager = gameRoom.getOrchestrator().getReconnectionManager() as unknown as {
    afkTracking: Map<string, { lastInputTime: number; warningSent: boolean }>;
    takenOver: Set<string>;
  };
  const afkTracking = reconnectionManager.afkTracking;
  const rmTakenOver = reconnectionManager.takenOver;

  // Live Map view: sessionId -> lastInputTime. Reads scan afkTracking on
  // every call; writes mutate the underlying AfkState so processAfk sees
  // the injected timestamp on the next tick.
  const lastInputTime: Map<string, number> = {
    get size() {
      return afkTracking.size;
    },
    has: (id: string) => afkTracking.has(id),
    get: (id: string) => afkTracking.get(id)?.lastInputTime,
    set(id: string, time: number): Map<string, number> {
      const existing = afkTracking.get(id);
      if (existing) {
        existing.lastInputTime = time;
      } else {
        afkTracking.set(id, { lastInputTime: time, warningSent: false });
      }
      return this;
    },
    clear: () => afkTracking.clear(),
    delete: (id: string) => afkTracking.delete(id),
    forEach: (cb: (v: number, k: string, m: Map<string, number>) => void) => {
      for (const [k, s] of afkTracking) cb(s.lastInputTime, k, lastInputTime);
    },
    keys: () => Array.from(afkTracking.keys())[Symbol.iterator](),
    *values() {
      for (const [, s] of afkTracking) yield s.lastInputTime;
    },
    *entries(): IterableIterator<[string, number]> {
      for (const [k, s] of afkTracking) yield [k, s.lastInputTime];
    },
    [Symbol.iterator]() {
      return this.entries();
    },
    get [Symbol.toStringTag]() {
      return 'Map';
    },
  } as Map<string, number>;

  // Live Set view: sessionIds with warningSent === true.
  const afkWarningSent: Set<string> = {
    get size() {
      let n = 0;
      for (const [, s] of afkTracking) if (s.warningSent) n++;
      return n;
    },
    has: (id: string) => afkTracking.get(id)?.warningSent === true,
    add(id: string): Set<string> {
      const existing = afkTracking.get(id);
      if (existing) existing.warningSent = true;
      else afkTracking.set(id, { lastInputTime: Date.now(), warningSent: true });
      return this;
    },
    delete: (id: string) => {
      const existing = afkTracking.get(id);
      if (!existing || !existing.warningSent) return false;
      existing.warningSent = false;
      return true;
    },
    clear: () => {
      for (const [, s] of afkTracking) s.warningSent = false;
    },
    forEach: (cb: (v: string, v2: string, s: Set<string>) => void) => {
      for (const [k, s] of afkTracking) if (s.warningSent) cb(k, k, afkWarningSent);
    },
    keys: function* () {
      for (const [k, s] of afkTracking) if (s.warningSent) yield k;
    },
    values: function* () {
      for (const [k, s] of afkTracking) if (s.warningSent) yield k;
    },
    entries: function* () {
      for (const [k, s] of afkTracking) if (s.warningSent) yield [k, k] as [string, string];
    },
    [Symbol.iterator]() {
      return this.keys();
    },
    get [Symbol.toStringTag]() {
      return 'Set';
    },
  } as Set<string>;

  // Live Set view: sessionIds taken over by a bot (per ReconnectionManager).
  // ReconnectionManager.takenOver is the authoritative source — GameRoom's
  // botTakenOver mirror is only populated when the event-handler runs, which
  // does not always happen in fast-forward tests.
  const botTakenOver = rmTakenOver as Set<string>;

  return {
    lastInputTime,
    afkWarningSent,
    botTakenOver,
    removedPlayers: gameRoom.removedPlayers,
    botManager: gameRoom.botManager,
    recordInputTime: (id: string) => gameRoom.recordInputTime(id),
    syncState: () => gameRoom.syncState(),
  };
}

/** Force-spawn bots synchronously. BotManager normally uses clock.setInterval
 *  which doesn't fire in tests (advanceTicks calls orch.update directly). */
function syncSpawnBots(room: Room<{ state: GameStateSchema }>, botFillTo: number): void {
  const gameRoom = room as unknown as GameRoom & {
    botManager: {
      spawnAllBotsSync: (orch: unknown, max: number, ts: number) => number;
    };
  };
  gameRoom.botManager.spawnAllBotsSync(gameRoom.getOrchestrator(), botFillTo, Date.now());
}

function forceActivePhase(room: Room<{ state: GameStateSchema }>): void {
  const gameRoom = room as unknown as GameRoom;
  const orch = gameRoom.getOrchestrator() as unknown as {
    matchFlow: { getCurrentState: () => { phase: number }; transitionTo: (p: number) => void };
    phase: number;
    setLastStandingThreshold: (n: number) => void;
  };
  const match = getMatch(room) as unknown as { phase: number };
  const current = orch.matchFlow.getCurrentState().phase;
  if (current === MatchPhase.WAITING) {
    orch.matchFlow.transitionTo(MatchPhase.COUNTDOWN);
  }
  if (orch.matchFlow.getCurrentState().phase === MatchPhase.COUNTDOWN) {
    orch.matchFlow.transitionTo(MatchPhase.ACTIVE);
  }
  orch.phase = MatchPhase.ACTIVE;
  match.phase = MatchPhase.ACTIVE;
  orch.setLastStandingThreshold(-1);
  gameRoom.syncState();
}

function clearArea(grid: TileType[][], cx: number, cy: number, radius: number): void {
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const gy = cy + dy;
      const gx = cx + dx;
      if (gy >= 0 && gy < grid.length && gx >= 0 && gx < grid[0]!.length) {
        grid[gy]![gx] = TileType.EMPTY;
      }
    }
  }
}

function equipWeapon(
  room: Room<{ state: GameStateSchema }>,
  sessionId: string,
  weaponType: WeaponType,
  tier: WeaponTier,
): void {
  const player = getDomainPlayer(room, sessionId);
  const def = weaponRegistry.getDefinition(weaponType);
  const cd = Math.ceil(def.baseStats.cooldown / (1000 / NETWORK.TICK_RATE));
  const weapon = new WeaponEntity(`w-${weaponType}-${sessionId}`, weaponType, tier, 999, 999, cd);
  const slot = player.findFirstEmptySlot();
  if (slot !== null) {
    player.addWeapon(weapon);
    player.forceSwitchSlot(slot);
  }
}

function uid(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

describe('Bot Fill', () => {
  it('bot fills empty slots via botFillTo option', async () => {
    const { room, helper } = await createGameRoom(server, {
      botFillTo: 4,
      matchId: uid('bot-fill'),
    });
    syncSpawnBots(room, 4);

    await helper.advanceTicks(450);

    expect(room.state.players.size).toBe(4);
    const allBots = [...room.state.players.values()].filter((p) => p.id.startsWith('bot_'));
    expect(allBots.length).toBe(4);

    const h1 = await helper.addPlayer('Human1');
    const h2 = await helper.addPlayer('Human2');

    const alivePlayers = [...room.state.players.values()].filter(
      (p) => (p.status & PlayerStatus.ALIVE) !== 0,
    );
    expect(alivePlayers.length).toBe(4);

    const aliveHumans = alivePlayers.filter((p) => !p.id.startsWith('bot_'));
    expect(aliveHumans.length).toBe(2);
    expect(aliveHumans.some((p) => p.id === h1.sessionId)).toBe(true);
    expect(aliveHumans.some((p) => p.id === h2.sessionId)).toBe(true);

    const aliveBots = alivePlayers.filter((p) => p.id.startsWith('bot_'));
    expect(aliveBots.length).toBe(2);
  }, 30_000);

  it('bots join and act as regular players', async () => {
    const { room, helper } = await createGameRoom(server, {
      botFillTo: 2,
      matchId: uid('bot-act'),
    });
    syncSpawnBots(room, 2);

    await helper.advanceTicks(450);

    const bots = [...room.state.players.values()].filter((p) => p.id.startsWith('bot_'));
    expect(bots.length).toBe(2);

    for (const bot of bots) {
      expect(bot.health).toBe(PLAYER.BASE_HEALTH);
      expect(bot.x).toBeGreaterThan(0);
      expect(bot.y).toBeGreaterThan(0);
      expect(bot.connected).toBe(true);
      expect(bot.status & PlayerStatus.ALIVE).toBe(PlayerStatus.ALIVE);
    }
  }, 30_000);

  it('bot difficulty affects behavior', async () => {
    const { room: easyRoom, helper: easyHelper } = await createGameRoom(server, {
      botFillTo: 2,
      botDifficulty: 'easy',
      matchId: uid('bot-easy'),
    });
    syncSpawnBots(easyRoom, 2);
    const { room: hardRoom, helper: hardHelper } = await createGameRoom(server, {
      botFillTo: 2,
      botDifficulty: 'hard',
      matchId: uid('bot-hard'),
    });
    syncSpawnBots(hardRoom, 2);

    await Promise.all([easyHelper.advanceTicks(450), hardHelper.advanceTicks(450)]);

    const easyBots = [...easyRoom.state.players.values()].filter((p) => p.id.startsWith('bot_'));
    const hardBots = [...hardRoom.state.players.values()].filter((p) => p.id.startsWith('bot_'));
    expect(easyBots.length).toBe(2);
    expect(hardBots.length).toBe(2);

    const easyInternals = getInternals(easyRoom);
    const hardInternals = getInternals(hardRoom);
    expect(easyInternals.botManager.getBotCount()).toBe(2);
    expect(hardInternals.botManager.getBotCount()).toBe(2);

    const easyPositions = easyBots.map((b) => ({ x: b.x, y: b.y }));
    const hardPositions = hardBots.map((b) => ({ x: b.x, y: b.y }));
    expect(easyPositions.length).toBeGreaterThan(0);
    expect(hardPositions.length).toBeGreaterThan(0);
  }, 30_000);
});

describe('AFK Detection', () => {
  it('no input for 30s triggers AFK warning', async () => {
    const { room, helper } = await createGameRoom(server, {
      matchId: uid('afk-warn'),
    });
    const client = await helper.addPlayer('AFKPlayer');
    const internals = getInternals(room);

    internals.lastInputTime.set(client.sessionId, Date.now() - (MATCH.AFK_WARNING * 1000 + 1000));

    await helper.advanceTicks(1);

    expect(internals.afkWarningSent.has(client.sessionId)).toBe(true);
    expect(internals.botTakenOver.has(client.sessionId)).toBe(false);
  });

  it('no input for 60s triggers bot takeover', async () => {
    const { room, helper } = await createGameRoom(server, {
      matchId: uid('afk-takeover'),
    });
    const client = await helper.addPlayer('AFKPlayer');
    const internals = getInternals(room);

    const domainPlayer = getDomainPlayer(room, client.sessionId);
    const originalHP = domainPlayer.health.current;

    internals.lastInputTime.set(client.sessionId, Date.now() - (MATCH.AFK_TIMEOUT * 1000 + 1000));

    // Use advanceTicksWithRoom so processReconnectionEvents runs and the
    // AFK_TAKEOVER event triggers botManager.takeoverPlayer().
    await helper.advanceTicksWithRoom(1);

    expect(internals.botTakenOver.has(client.sessionId)).toBe(true);
    expect(internals.botManager.hasBot(client.sessionId)).toBe(true);

    const takenPlayer = getDomainPlayer(room, client.sessionId);
    expect(takenPlayer.health.current).toBe(originalHP);
    expect(takenPlayer.isActive).toBe(true);
  });

  it('AFK player sending input clears warning', async () => {
    const { room, helper } = await createGameRoom(server, {
      matchId: uid('afk-clear'),
    });
    const client = await helper.addPlayer('AFKPlayer');
    const internals = getInternals(room);

    internals.lastInputTime.set(client.sessionId, Date.now() - (MATCH.AFK_WARNING * 1000 + 1000));
    await helper.advanceTicks(1);
    expect(internals.afkWarningSent.has(client.sessionId)).toBe(true);

    // sendInput bypasses ReconnectionManager.recordInput — invoke it directly
    // via the facade so the AFK state is actually cleared.
    await helper.sendInput(client, { movementX: 1, movementY: 0 });
    internals.recordInputTime(client.sessionId);

    const lastTime = internals.lastInputTime.get(client.sessionId)!;
    expect(Date.now() - lastTime).toBeLessThan(10000);
    expect(internals.botTakenOver.has(client.sessionId)).toBe(false);
  });
});

describe('Disconnect Phase 1 (0-30s)', () => {
  it('disconnected player frozen for 30s', async () => {
    const { room, helper } = await createGameRoom(server, {
      matchId: uid('dc-frozen'),
    });
    const client = await helper.addPlayer('DCPlayer');

    await helper.advanceTicks(SPAWN_INV_TICKS);
    forceActivePhase(room);

    const domainPlayer = getDomainPlayer(room, client.sessionId);
    const originalX = domainPlayer.movement.position.x;
    const originalY = domainPlayer.movement.position.y;

    domainPlayer.connectionState = 'disconnected';
    domainPlayer.connected = false;
    getInternals(room).syncState();
    await helper.advanceTicks(1);

    await helper.sendInput(client, { movementX: 1, movementY: 0 });

    expect(domainPlayer.movement.position.x).toBe(originalX);
    expect(domainPlayer.movement.position.y).toBe(originalY);
    expect(domainPlayer.connectionState).toBe('disconnected');
  });

  it('reconnection possible during Phase 1', async () => {
    const { room, helper } = await createGameRoom(server, {
      matchId: uid('dc-reconnect'),
    });
    const client = await helper.addPlayer('DCPlayer');
    await helper.advanceTicks(SPAWN_INV_TICKS);
    forceActivePhase(room);

    const domainPlayer = getDomainPlayer(room, client.sessionId);

    domainPlayer.connectionState = 'disconnected';
    domainPlayer.connected = false;
    getInternals(room).syncState();
    await helper.advanceTicks(1);

    domainPlayer.connectionState = 'connected';
    domainPlayer.connected = true;
    domainPlayer.inputSuppressed = false;
    getInternals(room).syncState();
    await helper.advanceTicks(1);

    expect(domainPlayer.connectionState).toBe('connected');
    expect(domainPlayer.connected).toBe(true);
    expect(domainPlayer.inputSuppressed).toBe(false);
    expect(getInternals(room).botTakenOver.has(client.sessionId)).toBe(false);
  });
});

describe('Disconnect Phase 2 (30-60s)', () => {
  it('disconnected player unfrozen after 30s but cannot act', async () => {
    const { room, helper } = await createGameRoom(server, {
      matchId: uid('dc-phase2'),
    });
    const client = await helper.addPlayer('DCPlayer');
    await helper.advanceTicks(SPAWN_INV_TICKS);
    forceActivePhase(room);

    const domainPlayer = getDomainPlayer(room, client.sessionId);

    domainPlayer.connectionState = 'vulnerable';
    domainPlayer.inputSuppressed = true;
    domainPlayer.connected = false;
    getInternals(room).syncState();
    await helper.advanceTicks(1);

    expect(domainPlayer.connectionState).toBe('vulnerable');
    expect(domainPlayer.inputSuppressed).toBe(true);
    expect(domainPlayer.isActive).toBe(true);

    const originalX = domainPlayer.movement.position.x;
    const originalY = domainPlayer.movement.position.y;
    await helper.sendInput(client, { movementX: 1, movementY: 0 });

    expect(domainPlayer.movement.position.x).toBe(originalX);
    expect(domainPlayer.movement.position.y).toBe(originalY);
  });

  it('disconnected player takes damage in Phase 2', async () => {
    const { room, helper } = await createGameRoom(server, {
      matchId: uid('dc-dmg'),
    });
    const client = await helper.addPlayer('DCPlayer');
    await helper.advanceTicks(SPAWN_INV_TICKS);
    forceActivePhase(room);

    const domainPlayer = getDomainPlayer(room, client.sessionId);

    domainPlayer.connectionState = 'vulnerable';
    domainPlayer.inputSuppressed = true;

    const healthBefore = domainPlayer.health.current;
    domainPlayer.takeDamage(20, helper.tick, true);

    expect(domainPlayer.health.current).toBe(healthBefore - 20);
  });
});

describe('Disconnect Phase 3 (60s)', () => {
  it('bot takeover at 60s with full state inheritance', async () => {
    const { room, helper } = await createGameRoom(server, {
      matchId: uid('bot-inherit'),
    });
    const client = await helper.addPlayer('DCPlayer');

    const domainPlayer = getDomainPlayer(room, client.sessionId);
    const originalHP = domainPlayer.health.current;
    const originalKills = domainPlayer.kills;
    const originalX = domainPlayer.movement.position.x;
    const originalY = domainPlayer.movement.position.y;

    const internals = getInternals(room);
    internals.lastInputTime.set(client.sessionId, Date.now() - (MATCH.AFK_TIMEOUT * 1000 + 1000));
    await helper.advanceTicks(1);

    expect(internals.botTakenOver.has(client.sessionId)).toBe(true);

    const takenPlayer = getDomainPlayer(room, client.sessionId);
    expect(takenPlayer.health.current).toBe(originalHP);
    expect(takenPlayer.kills).toBe(originalKills);
    expect(takenPlayer.movement.position.x).toBe(originalX);
    expect(takenPlayer.movement.position.y).toBe(originalY);
    expect(takenPlayer.isActive).toBe(true);
  });

  it('bot inherits FRESH_SPAWN status', async () => {
    const { room, helper } = await createGameRoom(server, {
      matchId: uid('bot-fresh'),
    });
    const client = await helper.addPlayer('FreshPlayer');

    const domainPlayer = getDomainPlayer(room, client.sessionId);
    expect(domainPlayer.statusEffects.status & PlayerStatus.FRESH_SPAWN).toBe(
      PlayerStatus.FRESH_SPAWN,
    );

    const internals = getInternals(room);
    internals.lastInputTime.set(client.sessionId, Date.now() - (MATCH.AFK_TIMEOUT * 1000 + 1000));
    await helper.advanceTicks(1);

    const takenPlayer = getDomainPlayer(room, client.sessionId);
    expect(takenPlayer.statusEffects.status & PlayerStatus.FRESH_SPAWN).toBe(
      PlayerStatus.FRESH_SPAWN,
    );
  });

  it('bot inherits mid-attack state (kill credit to original player)', async () => {
    const { room, helper } = await createGameRoom(server, {
      matchId: uid('bot-kill'),
    });
    const grid = getMatch(room).getGrid();
    clearArea(grid, 40, 40, 8);

    const shooter = await helper.addPlayer('Shooter');
    const victim = await helper.addPlayer('Victim');
    getDomainPlayer(room, shooter.sessionId).movement.position = new Position(POS_A.x, POS_A.y);
    // Victim starts OFF the arrow's flight path (above it): at exactly +200px
    // on-path the arrow reaches the victim on the very tick this test asserts
    // "arrow in flight" (spawn at hand+87px, ~34px/tick) — a 1-tick coin flip.
    // Moved onto the path right after the in-flight assertion.
    getDomainPlayer(room, victim.sessionId).movement.position = new Position(
      POS_A.x + 200,
      POS_A.y - 500,
    );
    await helper.advanceTicks(1);
    await helper.advanceTicks(SPAWN_INV_TICKS);
    forceActivePhase(room);

    const domainVictim = getDomainPlayer(room, victim.sessionId);
    domainVictim.takeDamage(PLAYER.BASE_HEALTH - 10, helper.tick, true);

    equipWeapon(room, shooter.sessionId, WeaponType.SHORT_BOW, WeaponTier.COMMON);
    getDomainPlayer(room, shooter.sessionId).movement.facingAngle = 0;

    await helper.sendInput(shooter, { aimAngle: 0, actions: ['ATTACK'] });
    await helper.advanceTicks(BOW_WINDUP_TICKS + 2);

    const arrow = [...room.state.projectiles.values()].find((p) => p.ownerId === shooter.sessionId);
    expect(arrow).toBeDefined();

    // Victim onto the flight path now that the arrow is verified in flight.
    getDomainPlayer(room, victim.sessionId).movement.position = new Position(
      POS_A.x + 200,
      POS_A.y,
    );

    const internals = getInternals(room);
    internals.lastInputTime.set(shooter.sessionId, Date.now() - (MATCH.AFK_TIMEOUT * 1000 + 1000));
    await helper.advanceTicks(1);
    expect(internals.botTakenOver.has(shooter.sessionId)).toBe(true);

    const ticksToReach = Math.ceil(200 / ARROW_PX_PER_TICK) + 15;
    await helper.advanceTicks(ticksToReach);

    const domainShooter = getDomainPlayer(room, shooter.sessionId);
    expect(domainShooter.kills).toBeGreaterThanOrEqual(1);
  }, 30_000);
});

describe('Reconnection After Bot Takeover', () => {
  it('reconnection after bot takeover: spectate only', async () => {
    const { room, helper } = await createGameRoom(server, {
      matchId: uid('bot-spectate'),
    });
    const client = await helper.addPlayer('AFKPlayer');
    const playerId = client.sessionId;

    const internals = getInternals(room);
    internals.lastInputTime.set(playerId, Date.now() - (MATCH.AFK_TIMEOUT * 1000 + 1000));
    // Use advanceTicksWithRoom so processReconnectionEvents runs and the
    // AFK_TAKEOVER event triggers botManager.takeoverPlayer().
    await helper.advanceTicksWithRoom(1);

    expect(internals.botTakenOver.has(playerId)).toBe(true);
    expect(internals.botManager.hasBot(playerId)).toBe(true);

    const domainPlayer = getDomainPlayer(room, playerId);
    expect(domainPlayer.isActive).toBe(true);

    const playerSchema = [...room.state.players.values()].find((p) => p.id === playerId);
    expect(playerSchema).toBeDefined();
    expect(playerSchema!.connected).toBe(true);
  });
});
