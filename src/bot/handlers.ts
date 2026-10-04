import { Bot, Keyboard } from 'grammy';
import { sql } from 'drizzle-orm';
import * as h3 from 'h3-js';
import { db } from '../db';
import { matchStormToUsers } from '../engine/matcher';
import { createSyntheticHailAlert } from '../simulator/generate-alert';
import { escapeHtml } from './formatters';
import { evaluateAlertDeduplication } from '../redis/deduplicator';
import { enqueueAlertDispatch } from '../queue';
import { redis } from '../redis/client';

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
        '• /status — View your currently saved location & H3 cell\n' +
        '• /testalert — Simulate a severe hail warning over your location\n' +
        '• /testescalate — Simulate severe hail escalation (5.2 cm)\n' +
        '• /resetalerts — Clear your Redis cooldown window\n' +
        '• /help — Instructions',
      {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      }
    );
  });

  // 2. /help command
  bot.command('help', async (ctx) => {
    await ctx.reply(
      'ℹ️ <b>How It Works:</b>\n\n' +
        '1. You share your GPS coordinates via Telegram.\n' +
        '2. The system stores your coordinates in PostGIS (WGS 84) and indexes your location into an <b>Uber H3 Resolution 7</b> hexagon (~5.16 km²).\n' +
        '3. Whenever an incoming storm cell polygon covers your area, an emergency notification is dispatched immediately.\n' +
        '4. Duplicate alerts for the same storm cell are suppressed for 45 minutes unless conditions worsen significantly (escalation bypass).\n\n' +
        '<b>Commands:</b>\n' +
        '/start — Register location\n' +
        '/status — View registered zone\n' +
        '/testalert — Test the alert pipeline\n' +
        '/testescalate — Test escalation bypass\n' +
        '/resetalerts — Reset cooldowns',
      { parse_mode: 'HTML' }
    );
  });

  // 3. Location sharing handler
  bot.on('message:location', async (ctx) => {
    const { latitude, longitude } = ctx.message.location;
    const chatId = ctx.chat.id;
    const locationName = ctx.from?.first_name ? `${ctx.from.first_name}'s Location` : 'Monitored Location';

    // Calculate Uber H3 Resolution 7 cell index (~5.16 km² hex)
    const h3Cell = h3.latLngToCell(latitude, longitude, 7);

    try {
      // Upsert into PostgreSQL / PostGIS using raw SQL fragment
      await db.execute(sql`
        INSERT INTO user_alert_zones (
          telegram_chat_id,
          location_name,
          location,
          h3_res7,
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
          h3_res7 = EXCLUDED.h3_res7,
          updated_at = NOW();
      `);

      const escapedH3 = escapeHtml(h3Cell);
      const escapedLat = escapeHtml(latitude.toFixed(4));
      const escapedLon = escapeHtml(longitude.toFixed(4));

      await ctx.reply(
        `✅ <b>Location Successfully Registered!</b>\n\n` +
          `• <b>Coordinates:</b> <code>${escapedLat}, ${escapedLon}</code>\n` +
          `• <b>Uber H3 Cell (Res 7):</b> <code>${escapedH3}</code>\n` +
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
        h3_res7 AS "h3Res7",
        ST_X(location::geometry) AS lon,
        ST_Y(location::geometry) AS lat,
        updated_at AS "updatedAt"
      FROM user_alert_zones
      WHERE telegram_chat_id = ${chatId}
      LIMIT 1;
    `);

    const rows = result as any[];
    if (rows.length === 0) {
      return await ctx.reply('⚠️ No location registered yet. Please send /start and tap "Share Location".');
    }

    const row = rows[0];
    const escapedH3 = escapeHtml(row.h3Res7);
    const escapedLat = escapeHtml(Number(row.lat).toFixed(4));
    const escapedLon = escapeHtml(Number(row.lon).toFixed(4));

    await ctx.reply(
      `📍 <b>Your Registered Alert Zone:</b>\n\n` +
        `• <b>Coordinates:</b> <code>${escapedLat}, ${escapedLon}</code>\n` +
        `• <b>H3 Hexagon:</b> <code>${escapedH3}</code>\n` +
        `• <b>Status:</b> Active Monitoring 🛰️`,
      { parse_mode: 'HTML' }
    );
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
        h3_res7 AS "h3Res7",
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

    // Generate synthetic hail alert centered right over the user (default cell CELL_HAIL_SIM_01, 3.5 cm)
    const alert = createSyntheticHailAlert(Number(user.lat), Number(user.lon));

    // Run spatial evaluation via PostGIS ST_Covers
    const matchedUsers = await matchStormToUsers(alert);

    // Dispatch notification via Deduplication Gate & BullMQ Queue
    for (const matched of matchedUsers) {
      const dedup = await evaluateAlertDeduplication(
        matched.telegramChatId,
        alert.cellId,
        alert.hailSizeCm
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
            `• <b>Reason:</b> Hail size unchanged (${escapeHtml(alert.hailSizeCm)} cm)\n\n` +
            `<i>Alerts will resume if hail increases by 1.5 cm or more (escalation bypass), or after the cooldown expires.</i>`,
          { parse_mode: 'HTML' }
        );
      }
    }
  });

  // 6. /testescalate command (Simulates hail growing by >= 1.5 cm on the same cell)
  bot.command('testescalate', async (ctx) => {
    const chatId = ctx.chat.id;

    const result = await db.execute(sql`
      SELECT 
        id,
        telegram_chat_id AS "telegramChatId",
        location_name AS "locationName",
        h3_res7 AS "h3Res7",
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
    await ctx.reply('🔺 <b>Simulating severe hail escalation (surge to 5.2 cm)...</b>', { parse_mode: 'HTML' });

    // Generate alert for the same cell but with escalated hail (5.2 cm, delta >= 1.5 cm)
    const alert = createSyntheticHailAlert(Number(user.lat), Number(user.lon), {
      cellId: 'CELL_HAIL_SIM_01',
      hailSizeCm: 5.2,
      hailDescription: 'Baseball-sized',
    });

    const matchedUsers = await matchStormToUsers(alert);

    for (const matched of matchedUsers) {
      const dedup = await evaluateAlertDeduplication(
        matched.telegramChatId,
        alert.cellId,
        alert.hailSizeCm
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
}
