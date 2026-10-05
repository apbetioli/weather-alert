import { sql } from 'drizzle-orm';
import * as h3 from 'h3-js';
import { db } from '../db';
import { matchStormToUsers } from '../engine/matcher';
import { createSyntheticAlert } from './generate-alert';
import { formatAlertHtml } from '../bot/formatters';
import { env } from '../config/env';

async function runCliSimulation() {
  console.log('🧪 Starting Standalone PostGIS + Uber H3 Spatial Simulation...\n');

  // Test coordinates: Verona Est (Northern Italy convective corridor)
  const testLat = 45.438;
  const testLon = 12.235;
  const testH3 = h3.latLngToCell(testLat, testLon, env.H3_RESOLUTION);
  const testChatId = 999999999;

  console.log(`📍 Step 1: Seeding test alert location...`);
  console.log(`   - Coordinates: (${testLat}, ${testLon})`);
  console.log(`   - Uber H3 Res-${env.H3_RESOLUTION}: ${testH3}`);

  await db.execute(sql`
    INSERT INTO user_alert_zones (
      telegram_chat_id,
      location_name,
      location,
      h3_index,
      updated_at
    ) VALUES (
      ${testChatId},
      'Verona Est Depot',
      ST_SetSRID(ST_MakePoint(${testLon}, ${testLat}), 4326)::geography,
      ${testH3},
      NOW()
    )
    ON CONFLICT (telegram_chat_id) DO UPDATE SET
      location = EXCLUDED.location,
      h3_index = EXCLUDED.h3_index,
      updated_at = NOW();
  `);

  console.log('✅ Test user location stored in PostGIS with GiST and H3 indexes.\n');

  // Test Case A: Storm directly hitting Verona Est
  console.log('⛈️  Step 2: Simulating severe hail storm cell over Verona Est (Direct Hit Test)...');
  const hittingStorm = createSyntheticAlert(testLat, testLon);
  const matchedUsersA = await matchStormToUsers(hittingStorm);

  if (matchedUsersA.length > 0) {
    console.log(`✅ SPATIAL MATCH CONFIRMED: Found ${matchedUsersA.length} user(s) inside storm polygon!`);
    console.log('\n--- Rendered Telegram Alert Payload ---');
    console.log(formatAlertHtml(hittingStorm, matchedUsersA[0]!));
    console.log('---------------------------------------\n');
  } else {
    console.error('❌ Expected spatial match, but found none!');
    process.exit(1);
  }

  // Test Case B: Distant Storm over Rome (~400 km south)
  console.log('🌤️  Step 3: Simulating storm over Rome (41.9028, 12.4964) (Spatial Filtering Test)...');
  const distantStorm = createSyntheticAlert(41.9028, 12.4964);
  const matchedUsersB = await matchStormToUsers(distantStorm);

  if (matchedUsersB.length === 0) {
    console.log('✅ SPATIAL EXCLUSION CONFIRMED: 0 users matched outside storm perimeter as expected.');
  } else {
    console.error('❌ Unexpected match outside storm perimeter!');
    process.exit(1);
  }

  console.log('\n🎉 ALL POSTGIS & H3 SPATIAL TESTS PASSED SUCCESSFULLY!');
  process.exit(0);
}

runCliSimulation().catch((err) => {
  console.error('Simulation error:', err);
  process.exit(1);
});
