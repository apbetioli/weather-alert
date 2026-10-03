import postgres from 'postgres';
import { env } from '../config/env';

async function main() {
  console.log(`Connecting to PostGIS at ${env.DATABASE_URL}...`);
  const sql = postgres(env.DATABASE_URL, { connect_timeout: 10 });

  try {
    const versionResult = await sql`SELECT version();`;
    console.log(`✅ PostgreSQL Connected:`, versionResult[0].version);

    // Ensure PostGIS extension is enabled
    await sql`CREATE EXTENSION IF NOT EXISTS postgis;`;
    const postgisVersion = await sql`SELECT PostGIS_Full_Version();`;
    console.log(`✅ PostGIS Active:\n`, postgisVersion[0].postgis_full_version);

    process.exit(0);
  } catch (err) {
    console.error(`❌ PostGIS Connection Failed:`, err);
    process.exit(1);
  } finally {
    await sql.end();
  }
}

main();
