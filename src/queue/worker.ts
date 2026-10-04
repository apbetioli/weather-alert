import { Worker } from 'bullmq';
import { Bot } from 'grammy';
import { redis } from '../redis/client';
import { ALERT_DISPATCH_QUEUE_NAME, AlertJobData } from './index';
import { formatHailAlert } from '../bot/formatters';

export function startDispatchWorker(bot: Bot): Worker<AlertJobData> {
  const worker = new Worker<AlertJobData>(
    ALERT_DISPATCH_QUEUE_NAME,
    async (job) => {
      const { alert, user, reason } = job.data;
      console.log(
        `📬 [Queue Worker] Processing alert job ${job.id} for user ${user.telegramChatId} (${user.locationName}) [Reason: ${reason}]`
      );

      try {
        const message = formatHailAlert(alert, user, reason);
        await bot.api.sendMessage(user.telegramChatId, message, {
          parse_mode: 'HTML',
        });
        console.log(`✅ [Queue Worker] Successfully delivered alert to chat ${user.telegramChatId}`);
      } catch (err) {
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
    console.log(`✨ [Queue Worker] Job ${job.id} completed successfully.`);
  });

  worker.on('failed', (job, err) => {
    console.error(`⚠️ [Queue Worker] Job ${job?.id} failed after ${job?.attemptsMade} attempt(s):`, err.message);
  });

  worker.on('error', (err) => {
    console.error(`❌ [Queue Worker Error]:`, err);
  });

  console.log('⚡ [Queue Worker] Alert dispatch worker running (Rate limit: 30 jobs/sec).');
  return worker;
}
