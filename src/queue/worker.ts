import { Worker } from 'bullmq';
import { Bot, GrammyError } from 'grammy';
import { redis } from '../redis/client';
import { ALERT_DISPATCH_QUEUE_NAME, isSyntheticChat, type AlertJobData } from './index';
import { formatAlertHtml, formatRadarApproachHtml } from '../bot/formatters';
import { releaseFailedAlertDispatch } from '../redis/deduplicator';

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

      try {
        const message = 'radar' in job.data
          ? formatRadarApproachHtml(job.data.radar, user)
          : formatAlertHtml(job.data.alert, user, reason);
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
      const cellId = 'alert' in job.data ? job.data.alert.cellId : job.data.radar.stormCellId;
      releaseFailedAlertDispatch(
        job.data.user.telegramChatId,
        cellId,
        job.data.dedupTimestamp
      ).catch((releaseError) => console.error('Failed to release alert dedup state:', releaseError));
    }
  });

  worker.on('error', (err) => {
    console.error(`❌ [Queue Worker Error]:`, err);
  });

  console.log('⚡ [Queue Worker] Alert dispatch worker running (Rate limit: 30 jobs/sec).');
  return worker;
}
