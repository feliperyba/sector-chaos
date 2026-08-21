import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Server } from 'colyseus';
import type { ColyseusTestServer } from '@colyseus/testing';
import { setupServer } from '../../src/app.config.ts';
import { Matchmaker } from '../../src/matchmaking/Matchmaker.ts';
import type { SDKRoom } from '@colyseus/sdk';
import { bootTestServer, cleanup } from '../helpers/test-server.ts';
import { freezeServerWallClock } from '../helpers/test-utils.ts';

describe('Matchmaker', () => {
  let colyseus: ColyseusTestServer;

  beforeAll(async () => {
    const server = new Server();
    setupServer(server);
    colyseus = await bootTestServer(server);
  }, 30000);

  afterAll(async () => {
    await cleanup(colyseus);
  });

  async function createMatchmaker(): Promise<{
    room: Matchmaker;
    connectClient: (mmr?: number) => Promise<SDKRoom<Matchmaker>>;
  }> {
    const room = await colyseus.createRoom<Matchmaker>('matchmaking', { mode: 'battle_royale' });

    const connectClient = async (mmr: number = 1000): Promise<SDKRoom<Matchmaker>> => {
      return colyseus.connectTo(room, { mmr });
    };

    return { room, connectClient };
  }

  it('player enqueued on join', async () => {
    const { room, connectClient } = await createMatchmaker();
    await connectClient(1000);

    await room.waitForNextPatch();

    expect(room.state.players.size).toBe(1);
    expect(room.state.totalQueued).toBe(1);
  });

  it('player dequeued on cancel', async () => {
    const { room, connectClient } = await createMatchmaker();
    const client = await connectClient(1000);

    await room.waitForNextPatch();
    expect(room.state.totalQueued).toBe(1);

    client.send('cancel');
    await room.waitForNextPatch();

    expect(room.state.totalQueued).toBe(0);
  });

  it('player removed on leave', async () => {
    const { room, connectClient } = await createMatchmaker();
    const client = await connectClient(1000);

    await room.waitForNextPatch();
    expect(room.state.totalQueued).toBe(1);

    await client.leave();
    await room.waitForNextPatch();

    expect(room.state.totalQueued).toBe(0);
  });

  it('multiple players enqueued', async () => {
    const { room, connectClient } = await createMatchmaker();

    for (let i = 0; i < 5; i++) {
      await connectClient(1000 + i * 100);
    }

    await room.waitForNextPatch();

    expect(room.state.totalQueued).toBe(5);
  });

  it('onDispose clears tick interval', async () => {
    const { room, connectClient } = await createMatchmaker();
    await connectClient(1000);
    await room.waitForNextPatch();
    expect(room.state.totalQueued).toBe(1);
    room.onDispose();
    expect(room.state.totalQueued).toBe(1);
  });

  it('tick updates phase and attempts match with enough players', async () => {
    // [F3 de-flake] The old body slept a fixed 6.5s and asserted on live
    // state. `Matchmaker.onCreate` aligns the cycle to the wall-clock grid
    // (`cycleStartMs = now - (now % cycleIntervalMs)`), and with the default
    // 90s cycle the sleep sampled a random 6.5s slice of that grid: when the
    // boundary landed mid-sleep, createMatch() cleared the queue and the next
    // 1s checkCycle overwrote `playersFound = entries.size = 0` before the
    // assertion read it (~6.5/90 ≈ 7% flake per run). Deterministic rewrite
    // using the established F3 patterns: production env override to shorten
    // the cycle, freezeServerWallClock to pin the cycle during setup, and
    // authoritative-field polling instead of a wall-clock sleep.
    const savedCycleSeconds = process.env.MATCHMAKING_CYCLE_SECONDS;
    process.env.MATCHMAKING_CYCLE_SECONDS = '2';
    const cycleMs = 2000;

    let unfreeze: () => void = () => {};
    try {
      // Grid-headroom guard: create the room with >= 1s of headroom before
      // the cycle boundary so the elapsed value pinned by the freeze below
      // is strictly below the boundary even if room creation is delayed.
      while (Date.now() % cycleMs > cycleMs - 1000) {
        await new Promise((r) => setTimeout(r, 25));
      }

      const { room, connectClient } = await createMatchmaker();

      // Install AFTER creation: checkCycle() reads the GLOBAL Date.now()
      // (Matchmaker.ts:130), so pinning it pins `elapsed` — the boundary
      // cannot be crossed during the 48-connect setup however long it takes
      // under load. (Installing BEFORE creation would bind the frozen clock
      // at construction — deltaTime would stay 0 and checkCycle would never
      // fire again.) The room Clock keeps real time, so the 1s tick
      // heartbeat below still runs while frozen.
      const restore = freezeServerWallClock();
      unfreeze = () => restore();

      for (let i = 0; i < 48; i++) {
        await connectClient(1000);
      }

      await room.waitForNextPatch();

      expect(room.state.totalQueued).toBe(48);
      expect(room.state.currentPhase).toBe('primary');

      // Tick heartbeat while frozen: every checkCycle writes
      // `playersFound = entries.size`. Iteration-bounded because Date.now is
      // pinned (a clock deadline would never expire).
      for (let i = 0; i < 120 && room.state.playersFound !== 48; i++) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(room.state.playersFound).toBe(48);

      // Release the clock: Date.now jumps forward by the real setup
      // duration, pushing elapsed toward/past the cycle boundary; a
      // subsequent checkCycle fires createMatch() with all 48 queued.
      unfreeze();

      // Poll authoritative state until the match completes (entries are
      // drained only on a successful match attempt). playersFound spikes on
      // completion (+= matched count) but is overwritten to entries.size by
      // the NEXT 1s tick, so capture the max observed value.
      let maxPlayersFound = 0;
      let matched = false;
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        maxPlayersFound = Math.max(maxPlayersFound, room.state.playersFound);
        if (room.state.totalQueued === 0) {
          matched = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 25));
      }

      expect(matched).toBe(true);
      expect(room.state.totalQueued).toBe(0);
      expect(maxPlayersFound).toBeGreaterThan(0);
    } finally {
      unfreeze();
      if (savedCycleSeconds === undefined) {
        delete process.env.MATCHMAKING_CYCLE_SECONDS;
      } else {
        process.env.MATCHMAKING_CYCLE_SECONDS = savedCycleSeconds;
      }
    }
  }, 20000);
});
