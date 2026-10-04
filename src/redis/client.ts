import Redis from 'ioredis';
import { env } from '../config/env';

export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  lazyConnect: false,
});

redis.on('connect', () => {
  console.log('✅ Connected to Redis at ' + env.REDIS_URL);
});

redis.on('error', (err) => {
  console.error('❌ Redis connection error:', err);
});
