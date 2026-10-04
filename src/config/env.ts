import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().default('postgresql://postgres:postgres@localhost:5433/weather_alert'),
  TELEGRAM_BOT_TOKEN: z.string().optional().default(''),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  PORT: z.coerce.number().default(3000),
});

export const env = envSchema.parse(process.env);
