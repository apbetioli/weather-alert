import { env } from '../../config/env';
import { redis } from '../../redis/client';
import type {
  MeteoGateFeatureCollection,
  MeteoGateFeature,
  CapJsonDetail,
  RawMeteoAlarmAlert,
  ParsedAwarenessLevel,
  ParsedAwarenessType,
} from '../types';

export const METEOGATE_BASE_URL = env.METEOGATE_API_URL;

/**
 * Parses CAP parameter "awareness_level" (e.g. "2; yellow; Moderate")
 */
export function parseAwarenessLevel(paramValue?: string): ParsedAwarenessLevel | undefined {
  if (!paramValue || typeof paramValue !== 'string') return undefined;
  const parts = paramValue.split(';').map((s) => s.trim());
  const numeric = parseInt(parts[0] || '1', 10);
  const color = (parts[1] || 'green').toLowerCase();
  const severity = parts[2] || 'Minor';
  return {
    numericLevel: isNaN(numeric) ? 1 : numeric,
    colorName: color,
    severityLabel: severity,
  };
}

/**
 * Parses CAP parameter "awareness_type" (e.g. "1; Wind" or "3; Thunderstorm")
 */
export function parseAwarenessType(paramValue?: string): ParsedAwarenessType | undefined {
  if (!paramValue || typeof paramValue !== 'string') return undefined;
  const parts = paramValue.split(';').map((s) => s.trim());
  const typeCode = parseInt(parts[0] || '0', 10);
  const typeName = parts[1] || 'Unknown';
  return {
    typeCode: isNaN(typeCode) ? 0 : typeCode,
    typeName,
  };
}



export interface FetchMeteogateOptions {
  locationId?: string;       // "ALL" or country code like "IT", "FR", "DE"
  apiKey?: string;
  minAwarenessLevel?: number; // 2 = yellow+, 3 = orange+, 4 = red
  pastHours?: number;         // default 6h in the past
  futureHours?: number;       // default 18h in the future (total <= 24h)
  maxAlerts?: number;
  timeoutMs?: number;
}

/**
 * Concurrency runner helper: runs a set of async tasks with a concurrency limit
 */
async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let currentIndex = 0;

  async function worker() {
    while (currentIndex < items.length) {
      const idx = currentIndex++;
      try {
        results[idx] = await fn(items[idx]!);
      } catch (err) {
        // Handled within fn
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * Fetches the exact GeoJSON boundary geometry for a feature, caching by OBJECTID.
 */
async function fetchFeatureGeometry(
  feature: MeteoGateFeature,
  timeoutMs: number
): Promise<{ type: 'Polygon' | 'MultiPolygon'; coordinates: any } | null> {
  const objectId = feature.properties.OBJECTID;
  const cacheKey = `meteogate:geometry:${objectId}`;

  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }
  } catch (err) {
    // Ignore cache errors
  }

  const geomLink = feature.links?.find(
    (l) => l.rel === 'geometry' || l.type === 'application/geo+json'
  );

  if (geomLink?.href) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(geomLink.href, {
        signal: controller.signal,
        headers: { Accept: 'application/geo+json, application/json' },
      });
      clearTimeout(timeoutId);

      if (res.ok) {
        const geojson = await res.json();
        const geom = (geojson as any).geometry || geojson;
        if (geom && (geom.type === 'Polygon' || geom.type === 'MultiPolygon') && geom.coordinates) {
          const result = {
            type: geom.type as 'Polygon' | 'MultiPolygon',
            coordinates: geom.coordinates,
          };
          try {
            await redis.setex(cacheKey, 86400, JSON.stringify(result)); // Cache for 24h
          } catch (err) {
            // Ignore cache errors
          }
          return result;
        }
      }
    } catch {
      // Fall through to bounding box fallback
    }
  }

  // Fallback to feature.geometry if available (bbox polygon)
  if (feature.geometry && feature.geometry.coordinates) {
    const fallback = {
      type: 'Polygon' as const,
      coordinates: feature.geometry.coordinates,
    };
    return fallback;
  }

  return null;
}

/**
 * Fetches CAP JSON alert details, caching by alertId.
 */
async function fetchAlertDetail(
  feature: MeteoGateFeature,
  timeoutMs: number
): Promise<CapJsonDetail | null> {
  const alertId = feature.properties.alertId;
  const cacheKey = `meteogate:detail:${alertId}`;

  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }
  } catch (err) {
    // Ignore cache errors
  }

  const jsonLink = feature.links?.find(
    (l) => l.rel === 'json' || l.type === 'application/json'
  );

  if (jsonLink?.href) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(jsonLink.href, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      clearTimeout(timeoutId);

      if (res.ok) {
        const detail = (await res.json()) as CapJsonDetail;
        try {
          await redis.setex(cacheKey, 86400, JSON.stringify(detail)); // Cache for 24h
        } catch (err) {
          // Ignore cache errors
        }
        return detail;
      }
    } catch {
      // Graceful fallback
    }
  }

  return null;
}

/**
 * Fetches live weather warnings from Meteogate Warnings API (OGC-API EDR).
 * Covers Pan-European alerts with exact regional and local polygon boundaries.
 */
export async function fetchMeteogateWarnings(
  options: FetchMeteogateOptions = {}
): Promise<RawMeteoAlarmAlert[]> {
  const locationId = options.locationId || env.METEOGATE_LOCATION || 'ALL';
  const apiKey = options.apiKey || env.METEOGATE_API_KEY || '';
  const minAwareness = options.minAwarenessLevel ?? 2; // Default: yellow, orange, red (skip green)
  const pastHours = options.pastHours ?? 6;
  const futureHours = options.futureHours ?? 18; // 6 + 18 = 24h total
  const timeoutMs = options.timeoutMs ?? 10000;
  const maxAlerts = options.maxAlerts ?? 100;

  const pastIso = new Date(Date.now() - pastHours * 3600 * 1000).toISOString();
  const futureIso = new Date(Date.now() + futureHours * 3600 * 1000).toISOString();
  const datetimeParam = `${pastIso}/${futureIso}`;

  const url = `${METEOGATE_BASE_URL}/collections/warnings/locations/${locationId}?f=json&datetime=${encodeURIComponent(datetimeParam)}`;

  const headers: Record<string, string> = {
    Accept: 'application/geo+json, application/json',
    'User-Agent': 'WeatherAlertBot/3.0',
  };

  if (apiKey) {
    headers['apikey'] = apiKey;
  }

  try {
    console.log(
      `📡 [Meteogate Ingestion] Fetching warnings for location "${locationId}" (window: -${pastHours}h..+${futureHours}h)...`
    );

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(url, {
      signal: controller.signal,
      headers,
    });
    clearTimeout(timeoutId);

    // 204 No Content indicates no active warnings matching criteria
    if (response.status === 204) {
      console.log('ℹ️ [Meteogate Ingestion] Meteogate returned 204 No Content (no active warnings).');
      return [];
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    const collection = (await response.json()) as MeteoGateFeatureCollection;
    const rawFeatures = collection.features || [];

    // Filter out superseded features and limit count
    const activeFeatures = rawFeatures
      .filter((f) => !f.properties?.supersededByAlertId)
      .slice(0, maxAlerts);

    console.log(
      `📥 [Meteogate Ingestion] Received ${rawFeatures.length} features (${activeFeatures.length} active/non-superseded).`
    );

    if (activeFeatures.length === 0) {
      return [];
    }

    // Process active features concurrently
    const processedAlerts = await mapConcurrent(activeFeatures, 8, async (feature) => {
      const alertId = feature.properties?.alertId || feature.id;
      const objectId = feature.properties?.OBJECTID || feature.id;
      const countryCode = feature.properties?.countryCode || 'EU';

      // 1. Fetch CAP detail JSON and exact geometry in parallel
      const [detail, geom] = await Promise.all([
        fetchAlertDetail(feature, 5000),
        fetchFeatureGeometry(feature, 5000),
      ]);

      if (!geom || !geom.coordinates || geom.coordinates.length === 0) {
        return null;
      }

      // 2. Select appropriate CAP info block
      let selectedInfo = detail?.info?.[0];
      if (detail?.info && detail.info.length > 1) {
        // Prefer local or English info block matching hub language
        const targetLang = (feature.properties?.hubLanguage || 'en').toLowerCase();
        selectedInfo =
          detail.info.find((i) => i.language?.toLowerCase().startsWith(targetLang)) ||
          detail.info.find((i) => i.language?.toLowerCase().startsWith('en')) ||
          detail.info[0];
      }

      const params = selectedInfo?.parameter || [];
      const awarenessLevelStr = params.find((p) => p.valueName === 'awareness_level')?.value;
      const awarenessTypeStr = params.find((p) => p.valueName === 'awareness_type')?.value;

      const parsedLevel = parseAwarenessLevel(awarenessLevelStr);
      const parsedType = parseAwarenessType(awarenessTypeStr);

      // Filter out low awareness levels (e.g. green = 1)
      if (parsedLevel && parsedLevel.numericLevel < minAwareness) {
        return null;
      }

      // Check if alert has expired
      const expiresIso = selectedInfo?.expires;
      if (expiresIso) {
        const expTime = new Date(expiresIso).getTime();
        if (!isNaN(expTime) && expTime <= Date.now()) {
          return null;
        }
      }

      // Area description
      const areaDesc =
        selectedInfo?.area?.[feature.properties?.indexArea || 0]?.areaDesc ||
        selectedInfo?.area?.[0]?.areaDesc ||
        countryCode;

      const event = selectedInfo?.event || 'Weather Warning';
      const severity = selectedInfo?.severity || parsedLevel?.severityLabel || 'Moderate';

      const alert: RawMeteoAlarmAlert = {
        identifier: `${alertId}_${objectId}`,
        event,
        severity,
        areaDesc,
        polygonCoords: geom.coordinates,
        polygonType: geom.type,
        headline: selectedInfo?.headline,
        description: selectedInfo?.description,
        instruction: selectedInfo?.instruction,
        effective: selectedInfo?.onset || selectedInfo?.expires,
        onset: selectedInfo?.onset,
        expires: selectedInfo?.expires,
        webUrl: selectedInfo?.web || feature.properties?.hubLink,
        countryCode,
        awarenessLevel: parsedLevel,
        awarenessType: parsedType,
      };

      return alert;
    });

    const validAlerts = processedAlerts.filter((a): a is RawMeteoAlarmAlert => a !== null);
    console.log(
      `✅ [Meteogate Ingestion] Successfully normalized ${validAlerts.length} warning(s) with exact polygon geometry.`
    );

    return validAlerts;
  } catch (err: any) {
    console.error(
      `❌ [Meteogate Ingestion] Live API fetch failed (${err?.message || err}).`
    );
    throw err;
  }
}
