import { Server } from 'colyseus';
import { GameRoom } from './room/GameRoom.ts';
import { LobbyRoom } from './room/LobbyRoom.ts';
import { BotTestRoom } from './room/BotTestRoom.ts';
import { Matchmaker } from './matchmaking/Matchmaker.ts';

export function setupServer(gameServer: Server): void {
  gameServer
    .define('lobby', LobbyRoom)
    .filterBy(['mapId', 'mode', 'status'])
    .sortBy({ playerCount: -1 })
    .enableRealtimeListing();
  gameServer.define('game', GameRoom).filterBy(['mapId', 'mode']);
  gameServer.define('bot_test', BotTestRoom).filterBy(['difficulty']);
  gameServer.define('matchmaking', Matchmaker).filterBy(['mode']).enableRealtimeListing();
}

export default { initializeGameServer: setupServer };
