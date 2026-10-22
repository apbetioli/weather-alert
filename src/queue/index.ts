import { Queue } from 'bullmq';
import { redis } from '../redis/client';
import type { StormAlert, MatchedUser } from '../engine/types';

export interface WarningJobData {
  alert: Omit<StormAlert, 'polygonGeoJson'>;
  user: MatchedUser;
  reason: string;
  dedupTimestamp?: number;
}

export interface RadarApproachNotice {
  stormCellId: string;
  etaMinutes: number;
  speedKmh: number;
  headingDeg: number;
  maxDbz: number;
}

export interface RadarApproachJobData {
  radar: RadarApproachNotice;
  user: MatchedUser;
  reason: string;
  dedupTimestamp?: number;
}

export type AlertJobData = WarningJobData | RadarApproachJobData;
export type WarningJobInput = Omit<WarningJobData, 'alert'> & { alert: StormAlert };
export type AlertJobInput = WarningJobInput | RadarApproachJobData;

export function isSyntheticChat(user: { telegramChatId: number; locationName?: string }): boolean {
  return (
    Boolean(user.locationName?.startsWith('Test User')) ||
    Boolean(user.locationName?.startsWith('Radar Test User')) ||
    (user.telegramChatId >= 100_000_000 && user.telegramChatId <= 101_000_000) ||
    user.telegramChatId >= 900_000_000
  );
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

export async function enqueueAlertDispatch(jobData: AlertJobInput) {
  if ('alert' in jobData) {
    const { polygonGeoJson: _polygonGeoJson, ...alert } = jobData.alert;
    return await alertDispatchQueue.add('dispatch-alert', { ...jobData, alert });
  }
  return await alertDispatchQueue.add('dispatch-alert', jobData);
}

export async function enqueueAlertDispatchBatch(jobs: AlertJobInput[]) {
  if (jobs.length === 0) return [];
  const bulkJobs = jobs.map((jobData) => {
    if ('alert' in jobData) {
      const { polygonGeoJson: _polygonGeoJson, ...alert } = jobData.alert;
      return { name: 'dispatch-alert', data: { ...jobData, alert } };
    }
    return { name: 'dispatch-alert', data: jobData };
  });
  return await alertDispatchQueue.addBulk(bulkJobs);
}
