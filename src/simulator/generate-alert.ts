import type { StormAlert } from '../engine/types';

/**
 * Creates a synthetic polygon (8-sided approximation) around a center point with a given radius in km.
 * Note: GeoJSON coordinates are in [longitude, latitude] order!
 */
export function generateStormPolygon(centerLat: number, centerLon: number, radiusKm: number = 8): {
  type: 'Polygon';
  coordinates: number[][][];
} {
  // Approximate conversion: 1 degree latitude ~= 111 km, 1 degree longitude ~= 111 * cos(lat) km
  const latDelta = radiusKm / 111.0;
  const lonDelta = radiusKm / (111.0 * Math.cos((centerLat * Math.PI) / 180));

  const points: number[][] = [];
  const steps = 8;

  for (let i = 0; i <= steps; i++) {
    const angle = (i * 2 * Math.PI) / steps;
    const lat = centerLat + latDelta * Math.sin(angle);
    const lon = centerLon + lonDelta * Math.cos(angle);
    // GeoJSON coordinate order: [lon, lat]
    points.push([Number(lon.toFixed(5)), Number(lat.toFixed(5))]);
  }

  return {
    type: 'Polygon',
    coordinates: [points],
  };
}

/**
 * Generates a realistic severe hail storm event centered at or approaching a given location.
 */
export function createSyntheticHailAlert(
  centerLat: number,
  centerLon: number,
  options?: {
    cellId?: string;
    hailSizeCm?: number;
    hailDescription?: string;
  }
): StormAlert {
  const cellId = options?.cellId ?? 'CELL_HAIL_SIM_01';
  const hailSizeCm = options?.hailSizeCm ?? 3.5;
  const hailDescription =
    options?.hailDescription ??
    (hailSizeCm >= 5.0 ? 'Baseball-sized' : hailSizeCm >= 3.5 ? 'Golf ball-sized' : 'Quarter-sized');

  return {
    cellId,
    event: 'Severe Thunderstorm & Hail',
    severity: 'WARNING',
    hailSizeCm,
    hailDescription,
    maxDbz: 62.5,
    speedKmh: 48,
    direction: 'ENE (65°)',
    etaMinutes: 14,
    polygonGeoJson: generateStormPolygon(centerLat, centerLon, 10),
    instruction: 'Move vehicles under cover and secure outdoor glass/equipment immediately.',
  };
}
