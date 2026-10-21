import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().default('postgresql://postgres:postgres@localhost:5433/weather_alert'),
  TELEGRAM_BOT_TOKEN: z.string().optional().default(''),
  REDIS_URL: z.string().default('redis://localhost:6380'),
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  DASHBOARD_USERNAME: z.string().optional().default('admin'),
  DASHBOARD_PASSWORD: z.string().optional().default(''),
  METEOGATE_API_KEY: z.string().optional().default(''),
  METEOGATE_API_URL: z.string().default('https://api.meteogate.eu/warnings'),
  METEOGATE_LOCATION: z.string().optional().default('ALL'),
  H3_RESOLUTION: z.coerce.number().min(0).max(15).default(6),
});

export const env = envSchema.parse(process.env);
