import { queryClient } from '../db';
import * as h3 from 'h3-js';
import { env } from '../config/env';

/**
 * High-performance 500k synthetic user generator.
 * Generates realistic user coordinates across Italy and Northern Europe,
 * computes Uber H3 Resolution 7 hexagons in Bun, and bulk-inserts using PostgreSQL UNNEST.
 */
async function seed500kUsers() {
  const TOTAL_USERS = 500_000;
  const BATCH_SIZE = 10_000;
  const START_CHAT_ID = 100_000_000;

  console.log(`🚀 Starting high-speed seed of ${TOTAL_USERS.toLocaleString()} users...`);
  console.log(`📦 Batch size: ${BATCH_SIZE.toLocaleString()} rows | H3 Resolution: ${env.H3_RESOLUTION}\n`);

  const overallStart = performance.now();

  // Geographic bounds: Greater Italy & Alpine region (where convective hail is frequent)
  // 70% clustered in high-risk convective zones (Po Valley: 44.5 - 46.2 N, 8.5 - 13.0 E)
  // 30% spread across wider Italy / Central Europe (37.0 - 47.0 N, 7.0 - 18.0 E)
  let inserted = 0;

  for (let batchStart = 0; batchStart < TOTAL_USERS; batchStart += BATCH_SIZE) {
    const batchCount = Math.min(BATCH_SIZE, TOTAL_USERS - batchStart);

    const chatIds: number[] = new Array(batchCount);
    const names: string[] = new Array(batchCount);
    const lons: number[] = new Array(batchCount);
    const lats: number[] = new Array(batchCount);
    const h3Indexes: string[] = new Array(batchCount);

    for (let i = 0; i < batchCount; i++) {
      const idx = batchStart + i;
      chatIds[i] = START_CHAT_ID + idx;
      names[i] = `Test User #${idx + 1}`;

      let lat: number;
      let lon: number;

      if (Math.random() < 0.7) {
        // High-density convective zone (Po Valley / Northern Italy)
        lat = 44.5 + Math.random() * 1.7;
        lon = 8.5 + Math.random() * 4.5;
      } else {
        // Wider Italian peninsula
        lat = 37.0 + Math.random() * 10.0;
        lon = 7.0 + Math.random() * 11.0;
      }

      // Round to 5 decimal places (~1 meter precision)
      const roundedLat = Math.round(lat * 100000) / 100000;
      const roundedLon = Math.round(lon * 100000) / 100000;
      lats[i] = roundedLat;
      lons[i] = roundedLon;
      h3Indexes[i] = h3.latLngToCell(roundedLat, roundedLon, env.H3_RESOLUTION);
    }

    const t0 = performance.now();

    // Fast PostgreSQL UNNEST insert
    await queryClient`
      INSERT INTO user_alert_zones (
        telegram_chat_id,
        location_name,
        location,
        h3_index
      )
      SELECT
        c_id,
        u_name,
        ST_SetSRID(ST_MakePoint(u_lon, u_lat), 4326)::geography,
        u_h3
      FROM UNNEST(
        ${chatIds}::bigint[],
        ${names}::text[],
        ${lons}::float8[],
        ${lats}::float8[],
        ${h3Indexes}::text[]
      ) AS t(c_id, u_name, u_lon, u_lat, u_h3)
      ON CONFLICT (telegram_chat_id) DO NOTHING;
    `;

    inserted += batchCount;
    const batchMs = (performance.now() - t0).toFixed(0);
    const progress = ((inserted / TOTAL_USERS) * 100).toFixed(1);
    console.log(`  ✓ Inserted ${inserted.toLocaleString()} / ${TOTAL_USERS.toLocaleString()} (${progress}%) — batch took ${batchMs}ms`);
  }

  const totalSeconds = ((performance.now() - overallStart) / 1000).toFixed(2);
  console.log(`\n🎉 Successfully seeded ${TOTAL_USERS.toLocaleString()} users in ${totalSeconds}s!`);

  // Run ANALYZE to ensure query planner statistics are up to date
  console.log('📊 Updating PostgreSQL table statistics (ANALYZE)...');
  await queryClient`ANALYZE user_alert_zones;`;

  // Print table size and index metrics
  const stats = await queryClient`
    SELECT 
      pg_size_pretty(pg_total_relation_size('user_alert_zones')) AS total_size,
      pg_size_pretty(pg_relation_size('user_alert_zones')) AS table_size,
      pg_size_pretty(pg_indexes_size('user_alert_zones')) AS indexes_size;
  `;
  console.log(`💾 Storage footprint:`, stats[0]);

  await queryClient.end();
  process.exit(0);
}

seed500kUsers().catch((err) => {
  console.error('❌ Seeding failed:', err);
  process.exit(1);
});
