export type AlertColor = 'YELLOW' | 'ORANGE' | 'RED';

export type HazardType =
  | 'HAIL'
  | 'THUNDERSTORM'
  | 'WIND'
  | 'RAIN'
  | 'FLOOD'
  | 'RAIN_FLOOD'
  | 'SNOW_ICE'
  | 'FOG'
  | 'HIGH_TEMPERATURE'
  | 'LOW_TEMPERATURE'
  | 'COASTAL_EVENT'
  | 'FOREST_FIRE'
  | 'AVALANCHE'
  | 'MARINE_HAZARD'
  | 'DROUGHT'
  | 'OTHER';

export interface HazardMetadata {
  type: HazardType;
  symbol: string;
  nameEn: string;
  description: string;
}

export const METEOALARM_HAZARDS: Record<HazardType, HazardMetadata> = {
  THUNDERSTORM: {
    type: 'THUNDERSTORM',
    symbol: '⚡',
    nameEn: 'Thunderstorm',
    description: 'Intense lightning, thunder, torrential rain, gusts and possible hail.',
  },
  HAIL: {
    type: 'HAIL',
    symbol: '🧊',
    nameEn: 'Hail',
    description: 'Ice precipitation associated with severe convective thunderstorms.',
  },
  WIND: {
    type: 'WIND',
    symbol: '💨',
    nameEn: 'Wind',
    description: 'High wind speeds and gusts with risks to infrastructure.',
  },
  RAIN: {
    type: 'RAIN',
    symbol: '🌧️',
    nameEn: 'Rain',
    description: 'Intense or prolonged rainfall with risk of landslides and flooding.',
  },
  FLOOD: {
    type: 'FLOOD',
    symbol: '🌊',
    nameEn: 'Flood',
    description: 'Flooding of areas caused by river overflow.',
  },
  RAIN_FLOOD: {
    type: 'RAIN_FLOOD',
    symbol: '🌊⚡',
    nameEn: 'Rain Flood',
    description: 'Rapid rise in water levels from concentrated violent rain.',
  },
  SNOW_ICE: {
    type: 'SNOW_ICE',
    symbol: '❄️',
    nameEn: 'Snow or Ice',
    description: 'Accumulation of snow, freezing rain and ice with slippery road surfaces.',
  },
  FOG: {
    type: 'FOG',
    symbol: '🌫️',
    nameEn: 'Fog',
    description: 'Markedly reduced visibility that hinders traffic.',
  },
  HIGH_TEMPERATURE: {
    type: 'HIGH_TEMPERATURE',
    symbol: '🌡️🔥',
    nameEn: 'High Temperature',
    description: 'Anomalous period of oppressive heat with nocturnal thermal stress.',
  },
  LOW_TEMPERATURE: {
    type: 'LOW_TEMPERATURE',
    symbol: '🥶',
    nameEn: 'Low Temperature',
    description: 'Prolonged period of significantly below-average temperatures.',
  },
  COASTAL_EVENT: {
    type: 'COASTAL_EVENT',
    symbol: '🌊⚓',
    nameEn: 'Coastal Event',
    description: 'Storm surges, rogue waves and storm winds along the coast.',
  },
  FOREST_FIRE: {
    type: 'FOREST_FIRE',
    symbol: '🔥🌲',
    nameEn: 'Forest Fire',
    description: 'Meteorological conditions with high ignition and fire propagation risk.',
  },
  AVALANCHE: {
    type: 'AVALANCHE',
    symbol: '🏔️⚠️',
    nameEn: 'Avalanche',
    description: 'Rapid sliding of snow masses on unstable slopes.',
  },
  MARINE_HAZARD: {
    type: 'MARINE_HAZARD',
    symbol: '⚓🌊',
    nameEn: 'Marine Hazard',
    description: 'Very rough or agitated sea threatening navigation.',
  },
  DROUGHT: {
    type: 'DROUGHT',
    symbol: '🏜️',
    nameEn: 'Drought',
    description: 'Prolonged water deficit impacting soil and water resources.',
  },
  OTHER: {
    type: 'OTHER',
    symbol: '⚠️',
    nameEn: 'Other Hazard',
    description: 'Generic meteorological phenomenon.',
  },
};

export interface StormAlert {
  cellId: string;
  event: string;
  severity: 'WATCH' | 'WARNING' | 'EMERGENCY';
  color: AlertColor;
  colorName: 'YELLOW' | 'ORANGE' | 'RED';
  hazardType: HazardType;
  severityRank: number; // 1 (YELLOW), 2 (ORANGE), 3 (RED) for deduplication escalation
  // GeoJSON Polygon or MultiPolygon geometry representing the storm hazard perimeter
  polygonGeoJson: {
    type: 'Polygon' | 'MultiPolygon';
    coordinates: number[][][] | number[][][][]; // GeoJSON format: Polygon rings or MultiPolygon array of rings
  };
  instruction: string;
  headline?: string;
  description?: string;
  areaDesc?: string;
  onset?: string;
  expires?: string;
}

export interface MatchedUser {
  id: number;
  userId: string;
  telegramChatId: number;
  locationName: string;
  h3Index: string;
  lon: number;
  lat: number;
}

