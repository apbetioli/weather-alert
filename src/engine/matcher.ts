import { sql } from 'drizzle-orm';
import * as h3 from 'h3-js';
import { db } from '../db';
import type { StormAlert, MatchedUser } from './types';

/**
 * Evaluates a storm alert polygon against all registered user locations in PostGIS.
 * Uses the GiST spatial index and ST_Covers for fast bounding-box filtering and exact geometric evaluation.
 */
export async function matchStormToUsers(alert: StormAlert): Promise<MatchedUser[]> {
  const polygonJson = JSON.stringify(alert.polygonGeoJson);
  const startTime = performance.now();

  // Execute PostGIS spatial query using Drizzle's sql template tag
  const results = await db.execute(sql`
    SELECT 
      id,
      user_id AS "userId",
      telegram_chat_id AS "telegramChatId",
      location_name AS "locationName",
      h3_res7 AS "h3Res7",
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

  // Educational H3 analysis: calculate which H3 resolution 7 cells are covered by the storm polygon
  try {
    const stormH3Cells = h3.polygonToCells(alert.polygonGeoJson.coordinates, 7);
    const avgHexAreaKm2 = h3.getHexagonAreaAvg(7, 'km2'); // ~5.16 km² per Res-7 hexagon
    const totalHazardAreaKm2 = (stormH3Cells.length * avgHexAreaKm2).toFixed(1);

    console.log(
      `⚡ [Spatial Matcher] PostGIS ST_Covers matched ${matchedUsers.length} user(s) in ${elapsedMs}ms.`
    );
    console.log(
      `⬡ [H3 Analysis] Storm polygon covers ${stormH3Cells.length} H3 Res-7 hexagons (~${totalHazardAreaKm2} km² total hazard area).`
    );
  } catch (err) {
    // If polygon coordinates are inverted or malformed for H3, fall back gracefully
    console.log(`⚡ [Spatial Matcher] PostGIS ST_Covers matched ${matchedUsers.length} user(s) in ${elapsedMs}ms.`);
  }

  return matchedUsers;
}
