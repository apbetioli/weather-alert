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
type WarningJobInput = Omit<WarningJobData, 'alert'> & { alert: StormAlert };
type AlertJobInput = WarningJobInput | RadarApproachJobData;

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
