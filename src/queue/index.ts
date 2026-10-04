import { Queue } from 'bullmq';
import { redis } from '../redis/client';
import type { StormAlert, MatchedUser } from '../engine/types';

export interface AlertJobData {
  alert: StormAlert;
  user: MatchedUser;
  reason: string;
}

export const ALERT_DISPATCH_QUEUE_NAME = 'alert-dispatch';

export const alertDispatchQueue = new Queue<AlertJobData>(ALERT_DISPATCH_QUEUE_NAME, {
  connection: redis.duplicate(),
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 1000,
    },
    removeOnComplete: 100,
    removeOnFail: 500,
  },
});

export async function enqueueAlertDispatch(jobData: AlertJobData) {
  return await alertDispatchQueue.add('dispatch-alert', jobData);
}
