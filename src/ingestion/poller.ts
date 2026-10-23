import { fetchMeteogateWarnings } from './providers/meteogate';
import { mergeMeteoAlarmWarningAreas, normalizeMeteoAlarmAlert } from './normalizer';
import { matchStormUsingH3 } from '../engine/h3-matcher';
import { evaluateAlertDeduplication, evaluateThresholdDeduplication, releaseFailedAlertDispatch } from '../redis/deduplicator';
import { enqueueAlertDispatchBatch, alertDispatchQueue, isSyntheticChat, type AlertJobInput } from '../queue';
import { db } from '../db';
import { sql } from 'drizzle-orm';
import { fetchRollingForecast24h } from './providers/open-meteo';
import { evaluateWeatherThresholds } from '../engine/threshold-evaluator';
import type { UserThresholdPreferences } from '../db/schema';
import { redis } from '../redis/client';
import * as h3 from 'h3-js';
import { env } from '../config/env';

export interface PollResult {
  totalAlerts: number;
  matchedUsers: number;
  approvedAlerts: number;
  suppressedAlerts: number;
}

/**
 * Orchestrates an end-to-end ingestion and notification sweep:
 * 1. Fetch live weather warnings from Meteogate Warnings API (with exact polygons)
 * 2. Normalize CAP alerts to standard StormAlert objects
 * 3. Match users using the Inverted H3 Spatial Engine
 * 4. Pass each candidate through the Redis Lua Deduplication Gate
 * 5. Enqueue approved alerts into BullMQ for async delivery
 */
let activePoll: Promise<PollResult> | undefined;

export function pollMeteoAlarmAlerts(): Promise<PollResult> {
  if (activePoll) return activePoll;
  activePoll = runMeteoAlarmPoll().finally(() => {
    activePoll = undefined;
  });
  return activePoll;
}

async function runMeteoAlarmPoll(): Promise<PollResult> {
  const startTime = performance.now();
  console.log('🔄 [Poller] Starting Meteogate European warnings poll sweep...');

  const rawAlertFeatures = await fetchMeteogateWarnings();
  const rawAlerts = mergeMeteoAlarmWarningAreas(rawAlertFeatures);
  const totalAlerts = rawAlerts.length;

  const uniqueMatchedUsers = new Set<number>();
  let totalMatchEvents = 0;
  let approvedAlertsCount = 0;
  let suppressedAlertsCount = 0;

  for (const raw of rawAlerts) {
    try {
    const alert = normalizeMeteoAlarmAlert(raw);

    // Guard: ignore alerts that have already expired
    if (alert.expires) {
      const expTime = new Date(alert.expires).getTime();
      if (!isNaN(expTime) && expTime <= Date.now()) {
        continue;
      }
    }

    // Guard: always require polygon geometry for spatial matching (no hardcoded region shortcuts)
    if (!alert.polygonGeoJson?.coordinates || alert.polygonGeoJson.coordinates.length === 0) {
      continue;
    }

    // Inverted H3 spatial matching
    const matchedUsers = await matchStormUsingH3(alert);
    if (matchedUsers.length === 0) continue;

    totalMatchEvents += matchedUsers.length;

    let stormApproved = 0;
    let stormSuppressed = 0;
    const pendingJobs: AlertJobInput[] = [];

    for (const user of matchedUsers) {
      uniqueMatchedUsers.add(user.telegramChatId);

      // 3. Evaluate against Redis Atomic Deduplication Gate
      const dedup = await evaluateAlertDeduplication(
        user.telegramChatId,
        alert.cellId,
        alert.severityRank,
        undefined,
        alert.expires
      );

      if (dedup.shouldSend) {
        approvedAlertsCount++;
        stormApproved++;

        // Log individual approvals for real users; suppress per-user spam for synthetic test users
        if (!isSyntheticChat(user)) {
          console.log(
            `🚀 [Poller] Approved alert for chat ${user.telegramChatId} (${user.locationName}) - Warning: "${alert.event}" [Reason: ${dedup.reason}]`
          );
        }

        // Only enqueue real users to avoid flooding BullMQ with dummy jobs
        if (!isSyntheticChat(user)) {
          pendingJobs.push({
            alert,
            user,
            reason: dedup.reason,
            dedupTimestamp: dedup.timestamp,
          });
        }
      } else {
        suppressedAlertsCount++;
        stormSuppressed++;

        if (!isSyntheticChat(user)) {
          console.log(
            `🛑 [Poller] Suppressed redundant alert for chat ${user.telegramChatId} (Cell: ${alert.cellId})`
          );
        }
      }
    }

    if (pendingJobs.length > 0) {
      try {
        await enqueueAlertDispatchBatch(pendingJobs);
      } catch (err) {
        console.error(`❌ [Poller] Failed to enqueue alert batch for ${alert.cellId}:`, err);
      }
    }

    console.log(
      `⬡ [Poller] Warning "${alert.event}" (${alert.cellId}): ${matchedUsers.length} matched -> ${stormApproved} approved, ${stormSuppressed} suppressed.`
    );
    } catch (err) {
      console.error(`❌ [Poller] Skipping failed alert ${raw.identifier}:`, err);
    }
  }

  const elapsedMs = (performance.now() - startTime).toFixed(1);
  console.log(
    `✨ [Poller] Completed sweep in ${elapsedMs}ms: ${totalAlerts} alerts evaluated, ${uniqueMatchedUsers.size} unique user(s) affected across ${totalMatchEvents} alert event(s) (${approvedAlertsCount} approved, ${suppressedAlertsCount} suppressed).`
  );

  return {
    totalAlerts,
    matchedUsers: uniqueMatchedUsers.size,
    approvedAlerts: approvedAlertsCount,
    suppressedAlerts: suppressedAlertsCount,
  };
}

export interface ThresholdPollResult {
  totalEvaluated: number;
  usersWithBreaches: number;
  dispatchedAlerts: number;
  suppressedAlerts: number;
}

let activeThresholdPoll: Promise<ThresholdPollResult> | undefined;

/**
 * Sweeps all registered users, queries high-resolution 24h numerical forecasts from Open-Meteo,
 * evaluates personal weather thresholds, and dispatches consolidated alerts with Redis deduplication.
 */
export function pollThresholdAlerts(): Promise<ThresholdPollResult> {
  if (activeThresholdPoll) return activeThresholdPoll;
  activeThresholdPoll = runThresholdPoll().finally(() => {
    activeThresholdPoll = undefined;
  });
  return activeThresholdPoll;
}

async function runThresholdPoll(): Promise<ThresholdPollResult> {
  const startTime = performance.now();
  console.log('🔄 [Poller] Starting multi-hazard weather threshold evaluation sweep...');

  let totalEvaluated = 0;
  let usersWithBreaches = 0;
  let dispatchedAlerts = 0;
  let suppressedAlerts = 0;

  // Minimum delay between Open-Meteo API calls to stay within rate limits.
  // Open-Meteo free tier allows ~10,000 requests/day — 200ms spacing gives ~5 req/s.
  const INTER_REQUEST_DELAY_MS = 200;

  try {
    // 1. Query all registered users along with their threshold preferences
    const users = (await db.execute(sql`
      SELECT 
        u.telegram_chat_id AS "telegramChatId",
        u.location_name AS "locationName",
        u.h3_index AS "h3Index",
        ST_X(u.location::geometry) AS lon,
        ST_Y(u.location::geometry) AS lat,
        p.rain_enabled AS "rainEnabled",
        p.rain_threshold_mm AS "rainThresholdMm",
        p.snow_enabled AS "snowEnabled",
        p.snow_threshold_cm AS "snowThresholdCm",
        p.wind_enabled AS "windEnabled",
        p.wind_threshold_kmh AS "windThresholdKmh",
        p.frost_enabled AS "frostEnabled",
        p.frost_threshold_c AS "frostThresholdC",
        p.heat_enabled AS "heatEnabled",
        p.heat_threshold_c AS "heatThresholdC",
        p.hail_mode AS "hailMode"
      FROM user_alert_zones u
      LEFT JOIN user_threshold_preferences p ON u.telegram_chat_id = p.telegram_chat_id;
    `)) as any[];

    totalEvaluated = users.length;

    // Track which H3 hexagons have already been evaluated in this sweep
    // so concurrent users in the same cell share one cached forecast.
    const fetchedH3Cells = new Set<string>();

    for (const row of users) {
      const lat = Number(row.lat);
      const lon = Number(row.lon);
      if (isNaN(lat) || isNaN(lon)) continue;

      const h3Index = (row.h3Index as string) || h3.latLngToCell(lat, lon, env.H3_RESOLUTION);

      const prefs: UserThresholdPreferences = {
        id: 0,
        telegramChatId: row.telegramChatId,
        rainEnabled: row.rainEnabled ?? true,
        rainThresholdMm: row.rainThresholdMm ?? '5.00',
        snowEnabled: row.snowEnabled ?? true,
        snowThresholdCm: row.snowThresholdCm ?? '2.00',
        windEnabled: row.windEnabled ?? true,
        windThresholdKmh: row.windThresholdKmh ?? '60.0',
        frostEnabled: row.frostEnabled ?? true,
        frostThresholdC: row.frostThresholdC ?? '0.0',
        heatEnabled: row.heatEnabled ?? true,
        heatThresholdC: row.heatThresholdC ?? '35.0',
        hailMode: row.hailMode ?? 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      try {
        // Throttle only when an uncached live fetch is needed
        const isFirstInSweep = !fetchedH3Cells.has(h3Index);
        if (isFirstInSweep) {
          fetchedH3Cells.add(h3Index);
          const cacheKey = `openmeteo:forecast:h3:${h3Index}`;
          const isWarm = await redis.exists(cacheKey);
          if (!isWarm && fetchedH3Cells.size > 1) {
            await new Promise((resolve) => setTimeout(resolve, INTER_REQUEST_DELAY_MS));
          }
        }

        const forecast = await fetchRollingForecast24h(lat, lon, {
          h3Index,
          redis,
        });
        const evalResult = evaluateWeatherThresholds(
          {
            telegramChatId: row.telegramChatId,
            locationName: row.locationName,
            lat,
            lon,
          },
          prefs,
          forecast
        );

        if (!evalResult || evalResult.breaches.length === 0) continue;

        usersWithBreaches++;

        // Deduplicate through Redis 24h gate
        const dedup = await evaluateThresholdDeduplication(row.telegramChatId, evalResult.breaches);

        if (dedup.shouldSend) {
          dispatchedAlerts++;
          const alertPayload = {
            ...evalResult,
            breaches: dedup.approvedBreaches,
          };

          await alertDispatchQueue.add('dispatch-threshold-alert', {
            thresholdAlert: alertPayload,
            user: {
              telegramChatId: row.telegramChatId,
              locationName: row.locationName,
            },
            reason: 'THRESHOLD_BREACH',
          }, { priority: 2 });
        } else {
          suppressedAlerts++;
        }
      } catch (err: any) {
        console.warn(`⚠️ [Poller] Error evaluating forecast for chat ${row.telegramChatId}:`, err?.message || err);
        if (err?.message?.includes('429')) {
          console.warn('🛑 [Poller] Open-Meteo rate limit (HTTP 429) hit. Halting remaining live fetches for this sweep.');
          break;
        }
      }
    }
  } catch (err) {
    console.error('❌ [Poller] Failed threshold poll sweep:', err);
  }

  const elapsed = (performance.now() - startTime).toFixed(1);
  console.log(
    `✨ [Poller] Threshold sweep finished in ${elapsed}ms: ` +
      `${totalEvaluated} evaluated, ${usersWithBreaches} breached, ${dispatchedAlerts} dispatched, ${suppressedAlerts} suppressed.`
  );

  return {
    totalEvaluated,
    usersWithBreaches,
    dispatchedAlerts,
    suppressedAlerts,
  };
}

export interface BackgroundPollerHandles {
  warningTimer: NodeJS.Timeout;
  radarTimer: NodeJS.Timeout;
  thresholdTimer: NodeJS.Timeout;
  stop: () => void;
}

/**
 * Starts the recurring authoritative warning polling service.
 * Default interval: 10 minutes (600,000 ms), aligned with MeteoAlarm publication cadence.
 */
export function startBackgroundPoller(intervalMs: number = 10 * 60 * 1000): BackgroundPollerHandles {
  console.log(
    `⏰ [Poller] Background MeteoAlarm Poller scheduled every ${(intervalMs / 1000 / 60).toFixed(0)} minutes.`
  );
  const radarIntervalMs = 5 * 60 * 1000;
  const thresholdIntervalMs = 3 * 60 * 60 * 1000; // Every 3 hours
  console.log('⏰ [Poller] Background radar tracking scheduled every 5 minutes.');
  console.log('⏰ [Poller] Background weather threshold evaluations scheduled every 3 hours.');

  // Run initial poll sweep after a short delay (e.g. 5 seconds) to allow server startup
  const startupTimer = setTimeout(() => {
    pollMeteoAlarmAlerts().catch((err) => {
      console.error('❌ [Poller] Error in initial background poll:', err);
    });
    import('../radar').then(({ fetchLiveRadarCells }) => {
      fetchLiveRadarCells().catch((err) => {
        console.error('❌ [Poller] Error in initial radar tracking scan:', err);
      });
    });
    pollThresholdAlerts().catch((err) => {
      console.error('❌ [Poller] Error in initial threshold evaluation:', err);
    });
  }, 5000);

  const warningTimer = setInterval(() => {
    pollMeteoAlarmAlerts().catch((err) => {
      console.error('❌ [Poller] Error in scheduled background poll:', err);
    });
  }, intervalMs);

  const radarTimer = setInterval(() => {
    import('../radar').then(({ fetchLiveRadarCells }) => {
      fetchLiveRadarCells().catch((err) => {
        console.error('❌ [Poller] Error in scheduled radar tracking scan:', err);
      });
    });
  }, radarIntervalMs);

  const thresholdTimer = setInterval(() => {
    pollThresholdAlerts().catch((err) => {
      console.error('❌ [Poller] Error in scheduled threshold evaluation:', err);
    });
  }, thresholdIntervalMs);

  return {
    warningTimer,
    radarTimer,
    thresholdTimer,
    stop: () => {
      clearTimeout(startupTimer);
      clearInterval(warningTimer);
      clearInterval(radarTimer);
      clearInterval(thresholdTimer);
    },
  };
}
