import * as h3 from 'h3-js';
import { env } from '../../config/env';
import { redis as defaultRedis } from '../../redis/client';

export interface OpenMeteoHourlyRaw {
  time: string[];
  precipitation: number[];
  snowfall: number[];
  wind_gusts_10m: number[];
  temperature_2m: number[];
  weather_code: number[];
  cape?: number[];
}

export interface OpenMeteoResponse {
  latitude: number;
  longitude: number;
  elevation?: number;
  timezone: string;
  hourly: OpenMeteoHourlyRaw;
}

export interface HourlyForecastStep {
  time: string;
  precipitationMm: number;
  snowfallCm: number;
  windGustKmh: number;
  temperatureC: number;
  weatherCode: number;
  capeJkg: number;
}

export interface RollingForecast24h {
  lat: number;
  lon: number;
  startTime: string;
  endTime: string;
  steps: HourlyForecastStep[];
}

export interface FetchForecastOptions {
  timeoutMs?: number;
  /** Redis client for result caching. When provided, responses are cached for `cacheTtlSeconds`. Defaults to project redis client. */
  redis?: { get(key: string): Promise<string | null>; setex(key: string, ttl: number, value: string): Promise<any> };
  /** TTL for cached forecasts in seconds. Defaults to 3600 (1 hour). */
  cacheTtlSeconds?: number;
  /** Explicit H3 cell index. If omitted, computed from lat/lon at configured resolution. */
  h3Index?: string;
  /**
   * Explicit cache key override. When omitted, derived from H3 cell index (`openmeteo:forecast:h3:<cell>`).
   */
  cacheKey?: string;
}

/**
 * Generates synthetic 24h forecast data when running in strictly offline or sandbox testing environments.
 */
export function generateSyntheticForecast24h(lat: number, lon: number): RollingForecast24h {
  const now = new Date();
  now.setMinutes(0, 0, 0);
  const steps: HourlyForecastStep[] = [];

  for (let i = 0; i < 24; i++) {
    const t = new Date(now.getTime() + i * 3600 * 1000);
    // Moderate afternoon rain pattern (peaking between hour 14 and 18)
    const isAfternoon = i >= 14 && i <= 18;
    const precip = isAfternoon ? 0.8 + (i === 16 ? 0.9 : 0.2) : 0.0;
    const wind = isAfternoon ? 45 + (i === 16 ? 20 : 5) : 20.0;
    const temp = isAfternoon ? 16.5 : 8.0 - (i < 6 ? 4.0 : 0);

    steps.push({
      time: t.toISOString(),
      precipitationMm: precip,
      snowfallCm: 0,
      windGustKmh: wind,
      temperatureC: temp,
      weatherCode: isAfternoon ? 61 : 1, // 61 = slight rain, 1 = mainly clear
      capeJkg: isAfternoon ? 450 : 50,
    });
  }

  return {
    lat,
    lon,
    startTime: steps[0]?.time || now.toISOString(),
    endTime: steps[steps.length - 1]?.time || now.toISOString(),
    steps,
  };
}

/**
 * Fetches high-resolution hourly forecast from Open-Meteo for given coordinates
 * and extracts the rolling 24-hour window from the current hour.
 *
 * Supports Redis caching by Uber H3 hexagonal cell (Res 6) to avoid redundant requests
 * for users in the same spatial cell.
 */
export async function fetchRollingForecast24h(
  lat: number,
  lon: number,
  options: FetchForecastOptions = {}
): Promise<RollingForecast24h> {
  const timeoutMs = options.timeoutMs || 8000;
  const cacheTtlSeconds = options.cacheTtlSeconds ?? 3600;
  const client = options.redis ?? defaultRedis;

  // Use provided H3 index or compute it from coordinates at configured resolution
  const h3Cell = options.h3Index || h3.latLngToCell(lat, lon, env.H3_RESOLUTION);
  const cacheKey = options.cacheKey || `openmeteo:forecast:h3:${h3Cell}`;

  // Try cache first
  if (client) {
    try {
      const cached = await client.get(cacheKey);
      if (cached) {
        return JSON.parse(cached) as RollingForecast24h;
      }
    } catch {
      // Cache miss or error — proceed to live fetch
    }
  }

  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(
    4
  )}&hourly=precipitation,snowfall,wind_gusts_10m,temperature_2m,weather_code,cape&forecast_days=2&timezone=UTC`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'WeatherAlertApp/1.0 (European Open-Meteo Integration)',
      },
    });

    if (response.status === 429) {
      // Respect Retry-After header if present
      const retryAfter = response.headers.get('Retry-After');
      const waitSec = retryAfter ? parseInt(retryAfter, 10) : 60;
      throw new Error(`Open-Meteo HTTP 429: Too Many Requests (retry after ${waitSec}s)`);
    }

    if (!response.ok) {
      throw new Error(`Open-Meteo HTTP ${response.status}: ${response.statusText}`);
    }

    const data = (await response.json()) as OpenMeteoResponse;
    clearTimeout(timeoutId);

    if (!data.hourly || !Array.isArray(data.hourly.time) || data.hourly.time.length === 0) {
      throw new Error('Open-Meteo returned invalid or empty hourly forecast series.');
    }

    // Find the starting index corresponding to current UTC hour
    const nowIsoHour = new Date().toISOString().substring(0, 13) + ':00';
    let startIndex = data.hourly.time.findIndex((t) => t >= nowIsoHour);
    if (startIndex < 0) startIndex = 0;

    const sliceLength = Math.min(24, data.hourly.time.length - startIndex);
    const steps: HourlyForecastStep[] = [];

    for (let i = 0; i < sliceLength; i++) {
      const idx = startIndex + i;
      steps.push({
        time: data.hourly.time[idx] || '',
        precipitationMm: Number(data.hourly.precipitation?.[idx] || 0),
        snowfallCm: Number(data.hourly.snowfall?.[idx] || 0),
        windGustKmh: Number(data.hourly.wind_gusts_10m?.[idx] || 0),
        temperatureC: Number(data.hourly.temperature_2m?.[idx] || 0),
        weatherCode: Number(data.hourly.weather_code?.[idx] || 0),
        capeJkg: Number(data.hourly.cape?.[idx] || 0),
      });
    }

    const result: RollingForecast24h = {
      lat,
      lon,
      startTime: steps[0]?.time || nowIsoHour,
      endTime: steps[steps.length - 1]?.time || nowIsoHour,
      steps,
    };

    // Persist to cache
    if (client) {
      try {
        await client.setex(cacheKey, cacheTtlSeconds, JSON.stringify(result));
      } catch {
        // Non-fatal — live data is still returned
      }
    }

    return result;
  } catch (err: any) {
    clearTimeout(timeoutId);
    throw err;
  }
}
