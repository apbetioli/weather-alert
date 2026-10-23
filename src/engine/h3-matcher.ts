import { sql } from 'drizzle-orm';
import * as h3 from 'h3-js';
import { db, queryClient } from '../db';
import type { StormAlert, MatchedUser } from './types';
import { matchStormToUsers } from './matcher';
import { env } from '../config/env';

export interface BenchmarkResult {
  postgisElapsedMs: number;
  h3ElapsedMs: number;
  h3HexificationMs: number;
  h3QueryMs: number;
  postgisMatches: number;
  h3Matches: number;
  h3CellCount: number;
  speedupFactor: number;
}

/** Refresh persisted indexes after an H3 resolution change or deployment. */
export async function refreshUserH3Indexes(): Promise<void> {
  const rows = await db.execute(sql`
    SELECT id, h3_index AS "h3Index", ST_X(location::geometry) AS lon,
      ST_Y(location::geometry) AS lat
    FROM user_alert_zones
  `) as unknown as Array<{ id: number; h3Index: string; lon: number; lat: number }>;

  let refreshed = 0;
  for (const row of rows) {
    const expectedIndex = h3.latLngToCell(Number(row.lat), Number(row.lon), env.H3_RESOLUTION);
    if (row.h3Index === expectedIndex) continue;
    await db.execute(sql`UPDATE user_alert_zones SET h3_index = ${expectedIndex} WHERE id = ${row.id}`);
    refreshed++;
  }
  if (refreshed > 0) {
    console.log(`⬡ [H3 Matcher] Refreshed ${refreshed} user index(es) for resolution ${env.H3_RESOLUTION}.`);
  }
}

/**
 * Converts a StormAlert's Polygon or MultiPolygon geometry into a deduplicated list of H3 cells.
 */
export function alertToH3Cells(alert: StormAlert, resolution: number = env.H3_RESOLUTION): string[] {
  if (!alert.polygonGeoJson?.coordinates || alert.polygonGeoJson.coordinates.length === 0) {
    return [];
  }

  try {
    if (alert.polygonGeoJson.type === 'MultiPolygon') {
      const allCells = new Set<string>();
      const multiCoords = alert.polygonGeoJson.coordinates as number[][][][];
      for (const poly of multiCoords) {
        try {
          const cells = h3.polygonToCellsExperimental(
            poly,
            resolution,
            h3.POLYGON_TO_CELLS_FLAGS.containmentOverlapping,
            true
          );
          for (const c of cells) allCells.add(c);
        } catch {
          // continue with remaining polygons
        }
      }
      return Array.from(allCells);
    } else {
      return h3.polygonToCellsExperimental(
        alert.polygonGeoJson.coordinates as number[][][],
        resolution,
        h3.POLYGON_TO_CELLS_FLAGS.containmentOverlapping,
        true
      );
    }
  } catch (err) {
    console.warn('⚠️ [H3 Matcher] Failed to convert polygon to H3 cells:', err);
    return [];
  }
}

/**
 * Inverted H3 Index Matcher:
 * Resolves all registered users located inside the storm hazard polygon.
 *
 * To achieve 100% spatial parity with PostGIS, we use a two-step approach (Coarse-to-Fine):
 * 1. Coarse Filter: Convert the polygon into H3 cells and buffer them by 1 ring (gridDisk)
 *    to ensure we cover all boundary edge cases. We query these via the B-Tree index.
 * 2. Fine Filter: Perform the exact ST_Covers point-in-polygon math ONLY on the users
 *    found in those matching H3 cells.
 */
export async function matchStormUsingH3(alert: StormAlert): Promise<MatchedUser[]> {
  const startTime = performance.now();

  let impactedCells = alertToH3Cells(alert, env.H3_RESOLUTION);
  if (!impactedCells || impactedCells.length === 0) {
    return [];
  }

  // Buffer by 1 ring to ensure we don't miss users on the edges of the polygon
  const bufferedCells = new Set<string>();
  for (const cell of impactedCells) {
    const disk = h3.gridDisk(cell, 1);
    for (const d of disk) bufferedCells.add(d);
  }
  impactedCells = Array.from(bufferedCells);

  const polygonJson = JSON.stringify(alert.polygonGeoJson);

  // postgres.js natively serializes a JS array as a Postgres array (text[]) when
  // passed via the tagged-template literal, avoiding the 1664-entry ROW expression limit.
  const results = await queryClient`
    SELECT 
      id,
      user_id AS "userId",
      telegram_chat_id AS "telegramChatId",
      location_name AS "locationName",
      h3_index AS "h3Index",
      ST_X(location::geometry) AS lon,
      ST_Y(location::geometry) AS lat
    FROM user_alert_zones
    WHERE h3_index = ANY(${impactedCells})
    AND ST_Covers(
      ST_SetSRID(ST_GeomFromGeoJSON(${polygonJson}), 4326),
      location::geometry
    )
  `;

  const elapsedMs = (performance.now() - startTime).toFixed(2);
  const matchedUsers = results as unknown as MatchedUser[];

  console.log(
    `⬡ [Inverted H3 Matcher] Scanned ${impactedCells.length} H3 Res-${env.H3_RESOLUTION} cells -> matched ${matchedUsers.length} user(s) in ${elapsedMs}ms.`
  );

  return matchedUsers;
}

/**
 * Compares PostGIS ST_Covers vs Inverted H3 B-Tree matching side-by-side.
 */
export async function benchmarkH3VsPostgis(alert: StormAlert): Promise<BenchmarkResult> {
  // 1. Benchmark PostGIS ST_Covers
  const t0 = performance.now();
  const postgisResults = await matchStormToUsers(alert);
  const postgisElapsedMs = Number((performance.now() - t0).toFixed(2));

  // 2. Benchmark H3 Inverted Matching
  const t1 = performance.now();
  const hexStart = performance.now();
  let impactedCells = alertToH3Cells(alert, env.H3_RESOLUTION);
  
  const bufferedCells = new Set<string>();
  for (const cell of impactedCells) {
    const disk = h3.gridDisk(cell, 1);
    for (const d of disk) bufferedCells.add(d);
  }
  impactedCells = Array.from(bufferedCells);
  const polygonJson = JSON.stringify(alert.polygonGeoJson);

  const h3HexificationMs = Number((performance.now() - hexStart).toFixed(2));

  let h3Results: MatchedUser[] = [];
  let h3QueryMs = 0;

  if (impactedCells.length > 0) {
    const qStart = performance.now();
    // postgres.js natively serializes a JS array as a Postgres array (text[]) when
    // passed via the tagged-template literal, avoiding the 1664-entry ROW expression limit.
    const results = await queryClient`
      SELECT 
        id,
        user_id AS "userId",
        telegram_chat_id AS "telegramChatId",
        location_name AS "locationName",
        h3_index AS "h3Index",
        ST_X(location::geometry) AS lon,
        ST_Y(location::geometry) AS lat
      FROM user_alert_zones
      WHERE h3_index = ANY(${impactedCells})
      AND ST_Covers(
        ST_SetSRID(ST_GeomFromGeoJSON(${polygonJson}), 4326),
        location::geometry
      )
    `;
    h3QueryMs = Number((performance.now() - qStart).toFixed(2));
    h3Results = results as unknown as MatchedUser[];
  }
  const h3ElapsedMs = Number((performance.now() - t1).toFixed(2));

  const speedupFactor =
    h3ElapsedMs > 0 ? Number((postgisElapsedMs / h3ElapsedMs).toFixed(2)) : 1;

  console.log('\n📊 --- Spatial Matching Engine Benchmark ---');
  console.log(`• PostGIS ST_Covers:  ${postgisElapsedMs}ms (${postgisResults.length} matches)`);
  console.log(
    `• Inverted H3 Match:  ${h3ElapsedMs}ms (${h3Results.length} matches across ${impactedCells.length} cells)`
  );
  console.log(`  - Hexification:     ${h3HexificationMs}ms`);
  console.log(`  - B-Tree Index:     ${h3QueryMs}ms`);
  console.log(`• Speedup Ratio:      ${speedupFactor}x`);
  console.log('-------------------------------------------\n');

  return {
    postgisElapsedMs,
    h3ElapsedMs,
    h3HexificationMs,
    h3QueryMs,
    postgisMatches: postgisResults.length,
    h3Matches: h3Results.length,
    h3CellCount: impactedCells.length,
    speedupFactor,
  };
}
