import { matchMaker } from 'colyseus';
import type { SeatReservation } from './types.ts';
import { randomUUID } from 'node:crypto';
import { MATCH } from '@sector-battle/shared';

interface BaseRoomOptions {
  mapId?: string;
  mode?: string;
  playerIds: string[];
  averageMmr?: number;
}

interface CreateGameRoomOptions extends BaseRoomOptions {
  humanCount: number;
}

interface CreateRoomResult {
  roomId: string;
  seatReservations: SeatReservation[];
}

const SEAT_EXPIRY_MS = 30000;

async function createGameRoom(options: CreateGameRoomOptions): Promise<CreateRoomResult> {
  const room = await matchMaker.createRoom('game', {
    mapId: options.mapId ?? 'random',
    mode: options.mode ?? 'battle_royale',
    botFillTo: Math.max(0, MATCH.MAX_PLAYERS - options.humanCount),
    averageMmr: options.averageMmr,
  });

  const seatReservations: SeatReservation[] = options.playerIds.map((playerId) => ({
    playerId,
    roomId: room.roomId,
    seatToken: randomUUID(),
    expiresAt: Date.now() + SEAT_EXPIRY_MS,
  }));

  return { roomId: room.roomId, seatReservations };
}

async function createLobbyRoom(options: BaseRoomOptions): Promise<CreateRoomResult> {
  const room = await matchMaker.createRoom('lobby', {
    mapId: options.mapId ?? 'random',
    mode: options.mode ?? 'battle_royale',
    averageMmr: options.averageMmr,
  });

  const seatReservations: SeatReservation[] = options.playerIds.map((playerId) => ({
    playerId,
    roomId: room.roomId,
    seatToken: randomUUID(),
    expiresAt: Date.now() + SEAT_EXPIRY_MS,
  }));

  return { roomId: room.roomId, seatReservations };
}

export const MatchmakerAPI = {
  createGameRoom,
  createLobbyRoom,
};
