import { Client, Room } from '@colyseus/sdk';
import { SERVER_URL } from '../types.js';
import type { MapData, InputFrame } from '../types.js';
import type { MapDataMessage } from '@sector-battle/shared';
import { netLogger as logger } from '@sector-battle/shared';
import { MessageBuffer } from './MessageBuffer.js';

export interface ConnectionOptions {
  mapType: 'demo' | 'seeded';
  token?: string;
  botFillTo?: number;
  roomName?: string;
}

export class Connection {
  private client: Client;
  room!: Room;
  sessionId = '';
  private connected = false;
  private disposed = false;
  private inputCount = 0;

  /**
   * Handlers registered via onMessage() before the room was set. These are
   * flushed (registered on the actual room + drained against the buffer) once
   * connect()/connectWithRoom() runs.
   */
  private pendingHandlers: Array<{ channel: string; cb: (data: never) => void }> = [];

  /**
   * Optional message buffer adopted from MatchmakingScene (or created on
   * connect). While non-null, messages arriving for channels with no specific
   * handler are buffered and replayed when the handler registers. Detached
   * (set to null) once all handlers are registered.
   */
  private messageBuffer: MessageBuffer | null = null;

  constructor() {
    this.client = new Client(SERVER_URL);
  }

  async connect(options?: ConnectionOptions): Promise<void> {
    const resolved: ConnectionOptions = options ?? { mapType: 'demo' };
    const token = resolved.token ?? crypto.randomUUID();
    const roomName = resolved.roomName ?? 'game';
    logger.info(`Connecting to ${SERVER_URL} (room=${roomName}, mapType=${resolved.mapType})...`);
    // Always CREATE a fresh room — never joinOrCreate. joinOrCreate would reuse
    // any lingering 'game' room (e.g. one kept alive by a pending reconnection
    // grace window), which made returning to the menu and starting a new match
    // drop the player back into the previous match instead of a new one.
    this.room = await this.client.create(roomName, {
      token,
      mapType: resolved.mapType,
      ...(resolved.botFillTo !== undefined ? { botFillTo: resolved.botFillTo } : {}),
    });
    this.sessionId = this.room.sessionId;
    this.disposed = false;
    this.connected = true;
    logger.info(`Connected as ${this.sessionId}`);
    this.registerRoomHandlers();
  }

  /**
   * Accept an already-connected room (e.g. from seat reservation in matchmaking).
   *
   * @param room The pre-connected Colyseus room.
   * @param buffer Optional MessageBuffer created by MatchmakingScene during the
   *               scene transition. If provided, buffered messages will be
   *               replayed to handlers as they register. If null/omitted, a new
   *               buffer is started so any messages arriving between now and
   *               handler registration are still caught.
   */
  connectWithRoom(room: Room, buffer?: MessageBuffer | null): void {
    // Guard against double-connect: if already connected, tear down the old
    // room's buffer first to avoid leaking the wildcard subscription.
    if (this.messageBuffer) {
      this.messageBuffer.detach();
      this.messageBuffer = null;
    }
    this.room = room;
    this.sessionId = room.sessionId;
    this.disposed = false;
    this.connected = true;
    logger.info(`Connected via existing room as ${this.sessionId}`);
    // Adopt the caller-supplied buffer, or start a fresh one.
    this.messageBuffer = buffer ?? MessageBuffer.attach(room);
    this.registerRoomHandlers();
  }

  /**
   * Stop buffering and discard any remaining buffered messages. Called once
   * all real handlers have been registered — anything still in the buffer at
   * that point has no handler by design (e.g. internal messages).
   */
  detachMessageBuffer(): void {
    if (!this.messageBuffer) return;
    this.messageBuffer.detach();
    this.messageBuffer = null;
  }

  private registerRoomHandlers(): void {
    this.room.onLeave((code: number) => {
      logger.warn(`Room left, code=${code}. Inputs sent total: ${this.inputCount}`);
      this.connected = false;
    });
    this.room.onError((err: unknown) => {
      logger.error('Room error:', err);
    });
    this.room.onMessage('__debug__', (data: unknown) => {
      logger.debug('Debug message:', data);
    });
    for (const { channel, cb } of this.pendingHandlers) {
      this.registerHandlerAndDrainBuffer(channel, cb);
    }
    this.pendingHandlers = [];
  }

  onMapData(cb: (data: MapData) => void): void {
    this.onMessage<MapDataMessage>('mapData', (data) => {
      logger.info(
        `Map data received, grid=${data.grid?.length}x${data.grid?.[0]?.length} tileSize=${data.tileSize}`,
      );
      cb(data as unknown as MapData);
    });
  }

  onMessage<T = unknown>(channel: string, cb: (data: T) => void): void {
    if (this.room) {
      this.registerHandlerAndDrainBuffer(channel, cb as (data: never) => void);
    } else {
      this.pendingHandlers.push({ channel, cb: cb as (data: never) => void });
    }
  }

  /**
   * Register a specific handler on the room. If a MessageBuffer is active,
   * also replay any buffered messages of this type that arrived during the
   * buffering window. This guarantees no message is lost: messages that
   * arrived before the handler existed are delivered to it exactly once.
   */
  private registerHandlerAndDrainBuffer(channel: string, cb: (data: never) => void): void {
    if (this.messageBuffer) {
      this.messageBuffer.drain(this.room, channel, cb);
    } else {
      this.room.onMessage(channel, cb);
    }
  }

  sendInput(frame: InputFrame): void {
    if (!this.connected) {
      if (this.inputCount === 0) {
        logger.error('DROPPED INPUT - not connected!');
      }
      return;
    }
    this.inputCount++;
    // Level-gate BEFORE building the template literals: action-bearing sends
    // hit this ~60/s while ATTACK is held (continuous action, not an edge),
    // and the JSON.stringify(frame.actions) arguments were previously paid on
    // every one of those sends even when the logger dropped the line. The
    // sampling below is unchanged (first 5 sends + every 60th + every
    // action-bearing send); the former info-level [DIAG-SEND] diagnostic is
    // downgraded to debug so it only exists when diagnostics are enabled.
    if (logger.isDebugEnabled()) {
      if (this.inputCount <= 5 || this.inputCount % 60 === 0 || frame.actions?.length > 0) {
        logger.debug(
          `Sending input #${this.inputCount}: seq=${frame.sequence} mx=${frame.movementX} my=${frame.movementY} actions=${JSON.stringify(frame.actions)}`,
        );
      }
      if (frame.actions?.length > 0) {
        logger.debug(
          `[DIAG-SEND] actions=${JSON.stringify(frame.actions)} seq=${frame.sequence} aimAngle=${frame.aimAngle}`,
        );
      }
    }
    this.room.send('input', frame);
  }

  disconnect(): void {
    // Idempotent: returnToMenu() and the scene 'shutdown' handler both call
    // this on the same Connection. Calling room.leave() twice on an already
    // closing socket makes the server classify the disconnect as an abnormal
    // drop (onDrop) instead of a consented leave (onLeave), which triggers
    // allowReconnection() and keeps the old room alive waiting for a reconnect
    // — the root cause of "reconnects to the previous match instead of starting
    // a new one". Guard so only the first call performs the (consented) leave.
    if (this.disposed) return;
    this.disposed = true;
    this.connected = false;
    // Tear down the buffering wildcard so we don't hold references after leave.
    if (this.messageBuffer) {
      this.messageBuffer.detach();
      this.messageBuffer = null;
    }
    if (this.room) {
      this.room.leave();
    }
  }

  get isConnected(): boolean {
    return this.connected;
  }
}
