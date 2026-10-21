import { db } from '../db';
import { sql } from 'drizzle-orm';
import { processRadarCells, type StormCell } from '../radar/tracking';
import { alertDispatchQueue } from '../queue';
import * as h3 from 'h3-js';
import { env } from '../config/env';

async function testRadar() {
  const testChatId = 900000000 + Math.floor(Math.random() * 99999999);
  const testH3 = h3.latLngToCell(45.4396, 12.1225, env.H3_RESOLUTION);
  try {
  console.log('🌪️  Simulating multiple radar cells near Mira (45.4396, 12.1225)...');
  
  // 1. Ensure Mira is in the DB
  await db.execute(sql`
    INSERT INTO user_alert_zones (user_id, telegram_chat_id, location_name, location, h3_index)
    VALUES (gen_random_uuid(), ${testChatId}, 'Mira Test User', ST_GeogFromText('SRID=4326;POINT(12.1225 45.4396)'), ${testH3})
    ON CONFLICT (telegram_chat_id) DO NOTHING
  `);

  // 2. Define the simulated cells
  const simulatedCells: StormCell[] = [
    {
      id: 'supercell-alpha',
      centroidLat: 45.3396,
      centroidLon: 11.9725,
      maxDbz: 55,
      speedKmh: 50,
      headingDeg: 45
    },
    {
      id: 'heavy-rain-beta',
      centroidLat: 45.4000,
      centroidLon: 12.0000,
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
        },
        user: {
          id: 0,
          userId: alert.userId,
          telegramChatId: alert.telegramChatId,
          h3Index: testH3,
          locationName: 'Mira (Radar Tracked)',
          lat: 45.4396,
          lon: 12.1225
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

testRadar().catch((err) => {
  console.error('Radar simulation failed:', err);
  process.exitCode = 1;
});
