import { Schema, MapSchema, ArraySchema, type } from '@colyseus/schema';
import { LobbyPlayer } from './LobbyPlayer.ts';

const MAX_CHAT_MESSAGES = 50;

export class LobbyState extends Schema {
  @type({ map: LobbyPlayer }) players = new MapSchema<LobbyPlayer>();
  @type('string') mapId: string = 'random';
  @type('string') mode: string = 'battle_royale';
  @type('string') status: string = 'waiting';
  @type('string') hostId: string = '';
  @type('uint8') countdownSeconds: number = 0;
  @type(['string']) chatMessages = new ArraySchema<string>();

  addChatMessage(msg: string): void {
    this.chatMessages.push(msg);
    while (this.chatMessages.length > MAX_CHAT_MESSAGES) {
      this.chatMessages.shift();
    }
  }
}
