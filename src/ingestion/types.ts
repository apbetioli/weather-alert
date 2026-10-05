/**
 * TypeScript definitions for the Meteogate Warnings API (OGC-API EDR)
 * and internal ingestion pipeline.
 *
 * API base: https://api.meteogate.eu/warnings/collections/warnings/locations/{locationId}
 * Returns GeoJSON FeatureCollection with CAP-structured JSON details.
 */

// ────────────────────────────────────────────────────────
//  Meteogate Warnings API response types
// ────────────────────────────────────────────────────────

/** A single feature from the FeatureCollection returned by /locations/{id} */
export interface MeteoGateFeature {
  id: string;
  type: 'Feature';
  properties: MeteoGateFeatureProperties;
  geometry: {
    type: 'Polygon';
    coordinates: number[][][];
    crs?: { type: string; properties: { name: string } };
  };
  links: MeteoGateFeatureLink[];
}

export interface MeteoGateFeatureProperties {
  OBJECTID: string;
  alertId: string;
  countryCode: string;
  featureType: string;
  hubLanguage: string;
  hubTime: string;
  hubLink: string;
  indexArea: number;
  indexFeature: number;
  indexInfo: number;
  geometryDescription?: string;
  geometryType?: string;
  supersededByAlertId?: string | null;
  supersededAt?: string | null;
  supersedeType?: string | null;
}

export interface MeteoGateFeatureLink {
  type: string;
  rel: 'canonical' | 'json' | 'xml' | 'geometry' | string;
  href: string;
}

/** Top-level response for /locations/{id}?f=json */
export interface MeteoGateFeatureCollection {
  type: 'FeatureCollection';
  features: MeteoGateFeature[];
}

// ────────────────────────────────────────────────────────
//  CAP JSON detail (fetched from the detail JSON link)
// ────────────────────────────────────────────────────────

export interface CapJsonDetail {
  identifier: string;
  sender?: string;
  sent?: string;
  status?: string;
  msgType?: string;
  scope?: string;
  code?: string[];
  incidents?: string;
  references?: string;
  info: CapJsonInfo[];
}

export interface CapJsonInfo {
  language?: string;
  category?: string[];
  event: string;
  responseType?: string[];
  urgency?: string;
  severity?: string;
  certainty?: string;
  onset?: string;
  expires?: string;
  senderName?: string;
  headline?: string;
  description?: string;
  instruction?: string;
  web?: string;
  parameter?: CapJsonParameter[];
  area: CapJsonArea[];
}

export interface CapJsonParameter {
  valueName: string;
  value: string;
}

export interface CapJsonArea {
  areaDesc: string;
  polygon?: string[];
  geocode?: { valueName: string; value: string }[];
}

// ────────────────────────────────────────────────────────
//  Parsed awareness level/type from CAP parameters
// ────────────────────────────────────────────────────────

export interface ParsedAwarenessLevel {
  numericLevel: number;       // 1 = green, 2 = yellow, 3 = orange, 4 = red
  colorName: string;          // "green", "yellow", "orange", "red"
  severityLabel: string;      // "Minor", "Moderate", "Severe", "Extreme"
}

export interface ParsedAwarenessType {
  typeCode: number;           // 1-14
  typeName: string;           // "Wind", "Thunderstorm", etc.
}

// ────────────────────────────────────────────────────────
//  Internal normalized type consumed by normalizer.ts
// ────────────────────────────────────────────────────────

export interface RawMeteoAlarmAlert {
  identifier: string;
  event: string;
  severity: string;
  areaDesc: string;
  polygonCoords?: number[][][] | number[][][][]; // GeoJSON coordinate rings: Polygon [ [ [lon, lat], ... ] ] or MultiPolygon [ [ [ [lon, lat], ... ] ] ]
  polygonType?: 'Polygon' | 'MultiPolygon';
  headline?: string;
  description?: string;
  instruction?: string;
  effective?: string;
  onset?: string;
  expires?: string;
  webUrl?: string;
  countryCode?: string;
  awarenessLevel?: ParsedAwarenessLevel;
  awarenessType?: ParsedAwarenessType;
}
