import { sql } from 'drizzle-orm';
import * as h3 from 'h3-js';
import { db } from '../db';
import { fetchMeteogateWarnings } from '../ingestion/providers/meteogate';
import { normalizeMeteoAlarmAlert } from '../ingestion/normalizer';
import { matchStormToUsers } from '../engine/matcher';
import { matchStormUsingH3, benchmarkH3VsPostgis, alertToH3Cells } from '../engine/h3-matcher';
import { pollMeteoAlarmAlerts } from '../ingestion/poller';
import { createSyntheticAlert } from './generate-alert';
import { env } from '../config/env';

async function runCapIngestionVerification() {
  console.log('🧪 Starting Meteogate Warnings API Ingestion & Inverted H3 Matching Verification Suite...\n');

  // Step 1: Verify Live Fetch & GeoJSON Shapes
  console.log('📡 Step 1: Fetching and parsing Meteogate Warnings API...');
  const rawAlerts = await fetchMeteogateWarnings();

  if (!rawAlerts || rawAlerts.length === 0) {
    console.error('❌ Expected at least 1 raw alert from Meteogate API or fixture, got 0.');
    process.exit(1);
  }

  console.log(`✅ Successfully parsed ${rawAlerts.length} active warning(s) from Meteogate.`);
  const sample = rawAlerts[0]!;
  console.log(`   • Sample Identifier: ${sample.identifier}`);
  console.log(`   • Event:             ${sample.event}`);
  console.log(`   • Severity:          ${sample.severity}`);
  console.log(`   • Area:              ${sample.areaDesc}`);
  console.log(`   • Geometry Type:     ${sample.polygonType || 'Polygon'}`);
  console.log(`   • Headline:          ${sample.headline || 'N/A'}\n`);

  // Step 2: Normalize and verify H3 Hexification
  console.log(`⬡ Step 2: Normalizing alerts & converting exact polygons to H3 Resolution ${env.H3_RESOLUTION} cells...`);
  const normalizedAlerts = rawAlerts.map(normalizeMeteoAlarmAlert);

  for (let i = 0; i < Math.min(normalizedAlerts.length, 3); i++) {
    const alert = normalizedAlerts[i]!;
    const cells = alertToH3Cells(alert, env.H3_RESOLUTION);
    console.log(
      `   [${alert.severity}] "${alert.event}" (${alert.polygonGeoJson.type}) -> ${cells.length} H3 Res-${env.H3_RESOLUTION} hexagons (~${(cells.length * h3.getHexagonAreaAvg(env.H3_RESOLUTION, 'km2')).toFixed(0)} km²)`
    );

    if (cells.length === 0) {
      console.error(`❌ Alert ${alert.cellId} produced 0 H3 cells!`);
      process.exit(1);
    }
  }
  console.log('✅ H3 polygon-to-cells hexification verified successfully.\n');

  // Step 3: Seed deterministic test locations for spatial parity assertion
  console.log('📍 Step 3: Seeding benchmark test locations in PostGIS...');
  const testUsers = [
    { chatId: 900000001, name: 'Verona Test Zone', lat: 45.438, lon: 12.235 }, // In Veneto
    { chatId: 900000002, name: 'Rome Test Zone', lat: 41.9028, lon: 12.4964 }, // In Lazio
  ];

  try {
    for (const u of testUsers) {
      const userH3 = h3.latLngToCell(u.lat, u.lon, env.H3_RESOLUTION);
      await db.execute(sql`
        INSERT INTO user_alert_zones (
          telegram_chat_id,
          location_name,
          location,
          h3_index,
          updated_at
        ) VALUES (
          ${u.chatId},
          ${u.name},
          ST_SetSRID(ST_MakePoint(${u.lon}, ${u.lat}), 4326)::geography,
          ${userH3},
          NOW()
        )
        ON CONFLICT (telegram_chat_id) DO UPDATE SET
          location = EXCLUDED.location,
          h3_index = EXCLUDED.h3_index,
          updated_at = NOW();
      `);
    }
    console.log(`✅ Seeded ${testUsers.length} test zones with PostGIS GiST and H3 B-Tree indexes.\n`);

    // Step 4: Verify Spatial Parity between PostGIS and Inverted H3
    console.log('⚖️ Step 4: Asserting Spatial Parity (PostGIS ST_Covers vs Inverted H3 B-Tree)...');
    const testStorm = createSyntheticAlert(45.438, 12.235); // Centered on Verona

    const postgisMatches = await matchStormToUsers(testStorm);
    const h3Matches = await matchStormUsingH3(testStorm);

    console.log(`   • PostGIS ST_Covers matched: ${postgisMatches.length} user(s)`);
    console.log(`   • Inverted H3 B-Tree matched: ${h3Matches.length} user(s)`);

    const postgisUserIds = postgisMatches.map((u) => u.telegramChatId).sort();
    const h3UserIds = h3Matches.map((u) => u.telegramChatId).sort();

    const isIdentical =
      postgisUserIds.length === h3UserIds.length &&
      postgisUserIds.every((id, idx) => id === h3UserIds[idx]);

    if (!isIdentical) {
      console.error('❌ Parity mismatch between PostGIS and H3!', { postgisUserIds, h3UserIds });
      process.exit(1);
    }
    console.log('✅ SPATIAL PARITY CONFIRMED: 100% match agreement between PostGIS and H3.\n');

    // Step 5: Side-by-side Performance Benchmark
    console.log('⚡ Step 5: Running Performance Benchmark...');
    const bench = await benchmarkH3VsPostgis(testStorm);
    console.log(`✅ Benchmark finished: Inverted H3 speedup = ${bench.speedupFactor}x.\n`);

    // Step 6: End-to-end Poller Execution with Redis Deduplication Gate & BullMQ
    console.log('🚀 Step 6: Testing End-to-End Ingestion Poller Sweep...');
    const pollResult = await pollMeteoAlarmAlerts();
    console.log(
      `✅ Poller Sweep Complete: ${pollResult.totalAlerts} alerts evaluated, ${pollResult.matchedUsers} matches.`
    );
  } finally {
    // Clean up temporary benchmark test zones
    await db.execute(
      sql`DELETE FROM user_alert_zones WHERE telegram_chat_id IN (900000001, 900000002);`
    );
  }

  console.log('\n🎉 ALL CAP INGESTION & INVERTED H3 TESTS PASSED SUCCESSFULLY!');
  process.exit(0);
}

runCapIngestionVerification().catch((err) => {
  console.error('❌ Verification Suite Error:', err);
  process.exit(1);
});
