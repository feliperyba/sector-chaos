import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { ColyseusTestServer } from '@colyseus/testing';
import type { Room } from 'colyseus';
import { createTestServer, cleanup } from '../helpers/test-server';
import { createGameRoom } from '../helpers/game-room-helper';
import {
  PLAYER,
  NETWORK,
  GRID,
  WeaponType,
  WeaponTier,
  TileType,
  MatchPhase,
  weaponRegistry,
} from '@sector-battle/shared';
import type { GameStateSchema } from '../../src/infrastructure/schemas/GameStateSchema';
import { GameRoom } from '../../src/room/GameRoom';
import type { GameMatch } from '../../src/domain/aggregates/GameMatch';
import { WeaponEntity } from '../../src/domain/entities/index';
import { Position } from '../../src/domain/value-objects/index';
import type { Destructible } from '../../src/domain/entities/Destructible';
import { WorldSnapshot } from '../../src/ai/WorldSnapshot';
import { DestructibleDamageHandler } from '../../src/application/commands/DestructibleDamageHandler';
import type { GameEvent } from '../../src/domain/events/index';

/**
 * Map-polish ticket 07 — room-level end-to-end: the map's light-prop
 * destructible entities are live, damageable, SERVER-AUTHORITATIVE state.
 *
 * Each damage pipeline (swept melee, thrown, projectile arrow) destroys a
 * REAL hydrated `'light'` entity from the procedural map (seed 42): the
 * `DestructibleDestroyed` broadcast fires on the EXPLOSION channel with the
 * entity's grid coords, and the entity disappears from the Colyseus schema
 * state. Also proves bot exposure is automatic (WorldSnapshot DTO + range
 * query) with zero special-casing.
 *
 * Attacks are sent in a bounded retry loop: the real-time tick timers make a
 * single windup input flaky about WHICH tick consumes it, so each test keeps
 * pressing the action until the entity dies or the loop budget is exhausted —
 * the assertions then require the death.
 */
describe('Light-prop destructible entities (map-polish ticket 07)', () => {
  let server: ColyseusTestServer;

  beforeAll(async () => {
    server = await createTestServer();
  });

  afterAll(async () => {
    await cleanup(server);
  });

  const SPAWN_INV_TICKS = Math.ceil(PLAYER.SPAWN_INVINCIBILITY * NETWORK.TICK_RATE);

  function getMatch(room: Room<{ state: GameStateSchema }>): GameMatch {
    const gameRoom = room as unknown as GameRoom;
    const orch = gameRoom.getOrchestrator() as unknown as { match: GameMatch };
    return orch.match;
  }

  function getDomainPlayer(room: Room<{ state: GameStateSchema }>, sessionId: string) {
    const gameRoom = room as unknown as GameRoom;
    return gameRoom.getOrchestrator().getPlayer(sessionId)!;
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

  function equipWeapon(
    room: Room<{ state: GameStateSchema }>,
    sessionId: string,
    weaponType: WeaponType,
  ): void {
    const player = getDomainPlayer(room, sessionId);
    const def = weaponRegistry.getDefinition(weaponType);
    const cd = Math.ceil(def.baseStats.cooldown / (1000 / NETWORK.TICK_RATE));
    const weapon = new WeaponEntity(
      `w-${weaponType}-${sessionId}`,
      weaponType,
      WeaponTier.COMMON,
      999,
      999,
      cd,
    );
    const slot = player.findFirstEmptySlot();
    if (slot !== null) {
      player.addWeapon(weapon);
      player.forceSwitchSlot(slot);
    }
  }

  /** A pickable real light entity: an EMPTY cardinal neighbour to stand on. */
  function pickLight(match: GameMatch): {
    light: Destructible;
    playerPos: Position;
    angle: number;
  } {
    const grid = match.getGrid();
    const dirs = [
      { dx: -1, dy: 0, angle: 0 }, // stand west, light to the EAST of the player
      { dx: 1, dy: 0, angle: Math.PI },
      { dx: 0, dy: -1, angle: Math.PI / 2 },
      { dx: 0, dy: 1, angle: -Math.PI / 2 },
    ];
    for (const light of match.getState().destructibles.values()) {
      if (light.type !== 'light') continue;
      const lx = Math.floor(light.position.x / GRID.TILE_SIZE);
      const ly = Math.floor(light.position.y / GRID.TILE_SIZE);
      for (const d of dirs) {
        const nx = lx + d.dx;
        const ny = ly + d.dy;
        const tile = grid[ny]?.[nx];
        if (tile !== TileType.EMPTY) continue;
        return {
          light,
          playerPos: new Position((nx + 0.5) * GRID.TILE_SIZE, (ny + 0.5) * GRID.TILE_SIZE),
          angle: d.angle,
        };
      }
    }
    throw new Error('no light entity with a free cardinal neighbour on seed 42');
  }

  interface DestroyedMsg {
    eventType: string;
    id: string;
    gridX: number;
    gridY: number;
    droppedLoot: unknown;
  }

  /**
   * Spy on the ROOM's broadcast (the server-side half of the wire contract).
   * @colyseus/testing's client-side `onMessage` delivery for room-level
   * broadcasts is not reliable in this harness (no other integration test
   * consumes one); asserting at the room boundary proves the
   * DestructibleDestroyed message is actually emitted with the right channel
   * + payload.
   */
  function spyBroadcasts(room: Room<{ state: GameStateSchema }>): DestroyedMsg[] {
    const seen: DestroyedMsg[] = [];
    const target = room as unknown as {
      broadcast: (channel: string, message: unknown) => void;
    };
    const original = target.broadcast.bind(room);
    target.broadcast = (channel: string, message: unknown) => {
      if (channel === 'explosion') {
        const msg = message as DestroyedMsg;
        if (msg.eventType === 'DestructibleDestroyed') seen.push(msg);
      }
      original(channel, message);
    };
    return seen;
  }

  interface RoomFixture {
    room: Room<{ state: GameStateSchema }>;
    helper: Awaited<ReturnType<typeof createGameRoom>>['helper'];
    match: GameMatch;
    client: Awaited<ReturnType<typeof createGameRoom>> extends never ? never : TestClientLike;
  }
  type TestClientLike = Awaited<ReturnType<ColyseusTestServer['connectTo']>>;

  async function setupRoom(): Promise<RoomFixture> {
    const { room, helper } = await createGameRoom(server, { seed: 42, botFillTo: 0 });
    const match = getMatch(room);
    const client = await helper.addPlayer('Smasher');
    await helper.advanceTicks(SPAWN_INV_TICKS);
    forceActivePhase(room);
    return { room, helper, match, client };
  }

  /** Position the player beside the light and keep attacking until it dies. */
  async function attackUntilDestroyed(
    fixture: RoomFixture,
    target: Destructible,
    playerPos: Position,
    angle: number,
    action: 'ATTACK' | 'THROW',
    budgetTicks: number,
  ): Promise<void> {
    const { helper, room, match, client } = fixture;
    const player = getDomainPlayer(room, client.sessionId);
    player.movement.position = playerPos;
    await helper.advanceTicks(1);
    player.movement.facingAngle = angle;
    for (let spent = 0; spent < budgetTicks && match.getState().destructibles.has(target.id); ) {
      await helper.sendInput(client, { aimAngle: angle, actions: [action] });
      const batch = 4;
      await helper.advanceTicks(batch);
      spent += batch;
    }
  }

  it('hydrates light entities into the schema state (wire type 4, hp 1/1)', async () => {
    const { room, helper } = await setupRoom();
    await helper.advanceTicks(5);
    const schemaLights = [...room.state.destructibles.values()].filter((d) => d.type === 4);
    // seed-42 census re-measured 21→20 by ticket-14 WallCompositionPass
    // cascade (7dae2174: orphan indestructible stubs I→EMPTY + orphaned
    // destructible shards D→CRATE shifted the sector entity pools the light
    // ladder reads — seed 42 net −1: crystal 9→7, poi-pool 6→9, route 5→3);
    // audit gate 0/0/0. Matches PINNED_CONVERTED[42] (LightPropEntities.test.ts).
    // Ticket-25 (prefab library + smart reuse) re-measure: 20→23 — the prefab
    // placement pass (PIPELINE 10) shifted the entity pools the light ladder
    // reads (same sanctioned cascade class); matches the re-pinned
    // lights-seed-42.json golden + PINNED_CONVERTED[42].
    // Round-7 (v16 cohesion) re-measure: 23→19 — the structure-backed chest
    // nesting + framing-first prefab scan shifted the entity pools again
    // (same sanctioned cascade class); matches the re-pinned lights-seed-42
    // golden + PINNED_CONVERTED[42].
    // Round-8 (v17 run-join guard) re-measure: 19→22 — stamps never create a
    // 3-cardinal wall junction, shifting the entity pools through the same
    // sanctioned cascade class; matches the re-pinned lights-seed-42 golden
    // + PINNED_CONVERTED[42].
    expect(schemaLights.length).toBe(22);
    for (const d of schemaLights) {
      expect(d.id.startsWith('dest_light_')).toBe(true);
      expect(d.hp).toBe(1);
      expect(d.maxHp).toBe(1);
      expect(d.isDestroyed).toBe(false);
    }
  }, 30_000);

  it('melee destroys a light entity → DestructibleDestroyed broadcast + schema delete', async () => {
    const fixture = await setupRoom();
    const { light, playerPos, angle } = pickLight(fixture.match);
    expect(fixture.match.getState().destructibles.has(light.id)).toBe(true);
    const destroyed = spyBroadcasts(fixture.room);

    await attackUntilDestroyed(fixture, light, playerPos, angle, 'ATTACK', 60);
    await fixture.helper.advanceTicks(8);

    expect(fixture.match.getState().destructibles.has(light.id)).toBe(false);
    expect(fixture.room.state.destructibles.get(light.id)).toBeUndefined();
    const msg = destroyed.find((m) => m.id === light.id);
    expect(msg, 'DestructibleDestroyed broadcast for the light entity').toBeDefined();
    expect(msg!.gridX).toBe(Math.floor(light.position.x / GRID.TILE_SIZE));
    expect(msg!.gridY).toBe(Math.floor(light.position.y / GRID.TILE_SIZE));
    expect(msg!.droppedLoot).toBeNull(); // no loot drop (ticket 07 ruling)
  }, 60_000);

  it('thrown weapon destroys a light entity → broadcast + schema delete', async () => {
    const fixture = await setupRoom();
    const { light, playerPos, angle } = pickLight(fixture.match);
    equipWeapon(fixture.room, fixture.client.sessionId, WeaponType.THROWING_AXE);
    const destroyed = spyBroadcasts(fixture.room);

    await attackUntilDestroyed(fixture, light, playerPos, angle, 'THROW', 100);

    expect(fixture.match.getState().destructibles.has(light.id)).toBe(false);
    expect(fixture.room.state.destructibles.get(light.id)).toBeUndefined();
    const msg = destroyed.find((m) => m.id === light.id);
    expect(msg).toBeDefined();
    expect(msg!.gridX).toBe(Math.floor(light.position.x / GRID.TILE_SIZE));
    expect(msg!.gridY).toBe(Math.floor(light.position.y / GRID.TILE_SIZE));
  }, 60_000);

  it('projectile arrow destroys a light entity → broadcast + schema delete', async () => {
    const fixture = await setupRoom();
    const { light, playerPos, angle } = pickLight(fixture.match);
    equipWeapon(fixture.room, fixture.client.sessionId, WeaponType.SHORT_BOW);
    const destroyed = spyBroadcasts(fixture.room);

    // SHORT_BOW windup ~5 ticks; the arrow covers 128px in ~4 ticks.
    await attackUntilDestroyed(fixture, light, playerPos, angle, 'ATTACK', 100);

    expect(fixture.match.getState().destructibles.has(light.id)).toBe(false);
    expect(fixture.room.state.destructibles.get(light.id)).toBeUndefined();
    const msg = destroyed.find((m) => m.id === light.id);
    expect(msg).toBeDefined();
    expect(msg!.gridX).toBe(Math.floor(light.position.x / GRID.TILE_SIZE));
    expect(msg!.gridY).toBe(Math.floor(light.position.y / GRID.TILE_SIZE));
  }, 60_000);

  it('WorldSnapshot exposes light entities to bots automatically (DTO + range query)', async () => {
    const { match } = await setupRoom();
    const { light } = pickLight(match);

    const snapshot = new WorldSnapshot();
    snapshot.setMapBounds(80 * GRID.TILE_SIZE, 80 * GRID.TILE_SIZE);
    // BotSystem syncs every tick; the destructible DTOs fill on the first
    // sync but the SPATIAL GRID rebuilds every 5th tick — sync past one
    // rebuild window, exactly like production.
    for (let i = 0; i < 6; i++) snapshot.sync(match.getState());

    const dto = snapshot.getDestructibleById(light.id);
    expect(dto).toBeDefined();
    expect(dto!.type).toBe('light'); // BotDestructibles classifiers: ordinary smashable
    expect(dto!.hp).toBe(1);
    expect(dto!.maxHp).toBe(1);
    expect(dto!.isDestroyed).toBe(false);

    // The spatial-grid range query (BotPerception's destructible scan) sees it.
    let seen = 0;
    snapshot.queryDestructibles(light.position.x, light.position.y, GRID.TILE_SIZE, () => {
      seen++;
    });
    expect(seen).toBeGreaterThanOrEqual(1);
  }, 30_000);

  // ── Map-polish ticket 09 — the destruction-loop regression sweep ──────────
  // Destroy N lights across the map mid-match via the damage pipeline
  // (DestructibleDamageHandler — the exact command layer every combat path
  // funnels through), fast-forwarded with advanceTicks. Locks in: exactly one
  // DestructibleDestroyed broadcast per entity with correct grid coords,
  // schema-state absence thereafter, zero server errors, and no-op re-hits on
  // destroyed ids.
  describe('destruction-loop regression sweep (map-polish ticket 09)', () => {
    const N = 5;

    /** N lights spread ACROSS the map (evenly spaced along the x axis). */
    function pickSpreadLights(match: GameMatch): Destructible[] {
      const lights = [...match.getState().destructibles.values()].filter((d) => d.type === 'light');
      expect(lights.length).toBe(22); // seed 42 census (21→20 t14; 20→23 r6 v15; 23→19 r7 v16; 19→22 r8 v17 run-join guard)
      const sorted = [...lights].sort((a, b) => a.position.x - b.position.x);
      const step = Math.floor(sorted.length / N);
      return Array.from({ length: N }, (_, i) => sorted[i * step]!);
    }

    it('destroying N lights: exactly one broadcast each, schema absence, no errors, no-op re-hits', async () => {
      const fixture = await setupRoom();
      const { helper, room, match } = fixture;
      const destroyed = spyBroadcasts(room);
      const targets = pickSpreadLights(match);

      // (c) no server errors/TypeErrors in logs — spy console.error for
      // the whole sweep (the sim logs unexpected failures there).
      const errors: string[] = [];
      const originalError = console.error;
      console.error = (...args: unknown[]) => {
        errors.push(args.map(String).join(' '));
        originalError(...args);
      };

      try {
        // Destroy via the damage pipeline: takeDamage →
        // destroyDestructible → match.emitEvent. The events ride the
        // match's event collector out through orchestrator.update()'s
        // drain — advanceTicks broadcasts them exactly like a real tick.
        // (No manual flush: step9 re-emits drained events, so flushing
        // here would double-broadcast.)
        const handler = new DestructibleDamageHandler(match);
        for (const target of targets) {
          handler.handleDamage([target.id], match, [], WeaponType.FISTS);
        }
        // Fast-forward: the loot sweep + state mapper + schema sync run.
        await helper.advanceTicks(4);

        // (a) each destruction emitted EXACTLY ONE DestructibleDestroyed
        // with the entity's correct grid coords.
        for (const target of targets) {
          const msgs = destroyed.filter((m) => m.id === target.id);
          expect(msgs, `exactly one destroy broadcast for ${target.id}`).toHaveLength(1);
          expect(msgs[0]!.gridX).toBe(Math.floor(target.position.x / GRID.TILE_SIZE));
          expect(msgs[0]!.gridY).toBe(Math.floor(target.position.y / GRID.TILE_SIZE));
          expect(msgs[0]!.droppedLoot).toBeNull();
        }
        // No collateral light destruction beyond the N targets.
        expect(destroyed.filter((m) => m.id.startsWith('dest_light_'))).toHaveLength(N);

        // (b) entities absent from schema state (and domain state)
        // thereafter — counts converge toward zero as lights die.
        for (const target of targets) {
          expect(match.getState().destructibles.has(target.id)).toBe(false);
          expect(room.state.destructibles.get(target.id)).toBeUndefined();
        }
        const schemaLights = [...room.state.destructibles.values()].filter(
          (d) => d.type === 4, // DESTRUCTIBLE_TYPE_ORDER.light wire index
        );
        expect(schemaLights).toHaveLength(22 - N); // seed-42 census, v17 run-join-guard re-pin

        // (d) subsequent hits on the destroyed ids are no-ops: no events,
        // no broadcasts, no schema resurrection.
        const broadcastsBefore = destroyed.length;
        const events: GameEvent[] = [];
        for (const target of targets) {
          handler.handleDamage([target.id], match, events, WeaponType.FISTS);
        }
        expect(events).toHaveLength(0);
        await helper.advanceTicks(2);
        expect(destroyed.length).toBe(broadcastsBefore);
        for (const target of targets) {
          expect(room.state.destructibles.get(target.id)).toBeUndefined();
        }

        // (c) the log spy stayed empty.
        expect(errors).toEqual([]);
      } finally {
        console.error = originalError;
      }
    }, 60_000);
  });
});
