// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import log from 'loglevel';
import { netLogger } from '@sector-battle/shared';
import { Connection } from '../Connection.js';
import type { InputFrame } from '../../types.js';

/**
 * Characterization of the sendInput stringify gate (ticket #38).
 *
 * Action-bearing sends hit sendInput ~60/s while ATTACK is held (continuous
 * action, not an edge — InputCollector.ts `pointer.isDown` read at the send
 * boundary). Before the gate, both log template literals evaluated
 * JSON.stringify(frame.actions) on EVERY such send even when the logger level
 * dropped the lines. The contract pinned here:
 *
 * 1. When the network logger's level is above DEBUG (the runtime default),
 *    neither diagnostic runs and JSON.stringify is never called — zero cost.
 * 2. The wire call `room.send('input', frame)` is byte-identical in both
 *    modes (logging-only change).
 * 3. When debug IS enabled, the original sampling is preserved (first 5
 *    sends + every 60th + every action-bearing send) and the [DIAG-SEND]
 *    diagnostic is emitted at DEBUG (downgraded from info), not info.
 */

/** The underlying loglevel named logger that `netLogger` wraps. */
const underlying = log.getLogger('network');

const buildFrame = (sequence: number, actions: string[] = []): InputFrame =>
  ({
    movementX: 0,
    movementY: 1,
    aimAngle: 1.25,
    sequence,
    actions,
  }) as unknown as InputFrame;

/** A Connection with the private connect/room internals forced for testing. */
const buildConnected = (): { conn: Connection; send: ReturnType<typeof vi.fn> } => {
  const conn = new Connection();
  const send = vi.fn();
  // Force the connected state + a stub room (no real socket involved).
  (conn as unknown as { connected: boolean }).connected = true;
  (conn as unknown as { room: unknown }).room = { send };
  return { conn, send };
};

describe('Connection.sendInput debug-stringify gate', () => {
  let debugSpy: MockInstance<typeof netLogger.debug>;
  let infoSpy: MockInstance<typeof netLogger.info>;
  let stringifySpy: MockInstance<typeof JSON.stringify>;

  beforeEach(() => {
    underlying.setLevel('warn'); // runtime default: debug/info dropped
    debugSpy = vi.spyOn(netLogger, 'debug');
    infoSpy = vi.spyOn(netLogger, 'info');
    stringifySpy = vi.spyOn(JSON, 'stringify');
    // Keep the enabled-mode microtask output out of the test console.
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    underlying.setLevel('warn');
  });

  it('1. level disabled: no diagnostics, no JSON.stringify, wire unchanged', () => {
    const { conn, send } = buildConnected();
    const frame = buildFrame(1, ['ATTACK']);

    conn.sendInput(frame);

    expect(debugSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
    expect(stringifySpy).not.toHaveBeenCalled();
    // Logging-only change: the frame goes on the wire exactly as given.
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('input', frame);
  });

  it('2. level enabled: both diagnostics at debug (DIAG-SEND downgraded), wire unchanged', async () => {
    const { conn, send } = buildConnected();
    const frame = buildFrame(2, ['ATTACK']);
    underlying.setLevel('debug');

    conn.sendInput(frame);
    // Flush the logger's queueMicrotask formatting (console mocked silent).
    await Promise.resolve();

    expect(debugSpy).toHaveBeenCalledTimes(2);
    expect(debugSpy.mock.calls[1]?.[0]).toContain('[DIAG-SEND]');
    expect(infoSpy).not.toHaveBeenCalled(); // no info-level send diagnostics remain
    expect(stringifySpy).toHaveBeenCalledTimes(2); // one per gated template literal
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('input', frame);
  });

  it('3. sampling preserved when enabled: first 5 + every 60th + action-bearing', () => {
    const { conn, send } = buildConnected();
    underlying.setLevel('debug');

    // Sends #1-#5 (no actions): all logged.
    for (let i = 1; i <= 5; i++) conn.sendInput(buildFrame(i));
    expect(debugSpy).toHaveBeenCalledTimes(5);

    // Sends #6-#59 (no actions): sampled out.
    for (let i = 6; i <= 59; i++) conn.sendInput(buildFrame(i));
    expect(debugSpy).toHaveBeenCalledTimes(5);

    // Send #60 (no actions): the modulo-60 sample fires.
    conn.sendInput(buildFrame(60));
    expect(debugSpy).toHaveBeenCalledTimes(6);

    // Send #61 (action-bearing): both branches fire (Sending input + DIAG-SEND).
    debugSpy.mockClear();
    conn.sendInput(buildFrame(61, ['ATTACK']));
    expect(debugSpy).toHaveBeenCalledTimes(2);

    expect(send).toHaveBeenCalledTimes(61);
  });
});
