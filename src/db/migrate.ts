import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { env } from '../config/env';
import path from 'path';

async function runMigrations() {
  console.log('🔄 Running database migrations...');
  const migrationClient = postgres(env.DATABASE_URL, { max: 1 });
  const db = drizzle(migrationClient);

  try {
    const migrationFolder = path.join(import.meta.dir, '../../drizzle');
    await migrate(db, { migrationsFolder: migrationFolder });
    console.log('✅ Migrations applied successfully!');
  } catch (err) {
    console.error('❌ Migration error:', err);
    process.exit(1);
  } finally {
    await migrationClient.end();
  }
}

runMigrations();
