import { cellToParent, gridDisk } from 'h3-js';
import { db } from '../db';
import { sql } from 'drizzle-orm';
import { env } from '../config/env';
import { redis } from '../redis/client';

export interface StormCell {
  id: string;
  centroidLat: number;
  centroidLon: number;
  maxDbz: number;
  speedKmh?: number;
  headingDeg?: number;
}

const EARTH_RADIUS_KM = 6371;
export const MIN_TRACK_REFLECTIVITY_DBZ = 40;
const MAX_TRACK_SPEED_KMH = 150;
const MIN_TRACK_DISTANCE_KM = 1;
const MIN_SCAN_GAP_MS = 2 * 60 * 1000;
const MAX_SCAN_GAP_MS = 20 * 60 * 1000;

function distanceAndBearing(from: StormCell, to: StormCell) {
  const meanLat = ((from.centroidLat + to.centroidLat) / 2) * Math.PI / 180;
  const deltaLat = (to.centroidLat - from.centroidLat) * Math.PI / 180;
  const deltaLonDegrees = ((to.centroidLon - from.centroidLon + 540) % 360) - 180;
  const deltaLon = deltaLonDegrees * Math.PI / 180;
  const eastKm = EARTH_RADIUS_KM * Math.cos(meanLat) * deltaLon;
  const northKm = EARTH_RADIUS_KM * deltaLat;
  const distanceKm = Math.hypot(eastKm, northKm);
  const headingDeg = (Math.atan2(eastKm, northKm) * 180 / Math.PI + 360) % 360;
  return { distanceKm, headingDeg };
}

/** Match cells between consecutive scans and derive motion only from measured displacement. */
export function trackRadarCells(
  previousCells: StormCell[],
  previousTimestamp: number,
  currentCells: StormCell[],
  currentTimestamp: number
): StormCell[] {
  const elapsedMs = currentTimestamp - previousTimestamp;
  if (elapsedMs < MIN_SCAN_GAP_MS || elapsedMs > MAX_SCAN_GAP_MS) return currentCells;

  const elapsedHours = elapsedMs / 3_600_000;
  const maxDistanceKm = MAX_TRACK_SPEED_KMH * elapsedHours + 3;
  const candidates: Array<{ previousIndex: number; currentIndex: number; distanceKm: number; headingDeg: number }> = [];

  previousCells.forEach((previous, previousIndex) => {
    currentCells.forEach((current, currentIndex) => {
      const { distanceKm, headingDeg } = distanceAndBearing(previous, current);
      if (distanceKm <= maxDistanceKm) {
        candidates.push({ previousIndex, currentIndex, distanceKm, headingDeg });
      }
    });
  });
  candidates.sort((a, b) => a.distanceKm - b.distanceKm);

  const usedPrevious = new Set<number>();
  const usedCurrent = new Set<number>();
  for (const candidate of candidates) {
    if (usedPrevious.has(candidate.previousIndex) || usedCurrent.has(candidate.currentIndex)) continue;
    usedPrevious.add(candidate.previousIndex);
    usedCurrent.add(candidate.currentIndex);

    const previous = previousCells[candidate.previousIndex]!;
    const current = currentCells[candidate.currentIndex]!;
    current.id = previous.id;

    if (candidate.distanceKm < MIN_TRACK_DISTANCE_KM) continue;
    const speedKmh = candidate.distanceKm / elapsedHours;
    if (speedKmh <= MAX_TRACK_SPEED_KMH) {
      current.speedKmh = speedKmh;
      current.headingDeg = candidate.headingDeg;
    }
  }

  return currentCells;
}

export interface UserEtaAlert {
  stormCellId: string;
  userId: string;
  telegramChatId: number;
  locationName: string;
  h3Index: string;
  lat: number;
  lon: number;
  etaMinutes: number;
  speedKmh: number;
  headingDeg: number;
}

/**
 * Estimates closest-approach time from the storm's motion vector. Returns null
 * when the storm is moving away from the user or its projected path misses them.
 */
function calculateETA(
  cell: StormCell,
  targetLat: number,
  targetLon: number
): number | null {
  if (!cell.speedKmh || cell.speedKmh < 1 || cell.headingDeg === undefined) return null;

  const earthRadiusKm = EARTH_RADIUS_KM;
  const meanLat = ((targetLat + cell.centroidLat) / 2) * Math.PI / 180;
  const deltaLat = (targetLat - cell.centroidLat) * Math.PI / 180;
  const deltaLonDegrees = ((targetLon - cell.centroidLon + 540) % 360) - 180;
  const deltaLon = deltaLonDegrees * Math.PI / 180;
  const eastKm = earthRadiusKm * Math.cos(meanLat) * deltaLon;
  const northKm = earthRadiusKm * deltaLat;

  // headingDeg is a compass bearing: 0° north, 90° east.
  const heading = cell.headingDeg * Math.PI / 180;
  const velocityEast = Math.sin(heading);
  const velocityNorth = Math.cos(heading);
  const alongTrackKm = eastKm * velocityEast + northKm * velocityNorth;
  const crossTrackKm = Math.abs(eastKm * velocityNorth - northKm * velocityEast);

  // Approximate the storm footprint around its centroid with a 15 km corridor.
  if (alongTrackKm <= 0 || crossTrackKm > 15) return null;

  const etaMinutes = Math.round((alongTrackKm / cell.speedKmh) * 60);

  return etaMinutes;
}

/**
 * Processes live radar cells and matches them against user zones.
 */
export async function processRadarCells(cells: StormCell[]): Promise<UserEtaAlert[]> {
  // Keep sufficiently strong echoes as tracking candidates; this is not a severity classification.
  const trackedCells = cells.filter(c => c.maxDbz >= MIN_TRACK_REFLECTIVITY_DBZ);
  if (trackedCells.length === 0) return [];

  // 2. Fetch all user alert zones
  const usersRes = await db.execute(sql`
    SELECT user_id, telegram_chat_id, location_name, h3_index, ST_Y(location::geometry) as lat, ST_X(location::geometry) as lon 
    FROM user_alert_zones
  `);

  const alerts: UserEtaAlert[] = [];

  for (const user of usersRes as any[]) {
    const userLat = Number(user.lat);
    const userLon = Number(user.lon);
    
    // For each tracked cell, if it's threatening this user, calculate ETA
    for (const cell of trackedCells) {
      const eta = calculateETA(cell, userLat, userLon);
      
      // If storm arrives within next 60 minutes
      if (eta !== null && eta <= 60 && eta > 0) {
        alerts.push({
          stormCellId: cell.id,
          userId: String(user.user_id),
          telegramChatId: Number(user.telegram_chat_id),
          locationName: user.location_name || 'Monitored Zone',
          h3Index: String(user.h3_index),
          lat: userLat,
          lon: userLon,
          etaMinutes: eta,
          speedKmh: cell.speedKmh!,
          headingDeg: cell.headingDeg!,
        });
      }
    }
  }

  return alerts;
}
