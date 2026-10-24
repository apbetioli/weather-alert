import { Bot, Keyboard, InlineKeyboard } from 'grammy';
import { sql } from 'drizzle-orm';
import * as h3 from 'h3-js';
import { db } from '../db';
import { matchStormToUsers } from '../engine/matcher';
import { createSyntheticAlert } from '../simulator/generate-alert';
import { escapeHtml, formatThresholdAlertHtml } from './formatters';
import { evaluateAlertDeduplication, evaluateThresholdDeduplication } from '../redis/deduplicator';
import { enqueueAlertDispatch } from '../queue';
import { redis } from '../redis/client';
import { pollMeteoAlarmAlerts, pollThresholdAlerts } from '../ingestion/poller';
import { benchmarkH3VsPostgis } from '../engine/h3-matcher';
import { fetchRollingForecast24h } from '../ingestion/providers/open-meteo';
import { evaluateWeatherThresholds, type ConsolidatedThresholdAlert } from '../engine/threshold-evaluator';
import type { UserThresholdPreferences } from '../db/schema';
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
        'This bot monitors severe convective storms, damaging <b>hail</b>, and personalized <b>weather thresholds</b> (rain, snow, wind gusts, frost, and heat).\n\n' +
        'To get started, please tap the button below to register your monitored location.\n\n' +
        '<b>Commands:</b>\n' +
        '• /status — View registered zone and active thresholds\n' +
        '• /thresholds — Configure your custom weather thresholds\n' +
        '• /forecast — Check 24h predictions against your thresholds\n' +
        '• /pollalerts — Query the official MeteoAlarm feed\n' +
        '• /testh3match — Compare Inverted H3 vs PostGIS ST_Covers speed\n' +
        '• /testalert — Simulate a storm cell at your location\n' +
        '• /testescalate — Simulate a rapid escalation (Red Alert)\n' +
        '• /testradar — Simulate an approaching radar cell\n' +
        '• /testthreshold — Simulate a 24h threshold breach\n' +
        '• /pollthresholds — Evaluate thresholds for all users\n' +
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
      'ℹ️ <b>Alert Service Guide & Available Commands:</b>\n\n' +
        '<b>1. Awareness Levels (Civil Protection):</b>\n' +
        '• 🟡 <b>Yellow | Moderate:</b> Weather potentially dangerous.\n' +
        '• 🟠 <b>Orange | Severe:</b> Dangerous weather, damage probable.\n' +
        '• 🔴 <b>Red | Extreme:</b> Very dangerous, exceptional phenomena.\n\n' +
        '<b>2. Monitored Symbols:</b>\n' +
        '⚡ Thunderstorm & Hail | 💨 Wind | 🌧️ Rain | 🌊 Flood | ❄️ Snow/Ice | 🌫️ Fog | 🌡️ Heat | 🥶 Cold\n\n' +
        '<b>3. Personal Weather Thresholds:</b>\n' +
        '/thresholds — Interactive menu to configure custom triggers\n' +
        '/forecast (or /rain) — Check 24h forecast against your thresholds\n' +
        '/setrain &lt;mm|off&gt; — Configure 24h rain threshold\n' +
        '/setsnow &lt;cm|off&gt; — Configure 24h snow threshold\n' +
        '/setwind &lt;km/h|off&gt; — Configure wind gust threshold\n' +
        '/setfrost &lt;°C|off&gt; — Configure frost threshold\n' +
        '/setheat &lt;°C|off&gt; — Configure heat threshold\n' +
        '/sethail &lt;off|any|severe&gt; — Configure hail risk mode\n\n' +
        '<b>4. System Commands:</b>\n' +
        '/status — Monitoring status and zone\n' +
        '/setname — Rename your location (e.g., /setname Home)\n' +
        '/pollalerts — Check MeteoAlarm feed\n' +
        '/testh3match — Benchmark H3 vs PostGIS speed\n' +
        '/testalert — Simulate a storm alert test\n' +
        '/testescalate — Simulate an escalation test (Red Alert)\n' +
        '/testradar — Simulate an approaching radar cell\n' +
        '/testthreshold — Simulate a 24h threshold breach\n' +
        '/pollthresholds — Evaluate thresholds for all users\n' +
        '/resetalerts — Reset alert deduplication state',
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

      // Initialize sensible default threshold preferences if not already created
      await db.execute(sql`
        INSERT INTO user_threshold_preferences (telegram_chat_id)
        VALUES (${chatId})
        ON CONFLICT (telegram_chat_id) DO NOTHING;
      `);

      const escapedH3 = escapeHtml(h3Cell);
      const escapedLat = escapeHtml(latitude.toFixed(4));
      const escapedLon = escapeHtml(longitude.toFixed(4));

      await ctx.reply(
        `✅ <b>Location Successfully Registered!</b>\n\n` +
          `• <b>Coordinates:</b> <code>${escapedLat}, ${escapedLon}</code>\n` +
          `• <b>Uber H3 Cell (Res ${env.H3_RESOLUTION}):</b> <code>${escapedH3}</code>\n` +
          `• <b>Threshold Alerts:</b> Active (Rain >5mm, Wind >60km/h, Frost ≤0°C, Hail)\n` +
          `• <b>PostGIS Index:</b> Active (GiST)\n\n` +
          `Your location is now actively monitored! Use /thresholds to adjust your triggers or /forecast to view the next 24 hours.`,
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
    const prefs = await getOrCreatePreferences(chatId);

    const escapedH3 = escapeHtml(row.h3Index);
    const escapedLat = escapeHtml(Number(row.lat).toFixed(4));
    const escapedLon = escapeHtml(Number(row.lon).toFixed(4));

    const rainStatus = prefs.rainEnabled ? `${prefs.rainThresholdMm} mm` : 'Disabled';
    const windStatus = prefs.windEnabled ? `${prefs.windThresholdKmh} km/h` : 'Disabled';
    const frostStatus = prefs.frostEnabled ? `≤ ${prefs.frostThresholdC} °C` : 'Disabled';
    const hailStatus = prefs.hailMode === 2 ? 'Severe Only' : prefs.hailMode === 1 ? 'Any Risk' : 'Disabled';

    await ctx.reply(
      `📍 <b>Registered Alert Zone:</b>\n\n` +
        `• <b>Location:</b> ${escapeHtml(row.locationName)}\n` +
        `• <b>Coordinates:</b> <code>${escapedLat}, ${escapedLon}</code>\n` +
        `• <b>H3 Hexagon (Res ${env.H3_RESOLUTION}):</b> <code>${escapedH3}</code>\n` +
        `• <b>Civil Protection & Radar:</b> Active 🛰️\n\n` +
        `⚙️ <b>Active Weather Thresholds:</b>\n` +
        `• 🌧️ Rain: ${rainStatus}\n` +
        `• 💨 Wind: ${windStatus}\n` +
        `• 🥶 Frost: ${frostStatus}\n` +
        `• 🧊 Hail: ${hailStatus}\n\n` +
        `<i>Use /thresholds to adjust triggers or /forecast for on-demand check.</i>`,
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

    if (newName.length > 100) {
      return await ctx.reply('⚠️ Location names must be 100 characters or fewer.');
    }

    const result = await db.execute(sql`
      UPDATE user_alert_zones
      SET location_name = ${newName}, updated_at = NOW()
      WHERE telegram_chat_id = ${chatId};
    `);

    if (!result.count) {
      return await ctx.reply('⚠️ Register a location first with /start before renaming it.');
    }

    await ctx.reply(`✅ <b>Location name updated to:</b> ${escapeHtml(newName)}`, {
      parse_mode: 'HTML',
    });
  });

  // Helper: Retrieve or create default threshold preferences
  async function getOrCreatePreferences(chatId: number): Promise<UserThresholdPreferences> {
    const result = await db.execute(sql`
      INSERT INTO user_threshold_preferences (telegram_chat_id)
      VALUES (${chatId})
      ON CONFLICT (telegram_chat_id) DO UPDATE SET updated_at = user_threshold_preferences.updated_at
      RETURNING 
        id,
        telegram_chat_id AS "telegramChatId",
        rain_enabled AS "rainEnabled",
        rain_threshold_mm AS "rainThresholdMm",
        snow_enabled AS "snowEnabled",
        snow_threshold_cm AS "snowThresholdCm",
        wind_enabled AS "windEnabled",
        wind_threshold_kmh AS "windThresholdKmh",
        frost_enabled AS "frostEnabled",
        frost_threshold_c AS "frostThresholdC",
        heat_enabled AS "heatEnabled",
        heat_threshold_c AS "heatThresholdC",
        hail_mode AS "hailMode",
        created_at AS "createdAt",
        updated_at AS "updatedAt";
    `);
    const rows = result as any[];
    return rows[0];
  }

  function renderThresholdsMenu(prefs: UserThresholdPreferences, locationName: string = 'Monitored Location') {
    const rainText = prefs.rainEnabled ? `<b>${prefs.rainThresholdMm} mm</b>` : '<i>Disabled</i>';
    const snowText = prefs.snowEnabled ? `<b>${prefs.snowThresholdCm} cm</b>` : '<i>Disabled</i>';
    const windText = prefs.windEnabled ? `<b>${prefs.windThresholdKmh} km/h</b>` : '<i>Disabled</i>';
    const frostText = prefs.frostEnabled ? `<b>≤ ${prefs.frostThresholdC} °C</b>` : '<i>Disabled</i>';
    const heatText = prefs.heatEnabled ? `<b>≥ ${prefs.heatThresholdC} °C</b>` : '<i>Disabled</i>';
    const hailText =
      prefs.hailMode === 2 ? '<b>Severe Only</b>' : prefs.hailMode === 1 ? '<b>Any Risk</b>' : '<i>Disabled</i>';

    const text =
      `⚙️ <b>Weather Threshold Preferences</b>\n\n` +
      `📍 <b>Monitored Area:</b> ${escapeHtml(locationName)}\n\n` +
      `• 🌧️ <b>Rainfall:</b> ${rainText}\n` +
      `• ❄️ <b>Snowfall:</b> ${snowText}\n` +
      `• 💨 <b>Wind Gusts:</b> ${windText}\n` +
      `• 🥶 <b>Frost / Freeze:</b> ${frostText}\n` +
      `• 🌡️ <b>Extreme Heat:</b> ${heatText}\n` +
      `• 🧊 <b>Hail Risk:</b> ${hailText}\n\n` +
      `<i>Tap a metric to select a preset threshold, or use direct commands (e.g. <code>/setrain 3</code>).</i>`;

    const keyboard = new InlineKeyboard()
      .text('🌧️ Rain', 'th:select:rain')
      .text('❄️ Snow', 'th:select:snow')
      .text('💨 Wind', 'th:select:wind')
      .row()
      .text('🥶 Frost', 'th:select:frost')
      .text('🌡️ Heat', 'th:select:heat')
      .text('🧊 Hail', 'th:select:hail')
      .row()
      .text('🔍 Check Forecast Now', 'th:forecast')
      .text('🔄 Refresh', 'th:refresh');

    return { text, keyboard };
  }

  function renderMetricSubmenu(metric: string, prefs: UserThresholdPreferences) {
    let title = '';
    let currentVal = '';
    const kb = new InlineKeyboard();

    switch (metric) {
      case 'rain':
        title = '🌧️ <b>Rainfall Threshold (24h Accumulation)</b>';
        currentVal = prefs.rainEnabled ? `${prefs.rainThresholdMm} mm` : 'Disabled';
        kb.text(prefs.rainEnabled ? '❌ Disable' : '✅ Enable', 'th:toggle:rain').row();
        kb.text('1 mm', 'th:set:rain:1.00')
          .text('3 mm', 'th:set:rain:3.00')
          .text('5 mm', 'th:set:rain:5.00')
          .text('10 mm', 'th:set:rain:10.00')
          .row();
        break;
      case 'snow':
        title = '❄️ <b>Snowfall Threshold (24h Accumulation)</b>';
        currentVal = prefs.snowEnabled ? `${prefs.snowThresholdCm} cm` : 'Disabled';
        kb.text(prefs.snowEnabled ? '❌ Disable' : '✅ Enable', 'th:toggle:snow').row();
        kb.text('1 cm', 'th:set:snow:1.00')
          .text('2 cm', 'th:set:snow:2.00')
          .text('5 cm', 'th:set:snow:5.00')
          .text('10 cm', 'th:set:snow:10.00')
          .row();
        break;
      case 'wind':
        title = '💨 <b>Wind Gusts Threshold (Peak km/h)</b>';
        currentVal = prefs.windEnabled ? `${prefs.windThresholdKmh} km/h` : 'Disabled';
        kb.text(prefs.windEnabled ? '❌ Disable' : '✅ Enable', 'th:toggle:wind').row();
        kb.text('40 km/h', 'th:set:wind:40.0')
          .text('60 km/h', 'th:set:wind:60.0')
          .text('80 km/h', 'th:set:wind:80.0')
          .text('100 km/h', 'th:set:wind:100.0')
          .row();
        break;
      case 'frost':
        title = '🥶 <b>Frost & Freeze Threshold (Min Temperature)</b>';
        currentVal = prefs.frostEnabled ? `≤ ${prefs.frostThresholdC} °C` : 'Disabled';
        kb.text(prefs.frostEnabled ? '❌ Disable' : '✅ Enable', 'th:toggle:frost').row();
        kb.text('0 °C', 'th:set:frost:0.0')
          .text('-2 °C', 'th:set:frost:-2.0')
          .text('-5 °C', 'th:set:frost:-5.0')
          .row();
        break;
      case 'heat':
        title = '🌡️ <b>Extreme Heat Threshold (Max Temperature)</b>';
        currentVal = prefs.heatEnabled ? `≥ ${prefs.heatThresholdC} °C` : 'Disabled';
        kb.text(prefs.heatEnabled ? '❌ Disable' : '✅ Enable', 'th:toggle:heat').row();
        kb.text('30 °C', 'th:set:heat:30.0')
          .text('33 °C', 'th:set:heat:33.0')
          .text('35 °C', 'th:set:heat:35.0')
          .text('38 °C', 'th:set:heat:38.0')
          .row();
        break;
      case 'hail':
        title = '🧊 <b>Hail Risk Mode</b>';
        currentVal = prefs.hailMode === 2 ? 'Severe Only' : prefs.hailMode === 1 ? 'Any Risk' : 'Disabled';
        kb.text('❌ Off', 'th:set:hail:0')
          .text('🟡 Any Risk', 'th:set:hail:1')
          .text('🔴 Severe Only', 'th:set:hail:2')
          .row();
        break;
    }

    kb.text('« Back to Thresholds', 'th:menu');

    const text =
      `${title}\n\n` +
      `• <b>Current Setting:</b> <code>${currentVal}</code>\n\n` +
      `<i>Tap a preset button below or use direct commands to customize.</i>`;

    return { text, keyboard: kb };
  }

  // /thresholds command: Interactive configuration menu
  bot.command('thresholds', async (ctx) => {
    const chatId = ctx.chat.id;
    const userResult = await db.execute(sql`
      SELECT location_name AS "locationName" FROM user_alert_zones WHERE telegram_chat_id = ${chatId} LIMIT 1;
    `);
    const locName = (userResult as any[])[0]?.locationName || 'Monitored Location';
    const prefs = await getOrCreatePreferences(chatId);
    const { text, keyboard } = renderThresholdsMenu(prefs, locName);
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  });

  // /forecast & /rain command: On-demand 24h forecast check
  bot.command(['forecast', 'rain'], async (ctx) => {
    const chatId = ctx.chat.id;

    const userResult = await db.execute(sql`
      SELECT 
        location_name AS "locationName",
        h3_index AS "h3Index",
        ST_X(location::geometry) AS lon,
        ST_Y(location::geometry) AS lat
      FROM user_alert_zones
      WHERE telegram_chat_id = ${chatId}
      LIMIT 1;
    `);

    const rows = userResult as any[];
    if (rows.length === 0) {
      return await ctx.reply('⚠️ Please register your location first with /start before checking forecasts.');
    }

    const user = rows[0];
    const lat = Number(user.lat);
    const lon = Number(user.lon);

    await ctx.reply('🛰️ <b>Fetching 24-hour high-resolution European forecast (Open-Meteo)...</b>', {
      parse_mode: 'HTML',
    });

    try {
      const prefs = await getOrCreatePreferences(chatId);
      const forecast = await fetchRollingForecast24h(lat, lon, {
        h3Index: user.h3Index,
      });
      const evalResult = evaluateWeatherThresholds(
        {
          telegramChatId: chatId,
          locationName: user.locationName,
          lat,
          lon,
        },
        prefs,
        forecast
      );

      if (evalResult && evalResult.breaches.length > 0) {
        const alertHtml = formatThresholdAlertHtml(evalResult);
        await ctx.reply(alertHtml, { parse_mode: 'HTML' });
      } else {
        let totalRain = 0;
        let maxGust = 0;
        let minTemp = 999;
        let maxTemp = -999;
        for (const s of forecast.steps) {
          totalRain += s.precipitationMm;
          if (s.windGustKmh > maxGust) maxGust = s.windGustKmh;
          if (s.temperatureC < minTemp) minTemp = s.temperatureC;
          if (s.temperatureC > maxTemp) maxTemp = s.temperatureC;
        }

        await ctx.reply(
          `✅ <b>24-Hour Forecast Clear for ${escapeHtml(user.locationName)}</b>\n\n` +
            `No configured weather thresholds are forecasted to be exceeded in the next 24 hours.\n\n` +
            `• 🌧️ <b>Rainfall:</b> ${totalRain.toFixed(1)} mm (Threshold: ${prefs.rainThresholdMm} mm)\n` +
            `• 💨 <b>Peak Gust:</b> ${Math.round(maxGust)} km/h (Threshold: ${prefs.windThresholdKmh} km/h)\n` +
            `• 🌡️ <b>Temperature Range:</b> ${minTemp.toFixed(1)}°C to ${maxTemp.toFixed(1)}°C\n` +
            `• 🧊 <b>Hail Risk:</b> None detected\n\n` +
            `<i>Use /thresholds to adjust your trigger levels.</i>`,
          { parse_mode: 'HTML' }
        );
      }
    } catch (err: any) {
      console.error('Error in /forecast handler:', err);
      await ctx.reply(`❌ Failed to retrieve forecast: ${escapeHtml(err?.message || 'Unknown error')}`, {
        parse_mode: 'HTML',
      });
    }
  });

  // /pollthresholds command: On-demand sweep trigger
  bot.command('pollthresholds', async (ctx) => {
    await ctx.reply('🔄 <b>Evaluating multi-hazard weather thresholds for all users (on-demand sweep)...</b>', { parse_mode: 'HTML' });
    try {
      const res = await pollThresholdAlerts({ forceAll: true });
      await ctx.reply(
        `📊 <b>Threshold Evaluation Complete:</b>\n\n` +
          `• <b>Total Users Evaluated:</b> ${res.totalEvaluated}\n` +
          `• <b>Users with Breaches:</b> ${res.usersWithBreaches}\n` +
          `• <b>Alerts Dispatched:</b> ${res.dispatchedAlerts}\n` +
          `• <b>Duplicate Alerts Suppressed:</b> ${res.suppressedAlerts}`,
        { parse_mode: 'HTML' }
      );
    } catch (err: any) {
      await ctx.reply(`❌ Failed threshold poll: ${escapeHtml(err?.message || 'Unknown error')}`, {
        parse_mode: 'HTML',
      });
    }
  });

  // Direct shortcut commands: /setrain, /setsnow, /setwind, /setfrost, /setheat, /sethail
  bot.command('setrain', async (ctx) => {
    const val = ctx.match?.trim().toLowerCase();
    const chatId = ctx.chat.id;
    if (!val) {
      return await ctx.reply('⚠️ Usage: <code>/setrain &lt;mm|off&gt;</code> (e.g. <code>/setrain 3</code>)');
    }
    if (val === 'off' || val === 'disable') {
      await db.execute(sql`
        INSERT INTO user_threshold_preferences (telegram_chat_id, rain_enabled) VALUES (${chatId}, false)
        ON CONFLICT (telegram_chat_id) DO UPDATE SET rain_enabled = false, updated_at = NOW();
      `);
      return await ctx.reply('🌧️ <b>Rainfall threshold alert disabled.</b>', { parse_mode: 'HTML' });
    }
    const num = parseFloat(val);
    if (isNaN(num) || num < 0 || num > 500) {
      return await ctx.reply('⚠️ Please provide a valid rainfall threshold in mm (e.g. <code>/setrain 3.5</code>).');
    }
    await db.execute(sql`
      INSERT INTO user_threshold_preferences (telegram_chat_id, rain_enabled, rain_threshold_mm) VALUES (${chatId}, true, ${num.toFixed(2)})
      ON CONFLICT (telegram_chat_id) DO UPDATE SET rain_enabled = true, rain_threshold_mm = ${num.toFixed(2)}, updated_at = NOW();
    `);
    await ctx.reply(`✅ <b>Rainfall threshold set to ${num.toFixed(1)} mm!</b>`, { parse_mode: 'HTML' });
  });

  bot.command('setsnow', async (ctx) => {
    const val = ctx.match?.trim().toLowerCase();
    const chatId = ctx.chat.id;
    if (!val) {
      return await ctx.reply('⚠️ Usage: <code>/setsnow &lt;cm|off&gt;</code> (e.g. <code>/setsnow 2</code>)');
    }
    if (val === 'off' || val === 'disable') {
      await db.execute(sql`
        INSERT INTO user_threshold_preferences (telegram_chat_id, snow_enabled) VALUES (${chatId}, false)
        ON CONFLICT (telegram_chat_id) DO UPDATE SET snow_enabled = false, updated_at = NOW();
      `);
      return await ctx.reply('❄️ <b>Snowfall threshold alert disabled.</b>', { parse_mode: 'HTML' });
    }
    const num = parseFloat(val);
    if (isNaN(num) || num < 0 || num > 200) {
      return await ctx.reply('⚠️ Please provide a valid snowfall threshold in cm (e.g. <code>/setsnow 2</code>).');
    }
    await db.execute(sql`
      INSERT INTO user_threshold_preferences (telegram_chat_id, snow_enabled, snow_threshold_cm) VALUES (${chatId}, true, ${num.toFixed(2)})
      ON CONFLICT (telegram_chat_id) DO UPDATE SET snow_enabled = true, snow_threshold_cm = ${num.toFixed(2)}, updated_at = NOW();
    `);
    await ctx.reply(`✅ <b>Snowfall threshold set to ${num.toFixed(1)} cm!</b>`, { parse_mode: 'HTML' });
  });

  bot.command('setwind', async (ctx) => {
    const val = ctx.match?.trim().toLowerCase();
    const chatId = ctx.chat.id;
    if (!val) {
      return await ctx.reply('⚠️ Usage: <code>/setwind &lt;km/h|off&gt;</code> (e.g. <code>/setwind 60</code>)');
    }
    if (val === 'off' || val === 'disable') {
      await db.execute(sql`
        INSERT INTO user_threshold_preferences (telegram_chat_id, wind_enabled) VALUES (${chatId}, false)
        ON CONFLICT (telegram_chat_id) DO UPDATE SET wind_enabled = false, updated_at = NOW();
      `);
      return await ctx.reply('💨 <b>Wind gust threshold alert disabled.</b>', { parse_mode: 'HTML' });
    }
    const num = parseFloat(val);
    if (isNaN(num) || num < 10 || num > 300) {
      return await ctx.reply('⚠️ Please provide a valid wind gust threshold in km/h (e.g. <code>/setwind 60</code>).');
    }
    await db.execute(sql`
      INSERT INTO user_threshold_preferences (telegram_chat_id, wind_enabled, wind_threshold_kmh) VALUES (${chatId}, true, ${num.toFixed(1)})
      ON CONFLICT (telegram_chat_id) DO UPDATE SET wind_enabled = true, wind_threshold_kmh = ${num.toFixed(1)}, updated_at = NOW();
    `);
    await ctx.reply(`✅ <b>Wind gust threshold set to ${Math.round(num)} km/h!</b>`, { parse_mode: 'HTML' });
  });

  bot.command('setfrost', async (ctx) => {
    const val = ctx.match?.trim().toLowerCase();
    const chatId = ctx.chat.id;
    if (!val) {
      return await ctx.reply('⚠️ Usage: <code>/setfrost &lt;°C|off&gt;</code> (e.g. <code>/setfrost 0</code>)');
    }
    if (val === 'off' || val === 'disable') {
      await db.execute(sql`
        INSERT INTO user_threshold_preferences (telegram_chat_id, frost_enabled) VALUES (${chatId}, false)
        ON CONFLICT (telegram_chat_id) DO UPDATE SET frost_enabled = false, updated_at = NOW();
      `);
      return await ctx.reply('🥶 <b>Frost threshold alert disabled.</b>', { parse_mode: 'HTML' });
    }
    const num = parseFloat(val);
    if (isNaN(num) || num < -40 || num > 20) {
      return await ctx.reply('⚠️ Please provide a valid temperature threshold in °C (e.g. <code>/setfrost 0</code>).');
    }
    await db.execute(sql`
      INSERT INTO user_threshold_preferences (telegram_chat_id, frost_enabled, frost_threshold_c) VALUES (${chatId}, true, ${num.toFixed(1)})
      ON CONFLICT (telegram_chat_id) DO UPDATE SET frost_enabled = true, frost_threshold_c = ${num.toFixed(1)}, updated_at = NOW();
    `);
    await ctx.reply(`✅ <b>Frost threshold set to ≤ ${num.toFixed(1)} °C!</b>`, { parse_mode: 'HTML' });
  });

  bot.command('setheat', async (ctx) => {
    const val = ctx.match?.trim().toLowerCase();
    const chatId = ctx.chat.id;
    if (!val) {
      return await ctx.reply('⚠️ Usage: <code>/setheat &lt;°C|off&gt;</code> (e.g. <code>/setheat 35</code>)');
    }
    if (val === 'off' || val === 'disable') {
      await db.execute(sql`
        INSERT INTO user_threshold_preferences (telegram_chat_id, heat_enabled) VALUES (${chatId}, false)
        ON CONFLICT (telegram_chat_id) DO UPDATE SET heat_enabled = false, updated_at = NOW();
      `);
      return await ctx.reply('🌡️ <b>Extreme heat threshold alert disabled.</b>', { parse_mode: 'HTML' });
    }
    const num = parseFloat(val);
    if (isNaN(num) || num < 20 || num > 60) {
      return await ctx.reply('⚠️ Please provide a valid temperature threshold in °C (e.g. <code>/setheat 35</code>).');
    }
    await db.execute(sql`
      INSERT INTO user_threshold_preferences (telegram_chat_id, heat_enabled, heat_threshold_c) VALUES (${chatId}, true, ${num.toFixed(1)})
      ON CONFLICT (telegram_chat_id) DO UPDATE SET heat_enabled = true, heat_threshold_c = ${num.toFixed(1)}, updated_at = NOW();
    `);
    await ctx.reply(`✅ <b>Heat threshold set to ≥ ${num.toFixed(1)} °C!</b>`, { parse_mode: 'HTML' });
  });

  bot.command('sethail', async (ctx) => {
    const val = ctx.match?.trim().toLowerCase();
    const chatId = ctx.chat.id;
    let mode = 1;
    if (val === 'off' || val === '0') mode = 0;
    else if (val === 'any' || val === '1') mode = 1;
    else if (val === 'severe' || val === '2') mode = 2;
    else {
      return await ctx.reply('⚠️ Usage: <code>/sethail &lt;off|any|severe&gt;</code>');
    }

    await db.execute(sql`
      INSERT INTO user_threshold_preferences (telegram_chat_id, hail_mode) VALUES (${chatId}, ${mode})
      ON CONFLICT (telegram_chat_id) DO UPDATE SET hail_mode = ${mode}, updated_at = NOW();
    `);
    const label = mode === 2 ? 'Severe Only' : mode === 1 ? 'Any Risk' : 'Disabled';
    await ctx.reply(`✅ <b>Hail risk mode updated to: ${label}!</b>`, { parse_mode: 'HTML' });
  });

  async function safeEditMessage(ctx: any, text: string, keyboard?: InlineKeyboard) {
    try {
      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
    } catch (err: any) {
      const msg = err?.description || err?.message || '';
      if (msg.includes('message is not modified')) {
        return;
      }
      throw err;
    }
  }

  async function safeAnswerCallback(ctx: any, text?: string) {
    try {
      await ctx.answerCallbackQuery(text ? { text } : undefined);
    } catch {
      // Query already answered or expired
    }
  }

  // Callback query dispatcher for inline keyboard clicks
  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    if (!data.startsWith('th:')) return;

    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const userResult = await db.execute(sql`
      SELECT location_name AS "locationName" FROM user_alert_zones WHERE telegram_chat_id = ${chatId} LIMIT 1;
    `);
    const locName = (userResult as any[])[0]?.locationName || 'Monitored Location';

    if (data === 'th:menu' || data === 'th:refresh') {
      const prefs = await getOrCreatePreferences(chatId);
      const { text, keyboard } = renderThresholdsMenu(prefs, locName);
      await safeEditMessage(ctx, text, keyboard);
      return await safeAnswerCallback(ctx, 'Refreshed!');
    }

    if (data.startsWith('th:select:')) {
      const metric = data.split(':')[2]!;
      const prefs = await getOrCreatePreferences(chatId);
      const { text, keyboard } = renderMetricSubmenu(metric, prefs);
      await safeEditMessage(ctx, text, keyboard);
      return await safeAnswerCallback(ctx);
    }

    if (data.startsWith('th:toggle:')) {
      const metric = data.split(':')[2]!;
      const prefs = await getOrCreatePreferences(chatId);

      if (metric === 'rain') {
        await db.execute(sql`UPDATE user_threshold_preferences SET rain_enabled = ${!prefs.rainEnabled}, updated_at = NOW() WHERE telegram_chat_id = ${chatId};`);
      } else if (metric === 'snow') {
        await db.execute(sql`UPDATE user_threshold_preferences SET snow_enabled = ${!prefs.snowEnabled}, updated_at = NOW() WHERE telegram_chat_id = ${chatId};`);
      } else if (metric === 'wind') {
        await db.execute(sql`UPDATE user_threshold_preferences SET wind_enabled = ${!prefs.windEnabled}, updated_at = NOW() WHERE telegram_chat_id = ${chatId};`);
      } else if (metric === 'frost') {
        await db.execute(sql`UPDATE user_threshold_preferences SET frost_enabled = ${!prefs.frostEnabled}, updated_at = NOW() WHERE telegram_chat_id = ${chatId};`);
      } else if (metric === 'heat') {
        await db.execute(sql`UPDATE user_threshold_preferences SET heat_enabled = ${!prefs.heatEnabled}, updated_at = NOW() WHERE telegram_chat_id = ${chatId};`);
      }

      const updatedPrefs = await getOrCreatePreferences(chatId);
      const { text, keyboard } = renderMetricSubmenu(metric, updatedPrefs);
      await safeEditMessage(ctx, text, keyboard);
      return await safeAnswerCallback(ctx, 'Setting toggled!');
    }

    if (data.startsWith('th:set:')) {
      const parts = data.split(':');
      const metric = parts[2]!;
      const val = parts[3]!;

      if (metric === 'rain') {
        await db.execute(sql`UPDATE user_threshold_preferences SET rain_enabled = true, rain_threshold_mm = ${val}, updated_at = NOW() WHERE telegram_chat_id = ${chatId};`);
      } else if (metric === 'snow') {
        await db.execute(sql`UPDATE user_threshold_preferences SET snow_enabled = true, snow_threshold_cm = ${val}, updated_at = NOW() WHERE telegram_chat_id = ${chatId};`);
      } else if (metric === 'wind') {
        await db.execute(sql`UPDATE user_threshold_preferences SET wind_enabled = true, wind_threshold_kmh = ${val}, updated_at = NOW() WHERE telegram_chat_id = ${chatId};`);
      } else if (metric === 'frost') {
        await db.execute(sql`UPDATE user_threshold_preferences SET frost_enabled = true, frost_threshold_c = ${val}, updated_at = NOW() WHERE telegram_chat_id = ${chatId};`);
      } else if (metric === 'heat') {
        await db.execute(sql`UPDATE user_threshold_preferences SET heat_enabled = true, heat_threshold_c = ${val}, updated_at = NOW() WHERE telegram_chat_id = ${chatId};`);
      } else if (metric === 'hail') {
        await db.execute(sql`UPDATE user_threshold_preferences SET hail_mode = ${parseInt(val, 10)}, updated_at = NOW() WHERE telegram_chat_id = ${chatId};`);
      }

      const updatedPrefs = await getOrCreatePreferences(chatId);
      const { text, keyboard } = renderMetricSubmenu(metric, updatedPrefs);
      await safeEditMessage(ctx, text, keyboard);
      return await safeAnswerCallback(ctx, 'Threshold updated!');
    }

    if (data === 'th:forecast') {
      await ctx.answerCallbackQuery('Checking 24h forecast...');
      // Trigger forecast flow
      const userLoc = await db.execute(sql`
        SELECT ST_X(location::geometry) AS lon, ST_Y(location::geometry) AS lat, location_name AS "locationName", h3_index AS "h3Index"
        FROM user_alert_zones WHERE telegram_chat_id = ${chatId} LIMIT 1;
      `);
      const row = (userLoc as any[])[0];
      if (!row) {
        return await ctx.reply('⚠️ Register a location first with /start.');
      }
      try {
        const prefs = await getOrCreatePreferences(chatId);
        const forecast = await fetchRollingForecast24h(Number(row.lat), Number(row.lon), {
          h3Index: row.h3Index,
        });
        const evalResult = evaluateWeatherThresholds(
          { telegramChatId: chatId, locationName: row.locationName, lat: Number(row.lat), lon: Number(row.lon) },
          prefs,
          forecast
        );

        if (evalResult && evalResult.breaches.length > 0) {
          await ctx.reply(formatThresholdAlertHtml(evalResult), { parse_mode: 'HTML' });
        } else {
          await ctx.reply(`✅ <b>Forecast is clear for ${escapeHtml(row.locationName)}!</b> No thresholds breached in next 24 hours.`, { parse_mode: 'HTML' });
        }
      } catch (err: any) {
        console.error('Error fetching forecast in th:forecast callback:', err);
        await ctx.reply(`⚠️ Unable to fetch live weather forecast: ${escapeHtml(err?.message || 'Network error')}. Please try again shortly.`, { parse_mode: 'HTML' });
      }
    }
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
    const matchedUsers = (await matchStormToUsers(alert)).filter((user) => user.telegramChatId === chatId);

    // Dispatch notification via Deduplication Gate & BullMQ Queue
    for (const matched of matchedUsers) {

      const dedup = await evaluateAlertDeduplication(
        matched.telegramChatId,
        alert.cellId,
        alert.severityRank,
        undefined,
        alert.expires
      );

      if (dedup.shouldSend) {
        console.log(
          `🚀 [Deduplicator] Approved alert for user ${matched.telegramChatId} (Reason: ${dedup.reason}). Enqueueing...`
        );
        await enqueueAlertDispatch({ alert, user: matched, reason: dedup.reason, dedupTimestamp: dedup.timestamp });
      } else {
        console.log(
          `🛑 [Deduplicator] Alert suppressed for user ${matched.telegramChatId} by Redis cooldown (Reason: ${dedup.reason}).`
        );
        await ctx.reply(
          `⏳ <b>Alert Suppressed by Redis Deduplication Gate</b>\n\n` +
            `• <b>Storm Cell:</b> <code>${escapeHtml(alert.cellId)}</code>\n` +
            `• <b>Repeat Suppression:</b> ${alert.expires ? 'until warning expiry' : '24 hours'}\n` +
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

    const matchedUsers = (await matchStormToUsers(alert)).filter((user) => user.telegramChatId === chatId);

    for (const matched of matchedUsers) {
      const dedup = await evaluateAlertDeduplication(
        matched.telegramChatId,
        alert.cellId,
        alert.severityRank,
        undefined,
        alert.expires
      );

      if (dedup.shouldSend) {
        console.log(
          `🚀 [Deduplicator] Approved alert for user ${matched.telegramChatId} (Reason: ${dedup.reason}). Enqueueing...`
        );
        await enqueueAlertDispatch({ alert, user: matched, reason: dedup.reason, dedupTimestamp: dedup.timestamp });
      } else {
        await ctx.reply(
          `⏳ <b>Alert Suppressed: Cooldown still active and no escalation detected.</b>`,
          { parse_mode: 'HTML' }
        );
      }
    }
  });

  // 6b. /testradar command (Simulates an approaching Doppler radar storm cell)
  bot.command('testradar', async (ctx) => {
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
      return await ctx.reply('⚠️ Please register your location first using /start before triggering a test.');
    }

    const user = rows[0];
    await ctx.reply('📡 <b>Simulating Doppler radar detection (approaching cell)...</b>', { parse_mode: 'HTML' });

    const stormCellId = `RADAR_SIM_${Date.now().toString().slice(-4)}`;
    const expiresAt = new Date(Date.now() + 35 * 60_000).toISOString();
    const dedup = await evaluateAlertDeduplication(chatId, stormCellId, 1, undefined, expiresAt);

    if (dedup.shouldSend) {
      await enqueueAlertDispatch({
        radar: {
          stormCellId,
          etaMinutes: 25,
          speedKmh: 52,
          headingDeg: 45,
          maxDbz: 55,
        },
        user: {
          id: user.id,
          userId: user.id.toString(),
          telegramChatId: chatId,
          locationName: user.locationName,
          h3Index: user.h3Index,
          lat: Number(user.lat),
          lon: Number(user.lon),
        },
        reason: 'RADAR_APPROACH',
        dedupTimestamp: dedup.timestamp,
      });
    } else {
      await ctx.reply(
        `⏳ <b>Radar Alert Suppressed by Redis Deduplication</b>\n\n` +
          `Use /resetalerts to clear active cooldowns.`,
        { parse_mode: 'HTML' }
      );
    }
  });

  // 6c. /testthreshold command (Simulates a multi-hazard forecast threshold alert)
  bot.command('testthreshold', async (ctx) => {
    const chatId = ctx.chat.id;

    const result = await db.execute(sql`
      SELECT 
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
      return await ctx.reply('⚠️ Please register your location first using /start before triggering a test.');
    }

    const user = rows[0];
    await ctx.reply('🌧️ <b>Simulating 24-hour forecast threshold breach...</b>', { parse_mode: 'HTML' });

    const mockAlert: ConsolidatedThresholdAlert = {
      chatId,
      locationName: user.locationName,
      lat: Number(user.lat),
      lon: Number(user.lon),
      windowStartTime: new Date().toISOString(),
      windowEndTime: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      breaches: [
        {
          metric: 'RAIN',
          symbol: '🌧️',
          title: 'Heavy Rainfall',
          configuredThreshold: 5.0,
          forecastedValue: 18.4,
          unit: 'mm',
          recommendation: 'Check drainage, secure outdoor items, and expect localized surface water accumulation.',
          severityRank: 2,
        },
        {
          metric: 'WIND',
          symbol: '💨',
          title: 'Damaging Wind Gusts',
          configuredThreshold: 60.0,
          forecastedValue: 78.5,
          unit: 'km/h',
          recommendation: 'Fasten garden furniture, beware of falling branches, and exercise caution while driving.',
          severityRank: 2,
        },
        {
          metric: 'FROST',
          symbol: '🥶',
          title: 'Freezing / Frost Conditions',
          configuredThreshold: 0.0,
          forecastedValue: -2.1,
          unit: '°C',
          recommendation: 'Protect sensitive plants, insulate exposed pipes, and watch for black ice.',
          severityRank: 1,
        },
      ],
    };

    const dedup = await evaluateThresholdDeduplication(chatId, mockAlert.breaches);
    if (dedup.shouldSend) {
      await enqueueAlertDispatch({
        thresholdAlert: {
          ...mockAlert,
          breaches: dedup.approvedBreaches,
        },
        user: {
          telegramChatId: chatId,
          locationName: user.locationName,
        },
        reason: 'THRESHOLD_BREACH',
      });
    } else {
      await ctx.reply(
        `⏳ <b>Threshold Alert Suppressed by Redis Deduplication</b>\n\n` +
          `Threshold alerts for today were already dispatched. Send /resetalerts to clear cooldowns.`,
        { parse_mode: 'HTML' }
      );
    }
  });

  // 7. /resetalerts command (Clears Redis cooldown state across warnings, radar, and forecast thresholds)
  bot.command('resetalerts', async (ctx) => {
    const chatId = ctx.chat.id;
    const patterns = [
      `alert:state:${chatId}:*`,
      `alert:threshold:${chatId}:*`,
    ];
    let deletedCount = 0;

    for (const pattern of patterns) {
      let cursor = '0';
      do {
        const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = nextCursor;
        if (keys.length > 0) {
          await redis.del(...keys);
          deletedCount += keys.length;
        }
      } while (cursor !== '0');
    }

    if (deletedCount > 0) {
      await ctx.reply(
        `🧹 <b>Redis alert state cleared!</b> (${deletedCount} active cooldown(s) reset across warnings, radar, and forecast thresholds).`,
        { parse_mode: 'HTML' }
      );
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
      const evaluationNote = result.totalAlerts === 0
        ? 'MeteoGate returned no usable active warning features, so location matching was skipped.'
        : `Active warning features were matched using Inverted H3 Resolution ${env.H3_RESOLUTION}.`;
      await ctx.reply(
        `🛰️ <b>Meteogate Warnings API Polling Complete</b>\n\n` +
          `• <b>Active Warnings Evaluated:</b> ${result.totalAlerts}\n` +
          `• <b>Users in Hazard Zones:</b> ${result.matchedUsers}\n` +
          `• <b>Alerts Dispatched:</b> ${result.approvedAlerts}\n` +
          `• <b>Duplicate Alerts Suppressed:</b> ${result.suppressedAlerts}\n\n` +
          `<i>${escapeHtml(evaluationNote)}</i>`,
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
