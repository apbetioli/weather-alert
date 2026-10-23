import { db } from '../db';
import { sql } from 'drizzle-orm';
import { processRadarCells, type StormCell } from '../radar/tracking';
import { alertDispatchQueue } from '../queue';
import * as h3 from 'h3-js';
import { env } from '../config/env';

async function testRadar() {
  const testChatId = 900000000 + Math.floor(Math.random() * 99999999);
  const testLat = 45.438;
  const testLon = 12.235;
  const testH3 = h3.latLngToCell(testLat, testLon, env.H3_RESOLUTION);
  try {
  console.log(`🌪️  Simulating multiple radar cells near radar test location (${testLat}, ${testLon})...`);
  
  // 1. Ensure test user is in the DB
  await db.execute(sql`
    INSERT INTO user_alert_zones (user_id, telegram_chat_id, location_name, location, h3_index)
    VALUES (gen_random_uuid(), ${testChatId}, 'Radar Test User', ST_GeogFromText('SRID=4326;POINT(${sql.raw(String(testLon))} ${sql.raw(String(testLat))})'), ${testH3})
    ON CONFLICT (telegram_chat_id) DO NOTHING
  `);

  // 2. Define the simulated cells
  const simulatedCells: StormCell[] = [
    {
      id: 'supercell-alpha',
      centroidLat: testLat - 0.1,
      centroidLon: testLon - 0.25,
      maxDbz: 55,
      speedKmh: 50,
      headingDeg: 45
    },
    {
      id: 'heavy-rain-beta',
      centroidLat: testLat - 0.04,
      centroidLon: testLon - 0.235,
      maxDbz: 42,
      speedKmh: 30,
      headingDeg: 90
    }
  ];

  const alerts = await processRadarCells(simulatedCells);
  
  console.log(`Detected ${alerts.length} affected users.`);
  
  for (const alert of alerts) {
    console.log(`⏱️ ETA for Chat ${alert.telegramChatId}: ${alert.etaMinutes} minutes.`);
    
    if (alert.etaMinutes < 30) {
      // Send to BullMQ queue
      await alertDispatchQueue.add('dispatch-alert', {
        radar: {
          stormCellId: alert.stormCellId,
          etaMinutes: alert.etaMinutes,
          speedKmh: alert.speedKmh,
          headingDeg: alert.headingDeg,
          maxDbz: alert.maxDbz,
        },
        user: {
          id: 0,
          userId: alert.userId,
          telegramChatId: alert.telegramChatId,
          h3Index: testH3,
          locationName: 'Monitored Zone (Radar Tracked)',
          lat: testLat,
          lon: testLon
        },
        reason: 'Radar Tracking ETA'
      }, { priority: 3 });

      console.log('✅ Informational radar approach notice enqueued.');
    }
  }

  } finally {
    await db.execute(sql`DELETE FROM user_alert_zones WHERE telegram_chat_id = ${testChatId}`);
    await alertDispatchQueue.close();
  }
}

testRadar().then(() => {
  process.exit(0);
}).catch((err) => {
  console.error('Radar simulation failed:', err);
  process.exit(1);
});
