import { Hono } from 'hono';
import { serveStatic } from '@hono/bun';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { HonoAdapter } from '@bull-board/hono';
import { alertDispatchQueue } from './index';

export function startBullBoard(port: number = 3000) {
  const serverAdapter = new HonoAdapter(serveStatic);
  serverAdapter.setBasePath('/ui');

  createBullBoard({
    queues: [new BullMQAdapter(alertDispatchQueue)],
    serverAdapter,
  });

  const app = new Hono();

  // Mount Bull Board UI
  app.route('/ui', serverAdapter.registerPlugin());

  // Redirect root / to /ui
  app.get('/', (c) => c.redirect('/ui'));

  const server = Bun.serve({
    port,
    fetch: app.fetch,
  });

  console.log(`📊 [Bull Board] Real-time queue dashboard active at http://localhost:${server.port}/ui`);
  return server;
}
