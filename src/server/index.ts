import { APP_NAME } from '../shared/constants.js';
import { createGameServer } from './app.js';
import { isGithubConfigured } from './github.js';

const port = Number.parseInt(process.env.PORT ?? '3000', 10) || 3000;
const host = process.env.HOST ?? '0.0.0.0';

const { httpServer, close } = createGameServer();

httpServer.listen(port, host, () => {
  console.log(`${APP_NAME} is listening on http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
  console.log(
    isGithubConfigured()
      ? 'GitHub saving: configured.'
      : 'GitHub saving: not configured (the game runs fine; Markus gets Download JSON).',
  );
});

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${signal} received, closing the dungeon.`);
    void close().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
