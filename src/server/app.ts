import { createServer, type Server as HttpServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express } from 'express';
import { Server as IOServer } from 'socket.io';
import { APP_NAME } from '../shared/constants.js';
import { registerSocketHandlers } from './sockets.js';
import { RoomStore } from './state.js';
import { sweepRateLimits } from './ratelimit.js';

const here = path.dirname(fileURLToPath(import.meta.url));
/** dist/server/app.js -> project root; src/server/app.ts -> project root. */
export const projectRoot = path.resolve(here, '..', '..');
export const publicDir = path.join(projectRoot, 'public');

export interface CreatedServer {
  app: Express;
  httpServer: HttpServer;
  io: IOServer;
  store: RoomStore;
  close: () => Promise<void>;
}

export function createGameServer(): CreatedServer {
  const store = new RoomStore();
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      app: APP_NAME,
      rooms: store.size,
      uptimeSeconds: Math.round(process.uptime()),
      time: new Date().toISOString(),
    });
  });

  app.get('/avatar/:code/:playerId/:tag', (req, res) => {
    const room = store.get(req.params.code.toUpperCase());
    const image = room?.players.get(req.params.playerId)?.character?.avatarImage;
    const match = image?.dataUrl.match(/^data:([\w/+.-]+);base64,(.+)$/);
    if (!match) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.setHeader('Content-Type', match[1]!);
    // The URL carries a content hash, so a new portrait gets a new URL.
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(Buffer.from(match[2]!, 'base64'));
  });

  app.get('/battle/:code/:tag', (req, res) => {
    const image = store.get(req.params.code.toUpperCase())?.battleArt.image;
    const match = image?.dataUrl.match(/^data:([\w/+.-]+);base64,(.+)$/);
    if (!match) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const extension = match[1]!.split('/')[1]?.replace(/[^a-z0-9]/g, '') || 'png';
    res.setHeader('Content-Type', match[1]!);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    // ?download=1 turns the same URL into a file for Slack or the wiki.
    if (req.query.download) {
      res.setHeader('Content-Disposition', `attachment; filename="retro-raiders-${req.params.code.toUpperCase()}-battle.${extension}"`);
    }
    res.send(Buffer.from(match[2]!, 'base64'));
  });

  app.use(express.static(publicDir, { extensions: ['html'], maxAge: '5m' }));

  app.get(/^\/room\/[A-Za-z0-9]{1,8}$/, (_req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  const httpServer = createServer(app);
  const io = new IOServer(httpServer, {
    serveClient: true,
    pingTimeout: 20_000,
    maxHttpBufferSize: 64 * 1024,
  });

  registerSocketHandlers(io, store);

  const sweeper = setInterval(() => {
    store.sweep();
    sweepRateLimits();
  }, 60_000);
  sweeper.unref?.();

  const close = async (): Promise<void> => {
    clearInterval(sweeper);
    await io.close();
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
  };

  return { app, httpServer, io, store, close };
}
