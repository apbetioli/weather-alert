import { env } from '../../config/env';
import { redis } from '../../redis/client';
import { db } from '../../db';
import { sql } from 'drizzle-orm';
import type {
  MeteoGateFeatureCollection,
  MeteoGateFeature,
  CapJsonDetail,
  RawMeteoAlarmAlert,
  ParsedAwarenessLevel,
  ParsedAwarenessType,
} from '../types';

const METEOGATE_BASE_URL = env.METEOGATE_API_URL;

/**
 * Parses CAP parameter "awareness_level" (e.g. "2; yellow; Moderate")
 */
function parseAwarenessLevel(paramValue?: string): ParsedAwarenessLevel | undefined {
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
function parseAwarenessType(paramValue?: string): ParsedAwarenessType | undefined {
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
): Promise<(R | null)[]> {
  const results: (R | null)[] = new Array(items.length);
  let currentIndex = 0;

  async function worker() {
    while (currentIndex < items.length) {
      const idx = currentIndex++;
      try {
        results[idx] = await fn(items[idx]!);
      } catch (err) {
        // Preserve the slot so one bad feature does not poison the full batch.
        console.warn('⚠️ [Meteogate Ingestion] Skipping feature after processing error:', err);
        results[idx] = null;
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * Robust fetch helper that handles empty responses, 204 No Content, malformed JSON,
 * abort signals covering the entire transfer, and retries with backoff.
 */
async function fetchMeteogateJson<T>(
  url: string | URL,
  headers: Record<string, string>,
  timeoutMs: number,
  retries = 2
): Promise<{ status: number; data: T | null }> {
  let lastError: any;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, { signal: controller.signal, headers });

      if (response.status === 204) {
        return { status: 204, data: null };
      }

      const responseText = await response.text();

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}: ${responseText.slice(0, 500)}`);
      }

      if (!responseText || !responseText.trim()) {
        return { status: response.status, data: null };
      }

      try {
        const data = JSON.parse(responseText) as T;
        return { status: response.status, data };
      } catch (parseErr: any) {
        throw new Error(
          `Failed to parse JSON (HTTP ${response.status}, length ${responseText.length}): ${responseText.slice(0, 200)}`
        );
      }
    } catch (err: any) {
      lastError = err;
      if (attempt < retries) {
        const delay = 500 * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, delay));
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  throw lastError;
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
      const { data: geojson } = await fetchMeteogateJson<any>(
        geomLink.href,
        { Accept: 'application/geo+json, application/json' },
        timeoutMs,
        1
      );

      if (geojson) {
        const geom = geojson.geometry || geojson;
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
      // No authoritative geometry was returned.
    }
  }

  // feature.geometry may only be a coarse bounding box; never use it as a zone boundary.
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
      const { data: detail } = await fetchMeteogateJson<CapJsonDetail>(
        jsonLink.href,
        { Accept: 'application/json' },
        timeoutMs,
        1
      );

      if (detail) {
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
  const futureHours = options.futureHours ?? 18;
  const timeoutMs = options.timeoutMs ?? 10000;
  // ALL can span many countries, so a small cap can fill before local warnings
  // appear later in the paginated feed.
  const maxAlerts = options.maxAlerts ?? 1000;

  const now = new Date();
  const activeFromIso = now.toISOString();
  const futureIso = new Date(Date.now() + futureHours * 3600 * 1000).toISOString();
  const baseUrl = METEOGATE_BASE_URL.replace(/\/+$/, '');

  const headers: Record<string, string> = {
    Accept: 'application/geo+json, application/json',
    'User-Agent': 'WeatherAlertBot/3.0',
  };

  if (apiKey) {
    headers['apikey'] = apiKey;
  }

  try {
    console.log(
      `📡 [Meteogate Ingestion] Fetching warnings for location "${locationId}" (active now through +${futureHours}h)...`
    );

    // EDR pages are 100 features by default. Keep advancing when a page is
    // entirely superseded so it cannot hide current alerts on later pages.
    const pageSize = 100;
    const maxPagesPerWindow = 10;
    const messageWindowMs = 23 * 60 * 60 * 1000;
    const lookbackMs = 24 * 60 * 60 * 1000; // Query within the last 24h to avoid API rate-limit exhaustion
    let rawFeatureCount = 0;
    let pagesFetched = 0;
    const activeFeatures: MeteoGateFeature[] = [];

    // Query bounded, non-overlapping message windows to respect the API's
    // sub-24-hour datetime limit while retaining long-running active alerts.
    for (let windowEnd = now.getTime(); windowEnd > now.getTime() - lookbackMs && activeFeatures.length < maxAlerts; windowEnd -= messageWindowMs) {
      const windowStart = Math.max(windowEnd - messageWindowMs, now.getTime() - lookbackMs);
      const windowEndIso = new Date(windowEnd).toISOString();
      const windowStartIso = new Date(windowStart).toISOString();
      let page = 1;
      for (; page <= maxPagesPerWindow && activeFeatures.length < maxAlerts; page++) {
        const url = new URL(
          `${baseUrl}/collections/warnings/locations/${encodeURIComponent(locationId)}`
        );
        url.searchParams.set('f', 'json');
        url.searchParams.set('datetime', `${windowStartIso}/${windowEndIso}`);
        url.searchParams.set('active', `${activeFromIso}/${futureIso}`);
        url.searchParams.set('page', String(page));

        const { status, data: collection } = await fetchMeteogateJson<MeteoGateFeatureCollection>(
          url,
          headers,
          timeoutMs,
          2
        );

        if (status === 204 || !collection) break;

        const pageFeatures = collection.features || [];
        pagesFetched++;
        rawFeatureCount += pageFeatures.length;
        activeFeatures.push(...pageFeatures.filter((f) => !f.properties?.supersededByAlertId));
        if (pageFeatures.length < pageSize) break;
      }
      if (page > maxPagesPerWindow) {
        console.warn(`⚠️ [Meteogate Ingestion] Reached pagination safety limit for ${windowStartIso}.`);
      }
    }

    activeFeatures.length = Math.min(activeFeatures.length, maxAlerts);

    console.log(
      `📥 [Meteogate Ingestion] Received ${rawFeatureCount} features across ${pagesFetched} page(s) (${activeFeatures.length} active/non-superseded).`
    );


    if (activeFeatures.length === 0) {
      return [];
    }

    // In-memory cache for EMMA_ID geometry lookups within this ingestion run,
    // avoiding redundant DB queries when many features reference the same zone.
    const emmaGeomCache = new Map<string, any>();

    // Process active features concurrently
    const processedAlerts = await mapConcurrent(activeFeatures, 8, async (feature) => {
      const alertId = feature.properties?.alertId || feature.id;
      const countryCode = feature.properties?.countryCode || 'EU';

      // 1. Fetch CAP detail JSON (geometry is fetched later if needed)
      const detail = await fetchAlertDetail(feature, 5000);

      // CAP updates reference the previous message. Carry its canonical dedup
      // ID forward so updates enter the existing severity escalation state.
      const referencedId = detail?.references
        ?.trim()
        .split(/\s+/)[0]
        ?.split(',')[1];
      let dedupId = detail?.incidents?.trim() || referencedId || String(alertId);
      if (referencedId) {
        try {
          dedupId = (await redis.get(`meteogate:canonical:${referencedId}`)) || dedupId;
        } catch {
          // The CAP incident/reference ID still provides a stable fallback.
        }
      }
      try {
        await redis.setex(`meteogate:canonical:${alertId}`, 30 * 86400, dedupId);
      } catch {
        // Dedup remains functional for this alert even if alias caching fails.
      }

      let geom: any = null;

      // 2. Select appropriate CAP info block
      const featureInfoIndex = feature.properties?.indexInfo;
      const indexedInfo = Number.isInteger(featureInfoIndex) && featureInfoIndex >= 0
        ? detail?.info?.[featureInfoIndex]
        : undefined;
      let selectedInfo = indexedInfo || detail?.info?.[0];
      if (!indexedInfo && detail?.info && detail.info.length > 1) {
        const targetLang = (feature.properties?.hubLanguage || 'en').toLowerCase();
        selectedInfo =
          detail.info.find((i) => i.language?.toLowerCase().startsWith(targetLang)) ||
          detail.info.find((i) => i.language?.toLowerCase().startsWith('en')) ||
          detail.info[0];
      }

      const featureAreaIndex = feature.properties?.indexArea;
      const selectedArea = Number.isInteger(featureAreaIndex) && featureAreaIndex! >= 0
        ? selectedInfo?.area?.[featureAreaIndex!]
        : selectedInfo?.area?.[0];

      // Try to find EMMA_ID to get authoritative boundary from DB
      const emmaId = selectedArea?.geocode?.find((g) => g.valueName?.toUpperCase() === 'EMMA_ID')?.value;
      if (emmaId) {
        // Check in-memory cache first to avoid repeated DB queries for the same zone
        if (emmaGeomCache.has(emmaId)) {
          geom = emmaGeomCache.get(emmaId);
        } else {
          try {
            const res = await db.execute(sql`SELECT ST_AsGeoJSON(geometry) as geojson FROM meteoalarm_zones WHERE emma_id = ${emmaId}`);
            if (res.length > 0 && res[0]?.geojson) {
              geom = JSON.parse(res[0].geojson as string);
              emmaGeomCache.set(emmaId, geom);
            }
          } catch (dbErr) {
            console.error(`❌ [Meteogate Ingestion] DB geometry fetch failed for EMMA_ID ${emmaId}:`, dbErr);
          }
        }
      }

      // Fallback to Meteogate geometry link if DB missing
      if (!geom) {
        geom = await fetchFeatureGeometry(feature, 5000);
        
        // If we successfully fetched it and we have an EMMA_ID, save it to the DB for next time
        if (geom && geom.coordinates && geom.coordinates.length > 0 && emmaId) {
          try {
            const name = selectedArea?.areaDesc || countryCode;
            const geomStr = JSON.stringify(geom);
            
            await db.execute(sql`
              INSERT INTO meteoalarm_zones (emma_id, country_code, name, geometry)
              VALUES (
                ${emmaId},
                ${countryCode},
                ${name},
                ST_SetSRID(ST_Multi(ST_GeomFromGeoJSON(${geomStr})), 4326)
              )
              ON CONFLICT (emma_id) DO NOTHING
            `);
            emmaGeomCache.set(emmaId, geom);
            console.log(`💾 [Meteogate Ingestion] Saved new authoritative boundary to DB for EMMA_ID: ${emmaId}`);
          } catch (dbErr) {
            console.error(`❌ [Meteogate Ingestion] DB geometry save failed for EMMA_ID ${emmaId}:`, dbErr);
          }
        }
      }

      if (!geom || !geom.coordinates || geom.coordinates.length === 0) {
        return null;
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
      const areaDesc = selectedArea?.areaDesc || countryCode;

      const event = selectedInfo?.event || 'Weather Warning';
      const severity = selectedInfo?.severity || parsedLevel?.severityLabel || 'Moderate';

      const alert: RawMeteoAlarmAlert = {
        // OBJECTID identifies a feature/area row, not the CAP warning. Use the
        // warning ID so multiple area features for one warning share dedup state.
        identifier: String(dedupId),
        event,
        severity,
        areaDesc,
        polygonCoords: geom.coordinates,
        polygonType: geom.type,
        headline: selectedInfo?.headline,
        description: selectedInfo?.description,
        instruction: selectedInfo?.instruction,
        effective: selectedInfo?.onset,
        onset: selectedInfo?.onset,
        expires: selectedInfo?.expires,
        webUrl: selectedInfo?.web || feature.properties?.hubLink,
        countryCode,
        awarenessLevel: parsedLevel,
        awarenessType: parsedType,
      };

      return alert;
    });

    const validAlerts = processedAlerts.filter((a): a is RawMeteoAlarmAlert => a != null);
    if (emmaGeomCache.size > 0) {
      console.log(
        `🗺️  [Meteogate Ingestion] Used authoritative DB boundaries for ${emmaGeomCache.size} unique EMMA zone(s).`
      );
    }
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
