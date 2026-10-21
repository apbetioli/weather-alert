import { Hono } from 'hono';
import { basicAuth } from 'hono/basic-auth';
import { serveStatic } from '@hono/bun';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { HonoAdapter } from '@bull-board/hono';
import { alertDispatchQueue } from './index';
import { env } from '../config/env';

export function startBullBoard(port: number = 3000) {
  const serverAdapter = new HonoAdapter(serveStatic);
  serverAdapter.setBasePath('/ui');

  createBullBoard({
    queues: [new BullMQAdapter(alertDispatchQueue)],
    serverAdapter,
  });

  const app = new Hono();

  // If DASHBOARD_PASSWORD is configured, protect the dashboard with HTTP Basic Auth
  if (env.DASHBOARD_PASSWORD) {
    app.use('/ui/*', basicAuth({
      username: env.DASHBOARD_USERNAME || 'admin',
      password: env.DASHBOARD_PASSWORD,
    }));
  }

  // Mount Bull Board UI
  app.route('/ui', serverAdapter.registerPlugin());

  // Redirect root / to /ui
  app.get('/', (c) => c.redirect('/ui'));

  const server = Bun.serve({
    port,
    hostname: env.HOST || '0.0.0.0',
    fetch: app.fetch,
  });

  console.log(`📊 [Bull Board] Real-time queue dashboard active at http://${server.hostname}:${server.port}/ui`);
  return server;
}
