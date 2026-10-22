import { fetchMeteogateWarnings } from './providers/meteogate';
import { mergeMeteoAlarmWarningAreas, normalizeMeteoAlarmAlert } from './normalizer';
import { matchStormUsingH3 } from '../engine/h3-matcher';
import { evaluateAlertDeduplication, releaseFailedAlertDispatch } from '../redis/deduplicator';
import { enqueueAlertDispatchBatch, isSyntheticChat, type AlertJobInput } from '../queue';

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

export interface BackgroundPollerHandles {
  warningTimer: NodeJS.Timeout;
  radarTimer: NodeJS.Timeout;
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
  console.log('⏰ [Poller] Background radar tracking scheduled every 5 minutes.');

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

  return {
    warningTimer,
    radarTimer,
    stop: () => {
      clearTimeout(startupTimer);
      clearInterval(warningTimer);
      clearInterval(radarTimer);
    },
  };
}
