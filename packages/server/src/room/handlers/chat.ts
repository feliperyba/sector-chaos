import type { Client } from 'colyseus';
import type { GameOrchestrator } from '../../application/services/GameOrchestrator.ts';
import { PlayerStatus, MATCH } from '@sector-battle/shared';
import { validateChatInput } from '../../validation/index.ts';

interface ChatHandlingRoom {
  onMessage(type: string, callback: (client: Client, data: unknown) => void): void;
  getOrchestrator(): GameOrchestrator;
  broadcast(type: string, message: unknown): void;
}

export function registerChatHandler(
  room: ChatHandlingRoom,
  lastChatTime: Map<string, number>,
): void {
  room.onMessage('chat', (client: Client, data: unknown) => {
    const player = room.getOrchestrator().getPlayer(client.sessionId);
    if (!player) return;

    if (player.statusEffects.status & PlayerStatus.SPECTATING) {
      client.send('chatError', { reason: 'spectators_cannot_chat' });
      return;
    }

    if (
      player.statusEffects.status & PlayerStatus.DEAD ||
      player.statusEffects.status & PlayerStatus.DYING
    ) {
      client.send('chatError', { reason: 'spectators_cannot_chat' });
      return;
    }

    if (!(player.statusEffects.status & PlayerStatus.ALIVE)) return;

    const validation = validateChatInput(data);
    if (!validation.success) return;

    const now = Date.now();
    const lastTime = lastChatTime.get(client.sessionId) ?? 0;
    if (now - lastTime < MATCH.CHAT_RATE_LIMIT_MS) return;
    lastChatTime.set(client.sessionId, now);

    room.broadcast('chat', {
      senderId: client.sessionId,
      senderName: player.name,
      text: validation.data.text,
      timestamp: now,
    });
  });
}
