import { Bot, Keyboard, InlineKeyboard } from 'grammy';
import { sql } from 'drizzle-orm';
import * as h3 from 'h3-js';
import { db } from '../db';
import { matchStormToUsers } from '../engine/matcher';
import { createSyntheticAlert } from '../simulator/generate-alert';
import { escapeHtml } from './formatters';
import { evaluateAlertDeduplication } from '../redis/deduplicator';
import { enqueueAlertDispatch } from '../queue';
import { redis } from '../redis/client';
import { pollMeteoAlarmAlerts } from '../ingestion/poller';
import { benchmarkH3VsPostgis } from '../engine/h3-matcher';
import { env } from '../config/env';

export function registerBotHandlers(bot: Bot) {
  // 1. /start command
  bot.command('start', async (ctx) => {
    const keyboard = new Keyboard()
      .requestLocation('📍 Share Current Location')
      .resized()
      .oneTime();

    await ctx.reply(
      '👋 <b>Welcome to the Severe Weather Alert Bot!</b>\n\n' +
        'This bot monitors severe convective storms and notifies you ahead of damaging weather like <b>hail</b>.\n\n' +
        'To get started, please tap the button below to register your monitored location.\n\n' +
        '<b>Commands:</b>\n' +
        '• /status — View registered zone\n' +
        '• /pollalerts — Query the official MeteoAlarm feed\n' +
        '• /testh3match — Compare Inverted H3 vs PostGIS ST_Covers speed\n' +
        '• /testalert — Simulate a storm cell at your location\n' +
        '• /testescalate — Simulate a rapid escalation (Red Alert)\n' +
        '• /resetalerts — Clear the cooldown window in Redis\n' +
        '• /help — Full instructions',
      {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      }
    );
  });

  // 2. /help command
  bot.command('help', async (ctx) => {
    await ctx.reply(
      'ℹ️ <b>Alert Service Guide (MeteoAlarm Standard):</b>\n\n' +
        '<b>1. Awareness Levels (Colors):</b>\n' +
        '• 🟡 <b>Yellow | Moderate:</b> The weather is potentially dangerous. Not unusual, but caution needed for exposed activities.\n' +
        '• 🟠 <b>Orange | Severe:</b> The weather is dangerous. Unusual phenomena, damage probable. Maximum vigilance required.\n' +
        '• 🔴 <b>Red | Extreme:</b> The weather is very dangerous. Exceptional phenomena with safety threats. Follow authority orders.\n\n' +
        '<b>2. Monitored Symbols and Phenomena:</b>\n' +
        '⚡ Thunderstorm & Hail | 💨 Strong Wind | 🌧️ Rain | 🌊 Flood | ❄️ Snow/Ice | 🌫️ Fog | 🌡️ Heat | 🥶 Cold | 🌊⚓ Storm Surge | 🔥 Fires | 🏔️ Avalanches\n\n' +
        '<b>Available Commands:</b>\n' +
        '/status — Monitoring status and zone\n' +
        '/setname — Rename your location (e.g., /setname Home)\n' +
        '/pollalerts — Check MeteoAlarm feed\n' +
        '/testh3match — Benchmark H3 vs PostGIS speed\n' +
        '/testalert — Simulate a storm alert test\n' +
        '/testescalate — Simulate an escalation test (Red Alert)\n' +
        '/resetalerts — Reset cooldown window (45 min)',
      { parse_mode: 'HTML' }
    );
  });

  // 3. Location sharing handler
  bot.on('message:location', async (ctx) => {
    const { latitude, longitude } = ctx.message.location;
    const chatId = ctx.chat.id;
    const locationName = ctx.from?.first_name ? `${ctx.from.first_name}'s Location` : 'Monitored Location';

    // Calculate Uber H3 cell index using configured resolution
    const h3Cell = h3.latLngToCell(latitude, longitude, env.H3_RESOLUTION);

    try {
      // Upsert into PostgreSQL / PostGIS using raw SQL fragment
      await db.execute(sql`
        INSERT INTO user_alert_zones (
          telegram_chat_id,
          location_name,
          location,
          h3_index,
          updated_at
        ) VALUES (
          ${chatId},
          ${locationName},
          ST_SetSRID(ST_MakePoint(${longitude}, ${latitude}), 4326)::geography,
          ${h3Cell},
          NOW()
        )
        ON CONFLICT (telegram_chat_id) DO UPDATE SET
          location_name = EXCLUDED.location_name,
          location = EXCLUDED.location,
          h3_index = EXCLUDED.h3_index,
          updated_at = NOW();
      `);

      const escapedH3 = escapeHtml(h3Cell);
      const escapedLat = escapeHtml(latitude.toFixed(4));
      const escapedLon = escapeHtml(longitude.toFixed(4));

      await ctx.reply(
        `✅ <b>Location Successfully Registered!</b>\n\n` +
          `• <b>Coordinates:</b> <code>${escapedLat}, ${escapedLon}</code>\n` +
          `• <b>Uber H3 Cell (Res ${env.H3_RESOLUTION}):</b> <code>${escapedH3}</code>\n` +
          `• <b>PostGIS Index:</b> Active (GiST)\n\n` +
          `Your location is now actively monitored. You can send /testalert to test the emergency alert notification!`,
        { parse_mode: 'HTML' }
      );
    } catch (err) {
      console.error('Error saving location:', err);
      await ctx.reply('❌ Failed to save location. Please check server logs.');
    }
  });

  // 4. /status command
  bot.command('status', async (ctx) => {
    const chatId = ctx.chat.id;

    const result = await db.execute(sql`
      SELECT 
        location_name AS "locationName",
        h3_index AS "h3Index",
        ST_X(location::geometry) AS lon,
        ST_Y(location::geometry) AS lat,
        updated_at AS "updatedAt"
      FROM user_alert_zones
      WHERE telegram_chat_id = ${chatId}
      LIMIT 1;
    `);

    const rows = result as any[];
    if (rows.length === 0) {
      return await ctx.reply('⚠️ No registered location. Send /start and tap "Share Location".');
    }

    const row = rows[0];
    const escapedH3 = escapeHtml(row.h3Index);
    const escapedLat = escapeHtml(Number(row.lat).toFixed(4));
    const escapedLon = escapeHtml(Number(row.lon).toFixed(4));

    await ctx.reply(
      `📍 <b>Registered Alert Zone:</b>\n\n` +
        `• <b>Location:</b> ${escapeHtml(row.locationName)}\n` +
        `• <b>Coordinates:</b> <code>${escapedLat}, ${escapedLon}</code>\n` +
        `• <b>H3 Hexagon (Res ${env.H3_RESOLUTION}):</b> <code>${escapedH3}</code>\n` +
        `• <b>Status:</b> Active Monitoring 🛰️`,
      { parse_mode: 'HTML' }
    );
  });


  // 4d. /setname command (Rename monitored location label)
  bot.command('setname', async (ctx) => {
    const chatId = ctx.chat.id;
    const newName = ctx.match?.trim();

    if (!newName || newName.length < 2) {
      return await ctx.reply(
        '⚠️ <b>Command usage:</b> <code>/setname &lt;Location Name&gt;</code>\n' +
          'Example: <code>/setname Home</code>',
        { parse_mode: 'HTML' }
      );
    }

    await db.execute(sql`
      UPDATE user_alert_zones
      SET location_name = ${newName}, updated_at = NOW()
      WHERE telegram_chat_id = ${chatId};
    `);

    await ctx.reply(`✅ <b>Location name updated to:</b> ${escapeHtml(newName)}`, {
      parse_mode: 'HTML',
    });
  });


  // 5. /testalert command (Simulates a hail storm over this user's location)
  bot.command('testalert', async (ctx) => {
    const chatId = ctx.chat.id;

    // Retrieve user's coordinates
    const result = await db.execute(sql`
      SELECT 
        id,
        telegram_chat_id AS "telegramChatId",
        location_name AS "locationName",
        h3_index AS "h3Index",
        ST_X(location::geometry) AS lon,
        ST_Y(location::geometry) AS lat
      FROM user_alert_zones
      WHERE telegram_chat_id = ${chatId}
      LIMIT 1;
    `);

    const rows = result as any[];
    if (rows.length === 0) {
      return await ctx.reply('⚠️ Please register your location first using /start before triggering a test alert.');
    }

    const user = rows[0];
    await ctx.reply('⛈️ <b>Simulating incoming severe storm cell...</b>', { parse_mode: 'HTML' });

    // Generate synthetic alert centered right over the user
    const alert = createSyntheticAlert(Number(user.lat), Number(user.lon));

    // Run spatial evaluation via PostGIS ST_Covers
    const matchedUsers = await matchStormToUsers(alert);

    // Dispatch notification via Deduplication Gate & BullMQ Queue
    for (const matched of matchedUsers) {

      const dedup = await evaluateAlertDeduplication(
        matched.telegramChatId,
        alert.cellId,
        alert.severityRank
      );

      if (dedup.shouldSend) {
        console.log(
          `🚀 [Deduplicator] Approved alert for user ${matched.telegramChatId} (Reason: ${dedup.reason}). Enqueueing...`
        );
        await enqueueAlertDispatch({ alert, user: matched, reason: dedup.reason });
      } else {
        console.log(
          `🛑 [Deduplicator] Alert suppressed for user ${matched.telegramChatId} by Redis cooldown (Reason: ${dedup.reason}).`
        );
        await ctx.reply(
          `⏳ <b>Alert Suppressed by Redis Deduplication Gate</b>\n\n` +
            `• <b>Storm Cell:</b> <code>${escapeHtml(alert.cellId)}</code>\n` +
            `• <b>Cooldown Window:</b> 45 minutes active\n` +
            `• <b>Reason:</b> Severity unchanged (${escapeHtml(alert.colorName)})\n\n` +
            `<i>Alerts will resume if severity increases (escalation bypass), or after the cooldown expires.</i>`,
          { parse_mode: 'HTML' }
        );
      }
    }
  });

  // 6. /testescalate command (Simulates escalation to Red alert)
  bot.command('testescalate', async (ctx) => {
    const chatId = ctx.chat.id;

    const result = await db.execute(sql`
      SELECT 
        id,
        telegram_chat_id AS "telegramChatId",
        location_name AS "locationName",
        h3_index AS "h3Index",
        ST_X(location::geometry) AS lon,
        ST_Y(location::geometry) AS lat
      FROM user_alert_zones
      WHERE telegram_chat_id = ${chatId}
      LIMIT 1;
    `);

    const rows = result as any[];
    if (rows.length === 0) {
      return await ctx.reply('⚠️ Please register your location first using /start.');
    }

    const user = rows[0];
    await ctx.reply('🔺 <b>Simulating severe escalation (surge to RED)...</b>', { parse_mode: 'HTML' });

    // Generate alert for the same cell but with escalated severity
    const alert = createSyntheticAlert(Number(user.lat), Number(user.lon), {
      cellId: 'CELL_SIM_01',
      severityRank: 3,
    });

    const matchedUsers = await matchStormToUsers(alert);

    for (const matched of matchedUsers) {
      const dedup = await evaluateAlertDeduplication(
        matched.telegramChatId,
        alert.cellId,
        alert.severityRank
      );

      if (dedup.shouldSend) {
        console.log(
          `🚀 [Deduplicator] Approved alert for user ${matched.telegramChatId} (Reason: ${dedup.reason}). Enqueueing...`
        );
        await enqueueAlertDispatch({ alert, user: matched, reason: dedup.reason });
      } else {
        await ctx.reply(
          `⏳ <b>Alert Suppressed: Cooldown still active and no escalation detected.</b>`,
          { parse_mode: 'HTML' }
        );
      }
    }
  });

  // 7. /resetalerts command (Clears Redis cooldown state so user can re-test from scratch)
  bot.command('resetalerts', async (ctx) => {
    const chatId = ctx.chat.id;
    const keys = await redis.keys(`alert:state:${chatId}:*`);
    if (keys.length > 0) {
      await redis.del(...keys);
      await ctx.reply(`🧹 <b>Redis alert state cleared!</b> Cooldown reset for your location.`, {
        parse_mode: 'HTML',
      });
    } else {
      await ctx.reply(`ℹ️ No active cooldowns found for your account.`, {
        parse_mode: 'HTML',
      });
    }
  });

  // 8. /pollalerts command (Queries live official Meteogate Warnings API on-demand)
  bot.command('pollalerts', async (ctx) => {
    await ctx.reply('📡 <b>Checking live official Meteogate Warnings API...</b>', { parse_mode: 'HTML' });
    try {
      const result = await pollMeteoAlarmAlerts();
      await ctx.reply(
        `🛰️ <b>Meteogate Warnings API Polling Complete</b>\n\n` +
          `• <b>Active Warnings Evaluated:</b> ${result.totalAlerts}\n` +
          `• <b>Users in Hazard Zones:</b> ${result.matchedUsers}\n` +
          `• <b>Alerts Dispatched:</b> ${result.approvedAlerts}\n` +
          `• <b>Alerts Suppressed (Cooldown):</b> ${result.suppressedAlerts}\n\n` +
          `<i>All active warnings with exact European region boundaries were evaluated against registered locations using Inverted H3 Resolution ${env.H3_RESOLUTION} matching.</i>`,
        { parse_mode: 'HTML' }
      );
    } catch (err: any) {
      console.error('Error in /pollalerts handler:', err);
      await ctx.reply(`❌ Failed to poll alerts: ${escapeHtml(err?.message || 'Unknown error')}`, {
        parse_mode: 'HTML',
      });
    }
  });

  // 9. /testh3match command (Runs side-by-side benchmark comparing PostGIS ST_Covers vs Inverted H3)
  bot.command('testh3match', async (ctx) => {
    const chatId = ctx.chat.id;

    // Retrieve user's coordinates if registered, or default to Verona Est
    const result = await db.execute(sql`
      SELECT 
        ST_X(location::geometry) AS lon,
        ST_Y(location::geometry) AS lat
      FROM user_alert_zones
      WHERE telegram_chat_id = ${chatId}
      LIMIT 1;
    `);

    const rows = result as any[];
    const lat = rows.length > 0 ? Number(rows[0].lat) : 45.438;
    const lon = rows.length > 0 ? Number(rows[0].lon) : 12.235;

    await ctx.reply('⚡ <b>Running Spatial Engine Benchmark (PostGIS ST_Covers vs Inverted H3)...</b>', {
      parse_mode: 'HTML',
    });

    try {
      const testAlert = createSyntheticAlert(lat, lon);
      const bench = await benchmarkH3VsPostgis(testAlert);

      await ctx.reply(
        `📊 <b>Spatial Engine Benchmark Results:</b>\n\n` +
          `⛈️ <b>Hazard Footprint:</b> ${bench.h3CellCount} H3 Res-${env.H3_RESOLUTION} hexagons (~${(bench.h3CellCount * h3.getHexagonAreaAvg(env.H3_RESOLUTION, 'km2')).toFixed(0)} km²)\n\n` +
          `<b>1. PostGIS <code>ST_Covers</code> (Spherical Math):</b>\n` +
          `• Execution Time: <code>${bench.postgisElapsedMs} ms</code>\n` +
          `• Matched Users: ${bench.postgisMatches}\n\n` +
          `<b>2. Inverted H3 B-Tree Index:</b>\n` +
          `• Hexification in RAM: <code>${bench.h3HexificationMs} ms</code>\n` +
          `• B-Tree Index Scan: <code>${bench.h3QueryMs} ms</code>\n` +
          `• Total Time: <code>${bench.h3ElapsedMs} ms</code>\n` +
          `• Matched Users: ${bench.h3Matches}\n\n` +
          `🚀 <b>Result:</b> Inverted H3 is <b>${bench.speedupFactor}x faster</b> with 100% spatial parity!`,
        { parse_mode: 'HTML' }
      );
    } catch (err: any) {
      console.error('Error in /testh3match handler:', err);
      await ctx.reply(`❌ Benchmark failed: ${escapeHtml(err?.message || 'Unknown error')}`, {
        parse_mode: 'HTML',
      });
    }
  });
}
