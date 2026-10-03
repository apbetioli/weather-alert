export interface StormAlert {
  cellId: string;
  event: string;
  severity: 'WATCH' | 'WARNING' | 'EMERGENCY';
  hailSizeCm: number;
  hailDescription: string;
  maxDbz: number;
  speedKmh: number;
  direction: string;
  etaMinutes: number;
  // GeoJSON Polygon geometry representing the storm hazard perimeter
  polygonGeoJson: {
    type: 'Polygon';
    coordinates: number[][][]; // GeoJSON format: [ [ [lon, lat], [lon, lat], ... ] ]
  };
  instruction: string;
}

export interface MatchedUser {
  id: number;
  userId: string;
  telegramChatId: number;
  locationName: string;
  h3Res7: string;
  lon: number;
  lat: number;
}
