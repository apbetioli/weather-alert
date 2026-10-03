import { sql } from 'drizzle-orm';
import { db } from './db';
import { createBot, startBot } from './bot';

async function main() {
  console.log('🚀 Weather Alert App (MVP 1) Initializing...');

  // 1. Verify PostGIS connection
  try {
    const result = await db.execute(sql`SELECT PostGIS_Version();`);
    const version = (result[0] as any)?.postgis_version;
    console.log(`✅ PostGIS Active (v${version})`);
  } catch (err) {
    console.error('❌ Database connection failed. Is Docker running? (docker compose up -d)', err);
    process.exit(1);
  }

  // 2. Initialize Telegram Bot
  const bot = createBot();
  if (bot) {
    await startBot(bot);
  } else {
    console.log(
      '\n💡 Headless Mode Active: You can still run automated spatial simulations using:\n' +
        '   bun run simulate\n'
    );
  }
}

main().catch((err) => {
  console.error('Fatal initialization error:', err);
  process.exit(1);
});
