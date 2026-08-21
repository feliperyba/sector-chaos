import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Client } from 'colyseus';
import { InputAction, NETWORK, netLogger, type InputMessage } from '@sector-battle/shared';
import { registerInputHandler, rateLimiter } from '../../../src/room/handlers/input.ts';
import type { GameOrchestrator } from '../../../src/application/services/GameOrchestrator.ts';

/**
 * Characterization test for the input wire handler (ticket #08, Step 5).
 *
 * Each case drives `registerInputHandler`'s captured `onMessage('input', cb)`
 * callback with a hand-built {@link InputMessage}-shaped payload and asserts
 * exactly what the orchestrator's `handleInput` receives: the call count, the
 * `action` enum arg, and a deep-equal `data` arg. No real orchestrator,
 * simulation, or room is spun up — the fake below implements only the surface
 * area the handler touches (`onMessage`, `getOrchestrator`, `recordInputTime`).
 *
 * IMPORTANT shape note (pinned by these tests): the MOVE branch at the top of
 * the handler fires whenever `mx != 0`, `my != 0`, OR `aimAngle` is a finite
 * number. So to isolate the per-action branches (ATTACK/DASH/THROW/PICKUP/
 * SWITCH_SLOT) we send `aimAngle: undefined` AND `mx = my = 0`. With those
 * values the enqueued action data legitimately contains `aimAngle: undefined`
 * (ATTACK/THROW) or `dx: 0, dy: 0` (DASH) — that is the real shape the handler
 * emits for an action with no movement/aim, not a test artifact.
 *
 * The wire bytes are JSON; payloads are constructed as plain objects. Unknown
 * action strings — BOTH kinds: plain out-of-union literals (lookup returns
 * undefined) AND prototype-named strings like 'constructor' (the plain-object
 * `INPUT_ACTION_MAP` lookup returns an inherited function/object, NOT
 * undefined) — non-object payloads, and rate-limit exhaustion must NOT throw
 * or enqueue. These tests pin the server-side shape so the shared
 * `InputMessage` type cannot drift from what the handler actually reads.
 */

/** A single recorded `handleInput` invocation. */
interface RecordedCall {
  playerId: string;
  action: InputAction;
  data: unknown;
  sequence: number;
}

/**
 * Fake orchestrator that captures `handleInput` calls in order. The handler
 * only calls `handleInput` (return value is ignored — the real impl returns
 * `[]`), so we model nothing else.
 */
class FakeOrchestrator {
  readonly calls: RecordedCall[] = [];

  handleInput(playerId: string, action: InputAction, data: unknown, sequence: number): unknown[] {
    this.calls.push({ playerId, action, data, sequence });
    return [];
  }
}

/**
 * Minimal `Client`. The handler only reads `client.sessionId`.
 */
function fakeClient(sessionId: string): Client {
  return { sessionId } as unknown as Client;
}

/**
 * Fake room that captures the `onMessage('input', cb)` callback so each test
 * can invoke it directly. Satisfies the (now-`InputMessage`-typed)
 * `InputHandlingRoom` interface exported from the handler module.
 */
class FakeRoom {
  private inputCallback: ((client: Client, data: InputMessage) => void) | null = null;
  readonly orchestrator = new FakeOrchestrator();
  readonly recordedInputTimes: string[] = [];

  onMessage(type: string, callback: (client: Client, data: InputMessage) => void): void {
    if (type === 'input') {
      this.inputCallback = callback;
    }
  }

  getOrchestrator(): GameOrchestrator {
    return this.orchestrator as unknown as GameOrchestrator;
  }

  recordInputTime(playerId: string): void {
    this.recordedInputTimes.push(playerId);
  }

  /** Invoke the captured input callback. Test-only entry point. */
  send(client: Client, data: InputMessage): void {
    if (!this.inputCallback) {
      throw new Error('registerInputHandler did not capture an input callback');
    }
    this.inputCallback(client, data);
  }
}

/** Build an action-only payload (no MOVE branch trigger). */
function actionOnlyPayload(
  sequence: number,
  actions: InputMessage['actions'],
  extra?: { targetId?: string; powerUpId?: string },
): InputMessage {
  return {
    movementX: 0,
    movementY: 0,
    // `aimAngle: undefined` keeps the MOVE branch asleep (see file header).
    aimAngle: undefined as unknown as number,
    sequence,
    actions,
    targetId: extra?.targetId,
    // powerUpId is intentionally not on the InputMessage type; the bracket
    // read in the handler is defensive. Only added when explicitly testing
    // the legacy powerUpId branch (case 8).
    ...(extra?.powerUpId !== undefined ? { powerUpId: extra.powerUpId } : {}),
  } as InputMessage;
}

describe('input wire handler — shape characterization', () => {
  let room: FakeRoom;

  beforeEach(() => {
    room = new FakeRoom();
    registerInputHandler(room);
  });

  it('1. MOVE with aimAngle set → enqueues {dx, dy, aimAngle, tick}', () => {
    const playerId = 'p1-move-aim';
    room.send(fakeClient(playerId), {
      movementX: 0.5,
      movementY: -0.25,
      aimAngle: 1.23,
      sequence: 7,
      actions: [],
    });

    expect(room.orchestrator.calls).toHaveLength(1);
    expect(room.orchestrator.calls[0]).toEqual({
      playerId,
      action: InputAction.MOVE,
      data: { dx: 0.5, dy: -0.25, aimAngle: 1.23, tick: 7 },
      sequence: 7,
    });
  });

  it('2. MOVE with aimAngle undefined → MOVE still enqueued when mx|my != 0', () => {
    const playerId = 'p2-move-no-aim';
    room.send(fakeClient(playerId), {
      movementX: 1,
      movementY: 0,
      aimAngle: undefined as unknown as number,
      sequence: 3,
      actions: [],
    });

    expect(room.orchestrator.calls).toHaveLength(1);
    expect(room.orchestrator.calls[0]).toEqual({
      playerId,
      action: InputAction.MOVE,
      data: { dx: 1, dy: 0, aimAngle: undefined, tick: 3 },
      sequence: 3,
    });
  });

  it('3. MOVE with mx=0, my=0, aimAngle undefined → NO enqueue (idle)', () => {
    const playerId = 'p3-move-idle';
    room.send(fakeClient(playerId), {
      movementX: 0,
      movementY: 0,
      aimAngle: undefined as unknown as number,
      sequence: 1,
      actions: [],
    });

    expect(room.orchestrator.calls).toHaveLength(0);
  });

  it('4. ATTACK (action-only) → {aimAngle: undefined, tick}', () => {
    const playerId = 'p4-attack';
    room.send(fakeClient(playerId), actionOnlyPayload(11, ['ATTACK']));

    expect(room.orchestrator.calls).toHaveLength(1);
    expect(room.orchestrator.calls[0]).toEqual({
      playerId,
      action: InputAction.ATTACK,
      data: { aimAngle: undefined, tick: 11 },
      sequence: 11,
    });
  });

  it('5. DASH (action-only) → {dx: 0, dy: 0, tick}', () => {
    const playerId = 'p5-dash';
    // DASH echoes mx/my into dx/dy. With mx=my=0 (required to keep the MOVE
    // branch asleep — see file header), dx/dy are both 0. The DASH shape is
    // what we are pinning here, not the movement values.
    room.send(fakeClient(playerId), actionOnlyPayload(5, ['DASH']));

    expect(room.orchestrator.calls).toHaveLength(1);
    expect(room.orchestrator.calls[0]).toEqual({
      playerId,
      action: InputAction.DASH,
      data: { dx: 0, dy: 0, tick: 5 },
      sequence: 5,
    });
  });

  it('6. THROW (action-only) → {aimAngle: undefined, tick}', () => {
    const playerId = 'p6-throw';
    room.send(fakeClient(playerId), actionOnlyPayload(9, ['THROW']));

    expect(room.orchestrator.calls).toHaveLength(1);
    expect(room.orchestrator.calls[0]).toEqual({
      playerId,
      action: InputAction.THROW,
      data: { aimAngle: undefined, tick: 9 },
      sequence: 9,
    });
  });

  it('7. PICKUP with targetId set → {powerUpId: "", targetId, tick}', () => {
    const playerId = 'p7-pickup-target';
    room.send(fakeClient(playerId), actionOnlyPayload(4, ['PICKUP'], { targetId: 'chest-42' }));

    expect(room.orchestrator.calls).toHaveLength(1);
    // The orchestrator-received shape passes both `powerUpId` and `targetId`
    // through (here `powerUpId` defaults to '' because the client did not
    // send one — only `targetId` was supplied).
    expect(room.orchestrator.calls[0]).toEqual({
      playerId,
      action: InputAction.PICKUP,
      data: { powerUpId: '', targetId: 'chest-42', tick: 4 },
      sequence: 4,
    });
  });

  it('8. PICKUP with powerUpId set (no targetId) → documents defensive powerUpId read', () => {
    const playerId = 'p8-pickup-power';
    // The shared `InputMessage` type omits `powerUpId` (Step 0 confirmed zero
    // client sites set it), but the server reads it defensively via bracket
    // notation. We bypass the type here to drive that runtime branch and pin
    // the legacy behavior: `powerUpId` flows into the orchestrator payload,
    // and `targetId` defaults to '' (the PICKUP branch reads both fields
    // independently for the orchestrator payload, unlike the validation
    // payload which collapses them via `powerUpId || targetId`).
    room.send(
      fakeClient(playerId),
      actionOnlyPayload(6, ['PICKUP'], { powerUpId: 'legacy-loot-9' }),
    );

    expect(room.orchestrator.calls).toHaveLength(1);
    expect(room.orchestrator.calls[0]).toEqual({
      playerId,
      action: InputAction.PICKUP,
      data: { powerUpId: 'legacy-loot-9', targetId: '', tick: 6 },
      sequence: 6,
    });
  });

  it('9. WEAPON_SLOT_1 → SWITCH_SLOT {slot: 0, tick}', () => {
    const playerId = 'p9-slot1';
    room.send(fakeClient(playerId), actionOnlyPayload(2, ['WEAPON_SLOT_1']));

    expect(room.orchestrator.calls).toHaveLength(1);
    expect(room.orchestrator.calls[0]).toEqual({
      playerId,
      action: InputAction.SWITCH_SLOT,
      data: { slot: 0, tick: 2 },
      sequence: 2,
    });
  });

  it('10. WEAPON_SLOT_2/3/4 → SWITCH_SLOT {slot: 1/2/3, tick}', () => {
    const sequenceBase = 20;
    const slots: Array<{
      action: 'WEAPON_SLOT_2' | 'WEAPON_SLOT_3' | 'WEAPON_SLOT_4';
      expectedSlot: number;
    }> = [
      { action: 'WEAPON_SLOT_2', expectedSlot: 1 },
      { action: 'WEAPON_SLOT_3', expectedSlot: 2 },
      { action: 'WEAPON_SLOT_4', expectedSlot: 3 },
    ];

    slots.forEach((slot, i) => {
      const playerId = `p10-${slot.action}`;
      room.send(fakeClient(playerId), actionOnlyPayload(sequenceBase + i, [slot.action]));
      const call = room.orchestrator.calls[room.orchestrator.calls.length - 1];
      expect(call).toEqual({
        playerId,
        action: InputAction.SWITCH_SLOT,
        data: { slot: slot.expectedSlot, tick: sequenceBase + i },
        sequence: sequenceBase + i,
      });
    });

    expect(room.orchestrator.calls).toHaveLength(3);
  });

  it('11. unknown action string ("JUMP") → no enqueue', () => {
    const playerId = 'p11-unknown';
    // Out-of-union literal: the shared `INPUT_ACTION_MAP[...]` own-key lookup
    // returns undefined and the handler skips. Cast mirrors the wire reality —
    // the server doesn't trust the `InputActionName` union.
    room.send(
      fakeClient(playerId),
      actionOnlyPayload(1, ['JUMP' as InputMessage['actions'][number]]),
    );

    expect(room.orchestrator.calls).toHaveLength(0);
  });

  it('12. non-object payload (null / string) → no throw, no enqueue', () => {
    const playerId = 'p12-nonobject';
    // The isObject runtime guard rejects these before any field read. Type
    // system aside, JSON wire bytes can deliver anything.
    expect(() => room.send(fakeClient(playerId), null as unknown as InputMessage)).not.toThrow();
    expect(() =>
      room.send(fakeClient(playerId), 'not-an-object' as unknown as InputMessage),
    ).not.toThrow();
    expect(room.orchestrator.calls).toHaveLength(0);
  });

  it('13. rate-limit exceeded → no enqueue (after MAX_MESSAGES_PER_SECOND allowed frames)', () => {
    // The RateLimiter is a real-time token bucket (refills on wall-clock
    // elapsed). Freeze the clock so the burst of MAX calls sees zero refill
    // and the bucket drains exactly — otherwise any wall-clock elapsed during
    // the loop fractionally refills tokens and the (MAX+1)th call slips past.
    vi.useFakeTimers({ now: 1_000_000 });
    try {
      const playerId = 'p13-ratelimited';
      // Burn through the token bucket for this session: the limiter allows
      // `MAX_MESSAGES_PER_SECOND` calls, then refuses. The idle payload keeps
      // each allowed frame from enqueueing, so the call log stays empty until
      // the refusal frame — which WOULD enqueue (movement != 0) but must NOT
      // because the limiter rejects it before `isObject` even runs.
      const idlePayload: InputMessage = {
        movementX: 0,
        movementY: 0,
        aimAngle: undefined as unknown as number,
        sequence: 0,
        actions: [],
      };

      // Reset this session's bucket first so other tests can't pollute it.
      rateLimiter.reset(playerId);

      // Send MAX_MESSAGES_PER_SECOND allowed frames; none enqueue (idle).
      for (let i = 0; i < NETWORK.MAX_MESSAGES_PER_SECOND; i++) {
        room.send(fakeClient(playerId), idlePayload);
      }
      expect(room.orchestrator.calls).toHaveLength(0);

      // The next frame would enqueue a MOVE (mx != 0) if the limiter allowed it.
      // The limiter refuses — observable as a still-empty call log.
      room.send(fakeClient(playerId), {
        movementX: 1,
        movementY: 0,
        aimAngle: 0,
        sequence: 999,
        actions: [],
      });
      expect(room.orchestrator.calls).toHaveLength(0);

      // Cleanup so this bucket doesn't leak into subsequent test runs.
      rateLimiter.reset(playerId);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * Ticket #12 extension — invalid-input rejections, decode defaults, clamps,
 * and ordering, written against the PRE-decoder-table handler. Every
 * expectation below was derived from the double-switch implementation, so
 * the decoder-table rewrite must keep them byte-identical (the ticket's
 * bit-identical bar). Rejection surfaces per action:
 *   - MOVE/ATTACK/THROW: aimAngle outside [-π, 2π], or an invalid sequence.
 *   - DASH: invalid sequence only (dx/dy are pre-clamped to [-1, 1]).
 *   - PICKUP: invalid sequence only (targetId/powerUpId decode to strings).
 *   - SWITCH_SLOT: invalid sequence only (WEAPON_SLOT_1..4 decode to 0..3).
 * NaN payloads are deliberately NOT pinned — zod v4's NaN handling for
 * `z.number().min().max()` is a library detail the handler must not freeze.
 */
describe('input wire handler — decode + rejection characterization (ticket #12)', () => {
  let room: FakeRoom;

  beforeEach(() => {
    room = new FakeRoom();
    registerInputHandler(room);
  });

  it('14. MOVE with negative / non-integer sequence → rejected, warns "Invalid move input"', () => {
    const playerId = 'p14-move-badseq';
    const warnSpy = vi.spyOn(netLogger, 'warn');
    try {
      // Negative sequence fails z.number().nonnegative().
      room.send(fakeClient(playerId), {
        movementX: 0.5,
        movementY: 0,
        aimAngle: undefined as unknown as number,
        sequence: -1,
        actions: [],
      });
      // Non-integer sequence fails z.number().int().
      room.send(fakeClient(playerId), {
        movementX: 0.5,
        movementY: 0,
        aimAngle: undefined as unknown as number,
        sequence: 2.5,
        actions: [],
      });

      expect(room.orchestrator.calls).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalledWith(
        'Invalid move input',
        expect.objectContaining({ playerId, errors: expect.any(Array) }),
      );
      expect(warnSpy).toHaveBeenCalledTimes(2);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('15. MOVE with out-of-range finite aimAngle (idle movement) → gate fires, rejected', () => {
    const playerId = 'p15-move-badaim';
    const warnSpy = vi.spyOn(netLogger, 'warn');
    try {
      // Idle movement + finite aimAngle still wakes the MOVE branch (the gate
      // is `mx != 0 || my != 0 || isFinite(aimAngle)`), then aimAngle 99
      // fails the [−π, 2π] bound. Both directions of the bound are pinned.
      room.send(fakeClient(playerId), {
        movementX: 0,
        movementY: 0,
        aimAngle: 99,
        sequence: 4,
        actions: [],
      });
      room.send(fakeClient(playerId), {
        movementX: 0,
        movementY: 0,
        aimAngle: -5,
        sequence: 4,
        actions: [],
      });

      expect(room.orchestrator.calls).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalledWith(
        'Invalid move input',
        expect.objectContaining({ playerId, errors: expect.any(Array) }),
      );
      expect(warnSpy).toHaveBeenCalledTimes(2);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('16. ATTACK with out-of-range aimAngle → rejected after the MOVE rejection (same frame)', () => {
    const playerId = 'p16-attack-badaim';
    const warnSpy = vi.spyOn(netLogger, 'warn');
    try {
      room.send(fakeClient(playerId), {
        movementX: 0,
        movementY: 0,
        aimAngle: 99,
        sequence: 5,
        actions: ['ATTACK'],
      });

      // aimAngle is message-level, so the MOVE branch (woken by the finite
      // aim) AND the ATTACK action both fail validation — two warns, zero
      // dispatches.
      expect(room.orchestrator.calls).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalledWith('Invalid move input', expect.anything());
      expect(warnSpy).toHaveBeenCalledWith(
        'Invalid ATTACK input',
        expect.objectContaining({ playerId, errors: expect.any(Array) }),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('17. THROW with aimAngle below -π → rejected (bound lower edge)', () => {
    const playerId = 'p17-throw-badaim';
    const warnSpy = vi.spyOn(netLogger, 'warn');
    try {
      room.send(fakeClient(playerId), {
        movementX: 0,
        movementY: 0,
        aimAngle: -5,
        sequence: 3,
        actions: ['THROW'],
      });

      expect(room.orchestrator.calls).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalledWith(
        'Invalid THROW input',
        expect.objectContaining({ playerId, errors: expect.any(Array) }),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('18. DASH with negative sequence → rejected (dx/dy are pre-clamped, sequence is the only lever)', () => {
    const playerId = 'p18-dash-badseq';
    const warnSpy = vi.spyOn(netLogger, 'warn');
    try {
      room.send(fakeClient(playerId), actionOnlyPayload(-2, ['DASH']));

      expect(room.orchestrator.calls).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalledWith(
        'Invalid DASH input',
        expect.objectContaining({ playerId, errors: expect.any(Array) }),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('19. PICKUP with non-integer sequence → rejected despite valid targetId', () => {
    const playerId = 'p19-pickup-badseq';
    const warnSpy = vi.spyOn(netLogger, 'warn');
    try {
      room.send(fakeClient(playerId), actionOnlyPayload(1.5, ['PICKUP'], { targetId: 'chest-1' }));

      expect(room.orchestrator.calls).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalledWith(
        'Invalid PICKUP input',
        expect.objectContaining({ playerId, errors: expect.any(Array) }),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('20. PICKUP with non-string targetId/powerUpId → decodes to "", still dispatches', () => {
    const playerId = 'p20-pickup-nonstring';
    room.send(
      fakeClient(playerId),
      actionOnlyPayload(2, ['PICKUP'], {
        // JSON wire reality: the fields can arrive as non-strings. The
        // bracket reads default each to '' (validation then trivially passes
        // and the dispatch payload carries the decoded '').
        targetId: 42 as unknown as string,
      }),
    );
    room.send(
      fakeClient(playerId),
      actionOnlyPayload(3, ['PICKUP'], {
        targetId: 'chest-7',
        powerUpId: 99 as unknown as string,
      }),
    );

    expect(room.orchestrator.calls).toHaveLength(2);
    expect(room.orchestrator.calls[0]).toEqual({
      playerId,
      action: InputAction.PICKUP,
      data: { powerUpId: '', targetId: '', tick: 2 },
      sequence: 2,
    });
    expect(room.orchestrator.calls[1]).toEqual({
      playerId,
      action: InputAction.PICKUP,
      data: { powerUpId: '', targetId: 'chest-7', tick: 3 },
      sequence: 3,
    });
  });

  it('21. SWITCH_SLOT with negative sequence → rejected', () => {
    const playerId = 'p21-slot-badseq';
    const warnSpy = vi.spyOn(netLogger, 'warn');
    try {
      room.send(fakeClient(playerId), actionOnlyPayload(-3, ['WEAPON_SLOT_1']));

      expect(room.orchestrator.calls).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalledWith(
        'Invalid SWITCH_SLOT input',
        expect.objectContaining({ playerId, errors: expect.any(Array) }),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('22. one frame, MOVE first then actions in array order (DASH echoes frame movement)', () => {
    const playerId = 'p22-ordering';
    room.send(fakeClient(playerId), {
      movementX: 0.5,
      movementY: 0,
      aimAngle: 0.7,
      sequence: 8,
      actions: ['WEAPON_SLOT_2', 'DASH'],
    });

    expect(room.orchestrator.calls).toHaveLength(3);
    expect(room.orchestrator.calls[0]).toEqual({
      playerId,
      action: InputAction.MOVE,
      data: { dx: 0.5, dy: 0, aimAngle: 0.7, tick: 8 },
      sequence: 8,
    });
    expect(room.orchestrator.calls[1]).toEqual({
      playerId,
      action: InputAction.SWITCH_SLOT,
      data: { slot: 1, tick: 8 },
      sequence: 8,
    });
    // DASH is not action-only here: it echoes the frame's clamped mx/my.
    expect(room.orchestrator.calls[2]).toEqual({
      playerId,
      action: InputAction.DASH,
      data: { dx: 0.5, dy: 0, tick: 8 },
      sequence: 8,
    });
    // recordInputTime fires once per successful dispatch (MOVE + 2 actions).
    expect(room.recordedInputTimes).toEqual([playerId, playerId, playerId]);
  });

  it('23. actions array clamped to 3 entries (4 DASHes → 3 dispatches)', () => {
    const playerId = 'p23-slice3';
    room.send(fakeClient(playerId), actionOnlyPayload(9, ['DASH', 'DASH', 'DASH', 'DASH']));

    expect(room.orchestrator.calls).toHaveLength(3);
    for (const call of room.orchestrator.calls) {
      expect(call).toEqual({
        playerId,
        action: InputAction.DASH,
        data: { dx: 0, dy: 0, tick: 9 },
        sequence: 9,
      });
    }
  });

  it('24. non-array actions → treated as empty; non-string entries skipped', () => {
    const playerId = 'p24-actions-shape';
    room.send(
      fakeClient(playerId),
      actionOnlyPayload(6, 'not-an-array' as unknown as InputMessage['actions']),
    );
    expect(room.orchestrator.calls).toHaveLength(0);

    // The first entry is a non-string: skipped by the typeof guard, the
    // following ATTACK still dispatches.
    room.send(
      fakeClient(playerId),
      actionOnlyPayload(7, [1 as unknown as InputMessage['actions'][number], 'ATTACK']),
    );
    expect(room.orchestrator.calls).toHaveLength(1);
    expect(room.orchestrator.calls[0]).toEqual({
      playerId,
      action: InputAction.ATTACK,
      data: { aimAngle: undefined, tick: 7 },
      sequence: 7,
    });
  });

  it('25. movement axes clamped to [-1, 1] on the dispatch path', () => {
    const playerId = 'p25-clamp';
    room.send(fakeClient(playerId), {
      movementX: 7,
      movementY: -9,
      aimAngle: undefined as unknown as number,
      sequence: 6,
      actions: [],
    });

    expect(room.orchestrator.calls).toHaveLength(1);
    expect(room.orchestrator.calls[0]).toEqual({
      playerId,
      action: InputAction.MOVE,
      data: { dx: 1, dy: -1, aimAngle: undefined, tick: 6 },
      sequence: 6,
    });
  });

  it('26. absent/non-number movement + absent sequence → decode to 0 defaults on the dispatch path', () => {
    const playerId = 'p26-defaults';
    // aimAngle 0.5 wakes the MOVE branch so the decoded defaults (dx=0, dy=0,
    // sequence=0) are observable in the dispatch payload.
    room.send(fakeClient(playerId), {
      movementX: 'left' as unknown as number,
      movementY: null as unknown as number,
      aimAngle: 0.5,
      sequence: undefined as unknown as number,
      actions: [],
    });

    expect(room.orchestrator.calls).toHaveLength(1);
    expect(room.orchestrator.calls[0]).toEqual({
      playerId,
      action: InputAction.MOVE,
      data: { dx: 0, dy: 0, aimAngle: 0.5, tick: 0 },
      sequence: 0,
    });
  });

  it('27. prototype-named actions ("constructor"/"toString"/"__proto__"/"valueOf") → no throw, no enqueue', () => {
    const playerId = 'p27-proto-keys';
    // `INPUT_ACTION_MAP` is a plain object: these wire strings inherit from
    // Object.prototype, so the lookup returns a function/object — NOT
    // undefined — and the `=== undefined` filter alone would let them
    // through. The handler must absorb them exactly like unknown actions
    // (skip silently, no throw, no enqueue) — this pins the absorption the
    // old switch's `default: continue` provided.
    expect(() =>
      room.send(
        fakeClient(playerId),
        actionOnlyPayload(12, [
          'constructor',
          'toString',
          '__proto__',
          'valueOf',
        ] as unknown as InputMessage['actions']),
      ),
    ).not.toThrow();
    expect(room.orchestrator.calls).toHaveLength(0);
    expect(room.recordedInputTimes).toHaveLength(0);
  });
});
