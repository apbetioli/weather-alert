import type { StormAlert } from '../engine/types';

/**
 * Creates a synthetic polygon (8-sided approximation) around a center point with a given radius in km.
 * Note: GeoJSON coordinates are in [longitude, latitude] order!
 */
function generateStormPolygon(centerLat: number, centerLon: number, radiusKm: number = 8): {
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
 * Generates a realistic severe storm event centered at or approaching a given location.
 */
export function createSyntheticAlert(
  centerLat: number,
  centerLon: number,
  options?: {
    cellId?: string;
    severityRank?: number;
  }
): StormAlert {
  const cellId = options?.cellId ?? 'CELL_SIM_01';
  const severityRank = options?.severityRank ?? 2;

  const color = severityRank >= 3 ? 'RED' : severityRank === 2 ? 'ORANGE' : 'YELLOW';
  const colorName = color;
  const severity = color === 'RED' ? 'EMERGENCY' : color === 'ORANGE' ? 'WARNING' : 'WATCH';

  return {
    cellId,
    event: 'Severe Weather Warning',
    severity,
    color,
    colorName,
    hazardType: 'THUNDERSTORM',
    severityRank,
    polygonGeoJson: generateStormPolygon(centerLat, centerLon, 10),
    instruction: 'Follow official guidance and avoid unnecessary travel.',
    headline: 'Severe Weather Alert',
    description: 'Rapidly moving severe weather system approaching the area.',
    onset: new Date().toISOString(),
    expires: new Date(Date.now() + 2 * 3600 * 1000).toISOString(),
  };
}
