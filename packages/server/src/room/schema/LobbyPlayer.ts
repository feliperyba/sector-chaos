import { Schema, type } from '@colyseus/schema';

function generateDefaultName(): string {
  const num = Math.floor(Math.random() * 9000) + 1000;
  return `Player_${num}`;
}

export class LobbyPlayer extends Schema {
  @type('string') sessionId: string = '';
  @type('string') name: string = generateDefaultName();
  @type('uint8') color: number = 0;
  @type('boolean') ready: boolean = false;
  @type('boolean') isHost: boolean = false;
  @type('boolean') connected: boolean = true;
  @type('float32') mmr: number = 0;
}
