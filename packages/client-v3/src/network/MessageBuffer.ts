import type { Room } from '@colyseus/sdk';
import { netLogger as logger } from '@sector-battle/shared';

/**
 * Message buffer for the matchmaking → game-scene transition window.
 *
 * When MatchmakingScene resolves `client.joinById(...)`, the game room is live
 * and the server immediately starts emitting match_start / pickup / attack /
 * explosion messages. But the real handlers (EventRouter, onMapData, etc.) do
 * not register until GameSceneSetup runs ~1.6s later (after the TransitionScene
 * fade). Without buffering, Colyseus drops those messages with an
 * "onMessage() not registered" warning.
 *
 * MessageBuffer installs a Colyseus `'*'` wildcard on the room the instant it
 * is created and queues every unhandled message. Colyseus dispatch only fires
 * the wildcard for message types that have NO specific handler registered, so
 * once a real `onMessage(channel, cb)` call lands, the wildcard stops firing
 * for that channel — no double-delivery. When the real handler registers, call
 * `drain(channel, cb)` to replay matching buffered messages to it.
 *
 * Lifecycle:
 *   1. MatchmakingScene: `MessageBuffer.attach(room)` → wildcard installed
 *   2. Pass the MessageBuffer instance through scene data (NOT stashed on Room)
 *   3. GameSceneSetup: for each handler, `buffer.drain(channel, cb)` registers
 *      the real handler AND replays buffered messages for that channel
 *   4. After all handlers registered: `buffer.detach()` removes the wildcard.
 *      Any future unhandled message warns normally — a real signal.
 *
 * If the scene transition fails or the user leaves during the fade, call
 * `buffer.detach()` in MatchmakingScene.shutdown() to clean up.
 */

export interface BufferedMessage {
  type: string;
  data: unknown;
}

/** Cap to prevent unbounded growth if the transition hangs or the server spams. */
const MAX_BUFFERED_MESSAGES = 500;

export class MessageBuffer {
  private messages: BufferedMessage[] = [];
  private wildcardUnsub: (() => void) | null = null;
  private droppedCount = 0;
  readonly roomId: string;

  private constructor(room: Room) {
    this.roomId = room.roomId;
    this.wildcardUnsub = room.onMessage('*', (type: string | number, data: unknown) => {
      // Internal Colyseus messages (schema patches, ping) start with '__'
      // and are handled by the SDK itself. Don't buffer them.
      if (String(type).startsWith('__')) return;
      if (this.messages.length >= MAX_BUFFERED_MESSAGES) {
        this.droppedCount++;
        return;
      }
      this.messages.push({ type: String(type), data });
    });
    logger.debug(`MessageBuffer attached to room ${this.roomId}`);
  }

  /**
   * Install the wildcard buffer on a room. Returns the buffer instance so it
   * can be passed to GameSceneSetup. Call `detach()` when done or on failure.
   */
  static attach(room: Room): MessageBuffer {
    return new MessageBuffer(room);
  }

  /**
   * Register a real handler on the room AND replay any buffered messages of
   * this type that arrived during the buffering window. Messages are replayed
   * synchronously in arrival order.
   */
  drain<T>(room: Room, channel: string, cb: (data: T) => void): void {
    room.onMessage(channel, cb);
    if (this.messages.length === 0) return;
    const matches = this.messages.filter((m) => m.type === channel);
    if (matches.length === 0) return;
    this.messages = this.messages.filter((m) => m.type !== channel);
    logger.debug(`Replaying ${matches.length} buffered message(s) for channel '${channel}'`);
    for (const { data } of matches) {
      cb(data as T);
    }
  }

  /**
   * Remove the wildcard handler and discard any remaining buffered messages.
   * Call this after all real handlers are registered. Safe to call multiple
   * times. Also call on cleanup paths (scene shutdown, error).
   */
  detach(): void {
    if (this.wildcardUnsub) {
      this.wildcardUnsub();
      this.wildcardUnsub = null;
    }
    const dropped = this.messages.length + this.droppedCount;
    this.messages = [];
    this.droppedCount = 0;
    if (dropped > 0) {
      logger.debug(
        `MessageBuffer detached from room ${this.roomId}; dropped ${dropped} unhandled message(s)`,
      );
    }
  }

  /** Number of messages currently buffered (for tests/diagnostics). */
  get size(): number {
    return this.messages.length;
  }
}
