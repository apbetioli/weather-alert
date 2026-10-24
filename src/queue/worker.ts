import { Worker } from 'bullmq';
import { Bot, GrammyError } from 'grammy';
import { redis } from '../redis/client';
import { ALERT_DISPATCH_QUEUE_NAME, isSyntheticChat, type AlertJobData } from './index';
import { formatAlertHtml, formatRadarApproachHtml, formatThresholdAlertHtml } from '../bot/formatters';
import { releaseFailedAlertDispatch } from '../redis/deduplicator';
import type { MatchedUser } from '../engine/types';

export function startDispatchWorker(bot: Bot): Worker<AlertJobData> {
  const worker = new Worker<AlertJobData>(
    ALERT_DISPATCH_QUEUE_NAME,
    async (job) => {
      const { user, reason } = job.data;

      // Mock dispatch for synthetic test users to prevent hitting Telegram API and getting rate-limited/banned
      if (isSyntheticChat(user)) {
        return;
      }

      console.log(
        `📬 [Queue Worker] Processing alert job ${job.id} for user ${user.telegramChatId} (${user.locationName}) [Reason: ${reason}]`
      );

      // Guard: do not deliver alerts that are already in the past or expired
      const now = Date.now();
      if ('alert' in job.data) {
        const alert = job.data.alert;
        if (alert.expires) {
          const expTime = new Date(alert.expires).getTime();
          if (!isNaN(expTime) && expTime <= now) {
            console.log(
              `🛑 [Queue Worker] Dropping expired CAP alert for user ${user.telegramChatId} (${alert.event}, expired at ${alert.expires}).`
            );
            return;
          }
        }
      } else if ('thresholdAlert' in job.data) {
        const threshold = job.data.thresholdAlert;
        // Verify threshold alert has not expired and has at least one active/future breach
        const windowEnd = new Date(threshold.windowEndTime).getTime();
        if (!isNaN(windowEnd) && windowEnd <= now) {
          console.log(
            `🛑 [Queue Worker] Dropping expired threshold alert for user ${user.telegramChatId} (Window ended ${threshold.windowEndTime}).`
          );
          return;
        }

        const activeBreaches = threshold.breaches.filter((b) => {
          if (!b.peakTime) return true;
          const peakMs = new Date(b.peakTime).getTime();
          return isNaN(peakMs) || peakMs + 3600 * 1000 > now;
        });

        if (activeBreaches.length === 0) {
          console.log(
            `🛑 [Queue Worker] Dropping threshold alert for user ${user.telegramChatId}: all breach peak times are in the past.`
          );
          return;
        }
        threshold.breaches = activeBreaches;
      } else if ('radar' in job.data) {
        const radar = job.data.radar;
        const jobAgeMs = now - (job.timestamp || now);
        const etaMs = radar.etaMinutes * 60 * 1000;
        // Drop radar notice if job waited in queue longer than ETA + 5 minutes grace
        if (jobAgeMs > etaMs + 5 * 60 * 1000) {
          console.log(
            `🛑 [Queue Worker] Dropping stale radar notice for user ${user.telegramChatId} (ETA ${radar.etaMinutes}m has passed).`
          );
          return;
        }
      }

      try {
        const message = 'radar' in job.data
          ? formatRadarApproachHtml(job.data.radar, user as MatchedUser)
          : 'thresholdAlert' in job.data
          ? formatThresholdAlertHtml(job.data.thresholdAlert)
          : formatAlertHtml(job.data.alert, user as MatchedUser, reason);
        await bot.api.sendMessage(user.telegramChatId, message, {
          parse_mode: 'HTML',
        });
        console.log(`✅ [Queue Worker] Successfully delivered alert to chat ${user.telegramChatId}`);
      } catch (err) {
        if (err instanceof GrammyError && (
          err.error_code === 403 ||
          (err.error_code === 400 && /chat not found|user is deactivated|bot was blocked|can't initiate conversation/i.test(err.description))
        )) {
          console.warn(`⚠️ [Queue Worker] Unreachable chat ${user.telegramChatId} (${err.description}). Skipping retry.`);
          return;
        }
        console.error(`❌ [Queue Worker] Failed delivering alert to chat ${user.telegramChatId}:`, err);
        throw err; // Re-throw to trigger BullMQ retry/exponential backoff
      }
    },
    {
      connection: redis.duplicate(),
      limiter: {
        max: 30,
        duration: 1000,
      },
    }
  );

  worker.on('completed', (job) => {
    if (!isSyntheticChat(job.data.user)) {
      console.log(`✨ [Queue Worker] Job ${job.id} completed successfully.`);
    }
  });

  worker.on('failed', (job, err) => {
    console.error(`⚠️ [Queue Worker] Job ${job?.id} failed after ${job?.attemptsMade} attempt(s):`, err.message);
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1) && job.data.dedupTimestamp !== undefined) {
      const cellId = 'alert' in job.data
        ? job.data.alert.cellId
        : 'radar' in job.data
        ? job.data.radar.stormCellId
        : null; // ThresholdAlertJobData has no cellId; skip dedup release
      if (cellId) {
        releaseFailedAlertDispatch(
          job.data.user.telegramChatId,
          cellId,
          job.data.dedupTimestamp
        ).catch((releaseError) => console.error('Failed to release alert dedup state:', releaseError));
      }
    }
  });

  worker.on('error', (err) => {
    console.error(`❌ [Queue Worker Error]:`, err);
  });

  console.log('⚡ [Queue Worker] Alert dispatch worker running (Rate limit: 30 jobs/sec).');
  return worker;
}
