import { sql } from 'drizzle-orm';
import { db } from './db';
import { redis } from './redis/client';
import { createBot, startBot } from './bot';
import { startDispatchWorker } from './queue/worker';
import { startBullBoard } from './queue/dashboard';
import { startBackgroundPoller } from './ingestion/poller';
import { env } from './config/env';
import { refreshUserH3Indexes } from './engine/h3-matcher';

async function main() {
  console.log('🚀 Weather Alert App (MVP 3) Initializing...');

  // Start Bull Board UI Dashboard
  startBullBoard(env.PORT || 3000);

  // 1. Verify PostGIS connection
  try {
    const result = await db.execute(sql`SELECT PostGIS_Version();`);
    const version = (result[0] as any)?.postgis_version;
    console.log(`✅ PostGIS Active (v${version})`);
  } catch (err) {
    console.error('❌ Database connection failed. Is Docker running? (docker compose up -d)', err);
    process.exit(1);
  }

  await refreshUserH3Indexes();

  // 2. Verify Redis connection
  try {
    const pong = await redis.ping();
    console.log(`✅ Redis Deduplication Gate Active (${pong})`);
  } catch (err) {
    console.error('❌ Redis connection failed. Is Redis running? (docker compose up -d)', err);
    process.exit(1);
  }

  // 3. Initialize Telegram Bot & Asynchronous Worker
  const bot = createBot();
  if (bot) {
    startBackgroundPoller();
    // Start BullMQ dispatch worker listening for queued alerts
    startDispatchWorker(bot);
    await startBot(bot);
  } else {
    // Without a Telegram worker, queued notifications would accumulate and
    // dedup state would suppress the alerts when a bot is added later.
    console.log(
      '\n💡 Headless Mode Active: You can still run automated spatial & deduplication simulations using:\n' +
        '   bun run simulate\n' +
        '   bun run test:dedup\n' +
        '   bun run poll\n'
    );
  }
}

main().catch((err) => {
  console.error('Fatal initialization error:', err);
  process.exit(1);
});
