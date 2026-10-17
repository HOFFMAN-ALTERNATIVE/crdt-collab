import { existsSync } from 'node:fs';
import { startServer } from './server.js';

const staticDir = process.env.STATIC_DIR ?? (existsSync('dist-web/index.html') ? 'dist-web' : undefined);

const server = await startServer({
  port: Number(process.env.PORT ?? 8787),
  host: process.env.HOST ?? '0.0.0.0',
  dataDir: process.env.DATA_DIR ?? 'data',
  staticDir,
  maxRooms: Number(process.env.MAX_ROOMS ?? 1000),
  allowedOrigins: process.env.ALLOWED_ORIGINS?.split(',').filter(Boolean) ?? [],
  log: (msg, extra) => console.log(JSON.stringify({ time: new Date().toISOString(), msg, ...extra })),
});

const shutdown = (sig: string): void => {
  console.log(JSON.stringify({ msg: 'shutdown', sig }));
  void server.close().then(() => process.exit(0));
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
