import { Encoder } from '@colyseus/schema';
Encoder.BUFFER_SIZE = 256 * 1024;

import { defineServer, defineRoom, WebSocketTransport } from 'colyseus';
import { PACKAGE_NAME } from '@sector-battle/shared';
import { GameRoom } from './room/GameRoom.ts';
import { LobbyRoom } from './room/LobbyRoom.ts';
import { Matchmaker } from './matchmaking/Matchmaker.ts';
import { BotTestRoom } from './room/BotTestRoom.ts';
import { TestRoom } from './room/TestRoom.ts';
import { logger } from '@sector-battle/shared';
import { debugEventBus } from './infrastructure/DebugEventBus.ts';
import { getActiveSimulations } from './infrastructure/SimulationRegistry.ts';
import type { Request, Response } from 'express';
import type express from 'express';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SERVER_NAME = PACKAGE_NAME;

const __dirname = dirname(fileURLToPath(import.meta.url));
const isDev = process.env.NODE_ENV !== 'production';

const transport = new WebSocketTransport({
  pingInterval: 15000,
  pingMaxRetries: 10,
});

const gameServer = defineServer({
  transport,
  rooms: {
    lobby: defineRoom(LobbyRoom)
      .filterBy(['mapId', 'mode', 'status'])
      .sortBy({ playerCount: -1 })
      .enableRealtimeListing(),
    game: defineRoom(GameRoom).filterBy(['mapId', 'mode']),
    matchmaking: defineRoom(Matchmaker).filterBy(['mode']).enableRealtimeListing(),
    'bot-e2e': defineRoom(BotTestRoom),
    'test-room': defineRoom(TestRoom),
  },
  gracefullyShutdown: true,
  devMode: isDev,
  ...(isDev
    ? {
        express: (app: express.Application) => {
          app.get('/debug/state', (_req: Request, res: Response) => {
            const sims = getActiveSimulations();
            const rooms: Array<Record<string, unknown>> = [];
            for (const [roomId, sim] of sims) {
              rooms.push({
                roomId,
                metrics: sim.getMetrics(),
              });
            }
            res.json({
              timestamp: Date.now(),
              server: SERVER_NAME,
              activeRooms: sims.size,
              rooms,
            });
          });

          app.get('/debug/tick-metrics', (_req: Request, res: Response) => {
            const sims = getActiveSimulations();
            const first = sims.values().next().value;
            if (!first) {
              res.json({ error: 'No active game rooms' });
              return;
            }
            res.json(first.getMetrics());
          });

          app.get('/debug/events', (_req: Request, res: Response) => {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('X-Accel-Buffering', 'no');
            res.flushHeaders();

            const handler = (event: unknown) => {
              res.write(`data: ${JSON.stringify(event)}\n\n`);
            };

            debugEventBus.onEvent(handler);
            _req.on('close', () => {
              debugEventBus.offEvent(handler);
            });
          });

          const dashboardPath = resolve(__dirname, '../public/debug.html');
          if (existsSync(dashboardPath)) {
            const html = readFileSync(dashboardPath, 'utf-8');
            app.get('/debug/', (_req: Request, res: Response) => {
              res.setHeader('Content-Type', 'text/html');
              res.send(html);
            });
            app.get('/debug', (_req: Request, res: Response) => {
              res.setHeader('Content-Type', 'text/html');
              res.send(html);
            });
          }

          logger.info('Debug endpoints enabled');
        },
      }
    : {}),
});

const PORT = parseInt(process.env.PORT || '2567', 10);

if (process.env.NODE_ENV !== 'test') {
  gameServer.listen(PORT).then(() => {
    logger.info(`Sector Battle Arena server running on port ${PORT}`);
  });
}

export { gameServer };
