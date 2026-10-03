import fs from 'fs';
import path from 'path';
import postgres from 'postgres';
import { env } from '../config/env';

async function runMigrations() {
  console.log('🔄 Running database migrations...');
  const sql = postgres(env.DATABASE_URL);

  try {
    const migrationPath = path.join(import.meta.dir, '../../drizzle/0000_initial_postgis_h3.sql');
    const migrationSql = fs.readFileSync(migrationPath, 'utf8');

    // Run the migration script
    await sql.unsafe(migrationSql);
    console.log('✅ Migrations applied successfully!');
    console.log('   - PostGIS extension verified');
    console.log('   - Table user_alert_zones ready');
    console.log('   - GiST index idx_user_zones_location created');
    console.log('   - B-Tree index idx_user_zones_h3_res7 created');
  } catch (err) {
    console.error('❌ Migration error:', err);
    process.exit(1);
  } finally {
    await sql.end();
  }
}

runMigrations();
