import { sql } from 'drizzle-orm';
import * as h3 from 'h3-js';
import { db } from '../db';
import type { StormAlert, MatchedUser } from './types';
import { alertToH3Cells } from './h3-matcher';
import { env } from '../config/env';

/**
 * Evaluates a storm alert polygon against all registered user locations in PostGIS.
 * Uses the GiST spatial index and ST_Covers for fast bounding-box filtering and exact geometric evaluation.
 */
export async function matchStormToUsers(alert: StormAlert): Promise<MatchedUser[]> {
  // Guard: Always require polygon geometry for spatial matching. No hardcoded region shortcuts.
  if (!alert.polygonGeoJson?.coordinates || alert.polygonGeoJson.coordinates.length === 0) {
    return [];
  }

  const polygonJson = JSON.stringify(alert.polygonGeoJson);
  const startTime = performance.now();

  // Execute PostGIS spatial query using Drizzle's sql template tag
  const results = await db.execute(sql`
    SELECT 
      id,
      user_id AS "userId",
      telegram_chat_id AS "telegramChatId",
      location_name AS "locationName",
      h3_index AS "h3Index",
      ST_X(location::geometry) AS lon,
      ST_Y(location::geometry) AS lat
    FROM user_alert_zones
    WHERE ST_Covers(
      ST_GeomFromGeoJSON(${polygonJson}),
      location::geometry
    );
  `);

  const elapsedMs = (performance.now() - startTime).toFixed(2);
  const matchedUsers = results as unknown as MatchedUser[];

  // Educational H3 analysis: calculate which H3 cells are covered by the storm polygon
  try {
    const stormH3Cells = alertToH3Cells(alert);
    const avgHexAreaKm2 = h3.getHexagonAreaAvg(env.H3_RESOLUTION, 'km2'); // Used for estimation only
    const totalHazardAreaKm2 = (stormH3Cells.length * avgHexAreaKm2).toFixed(1);

    console.log(
      `⚡ [Spatial Matcher] PostGIS ST_Covers matched ${matchedUsers.length} user(s) in ${elapsedMs}ms.`
    );
    console.log(
      `⬡ [H3 Analysis] Storm polygon covers ${stormH3Cells.length} H3 hexagons (~${totalHazardAreaKm2} km² total hazard area).`
    );
  } catch (err) {
    // If polygon coordinates are inverted or malformed for H3, fall back gracefully
    console.log(`⚡ [Spatial Matcher] PostGIS ST_Covers matched ${matchedUsers.length} user(s) in ${elapsedMs}ms.`);
  }

  return matchedUsers;
}
