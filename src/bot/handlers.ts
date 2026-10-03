import { Bot, Keyboard } from 'grammy';
import { sql } from 'drizzle-orm';
import * as h3 from 'h3-js';
import { db } from '../db';
import { matchStormToUsers } from '../engine/matcher';
import { createSyntheticHailAlert } from '../simulator/generate-alert';
import { formatHailAlert, escapeMarkdownV2 } from './formatters';

export function registerBotHandlers(bot: Bot) {
  // 1. /start command
  bot.command('start', async (ctx) => {
    const keyboard = new Keyboard()
      .requestLocation('📍 Share Current Location')
      .resized()
      .oneTime();

    await ctx.reply(
      '👋 *Welcome to the Severe Weather Alert Bot\\!*\n\n' +
        'This bot monitors severe convective storms and notifies you ahead of damaging weather like *hail*\\.\n\n' +
        'To get started, please tap the button below to register your monitored location\\.\n\n' +
        'Commands:\n' +
        '• /status \\- View your currently saved location & H3 cell\n' +
        '• /testalert \\- Simulate a severe hail warning over your location\n' +
        '• /help \\- Instructions',
      {
        parse_mode: 'MarkdownV2',
        reply_markup: keyboard,
      }
    );
  });

  // 2. /help command
  bot.command('help', async (ctx) => {
    await ctx.reply(
      'ℹ️ *How It Works:*\n\n' +
        '1\\. You share your GPS coordinates via Telegram\\.\n' +
        '2\\. The system stores your coordinates in PostGIS \\(WGS 84\\) and indexes your location into an **Uber H3 Resolution 7** hexagon\\.\n' +
        '3\\. Whenever an incoming storm cell polygon covers your area, an emergency notification is dispatched immediately\\.\n\n' +
        'Commands:\n' +
        '/start \\- Register location\n' +
        '/status \\- View registered zone\n' +
        '/testalert \\- Test the alert pipeline',
      { parse_mode: 'MarkdownV2' }
    );
  });

  // 3. Location sharing handler
  bot.on('message:location', async (ctx) => {
    const { latitude, longitude } = ctx.message.location;
    const chatId = ctx.chat.id;
    const locationName = ctx.from?.first_name ? `${ctx.from.first_name}'s Location` : 'Monitored Location';

    // Calculate Uber H3 Resolution 7 cell index (~1.2 km² hex)
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

      const escapedH3 = escapeMarkdownV2(h3Cell);
      const escapedLat = escapeMarkdownV2(latitude.toFixed(4));
      const escapedLon = escapeMarkdownV2(longitude.toFixed(4));

      await ctx.reply(
        `✅ *Location Successfully Registered\\!*\n\n` +
          `• *Coordinates:* \`${escapedLat}, ${escapedLon}\`\n` +
          `• *Uber H3 Cell \\(Res 7\\):* \`${escapedH3}\`\n` +
          `• *PostGIS Index:* Active \\(GiST\\)\n\n` +
          `Your location is now actively monitored\\. You can send /testalert to test the emergency alert notification\\!`,
        { parse_mode: 'MarkdownV2' }
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
    const escapedH3 = escapeMarkdownV2(row.h3Res7);
    const escapedLat = escapeMarkdownV2(Number(row.lat).toFixed(4));
    const escapedLon = escapeMarkdownV2(Number(row.lon).toFixed(4));

    await ctx.reply(
      `📍 *Your Registered Alert Zone:*\n\n` +
        `• *Coordinates:* \`${escapedLat}, ${escapedLon}\`\n` +
        `• *H3 Hexagon:* \`${escapedH3}\`\n` +
        `• *Status:* Active Monitoring 🛰️`,
      { parse_mode: 'MarkdownV2' }
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
    await ctx.reply('⛈️ *Simulating incoming severe storm cell\\.\\.\\.*', { parse_mode: 'MarkdownV2' });

    // Generate synthetic hail alert centered right over the user
    const alert = createSyntheticHailAlert(Number(user.lat), Number(user.lon));

    // Run spatial evaluation via PostGIS ST_Covers
    const matchedUsers = await matchStormToUsers(alert);

    // Dispatch notification
    for (const matched of matchedUsers) {
      try {
        const alertMessage = formatHailAlert(alert, matched);
        await ctx.api.sendMessage(matched.telegramChatId, alertMessage, {
          parse_mode: 'MarkdownV2',
        });
        console.log(`✅ [Simulation] Test alert successfully delivered to user ${matched.telegramChatId}`);
      } catch (sendErr) {
        console.error(`⚠️ [Simulation] Failed to deliver alert to user ${matched.telegramChatId}:`, sendErr);
      }
    }
  });
}
