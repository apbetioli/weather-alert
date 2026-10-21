import * as hdf5 from 'jsfive';
import proj4 from 'proj4';
import { MIN_TRACK_REFLECTIVITY_DBZ, processRadarCells, trackRadarCells, type StormCell } from './tracking';
import { env } from '../config/env';
import { alertDispatchQueue } from '../queue';
import { evaluateAlertDeduplication } from '../redis/deduplicator';

let activeRadarPoll: Promise<StormCell[]> | undefined;
let previousScan: { timestamp: number; cells: StormCell[] } | undefined;

export function fetchLiveRadarCells(): Promise<StormCell[]> {
  if (activeRadarPoll) return activeRadarPoll;
  activeRadarPoll = runLiveRadarPoll().finally(() => {
    activeRadarPoll = undefined;
  });
  return activeRadarPoll;
}

async function runLiveRadarPoll(): Promise<StormCell[]> {
  console.log('📡 [Radar Ingestion] Fetching live ODIM radar composite from MeteoGate...');

  const apiKey = env.METEOGATE_API_KEY;
  if (!apiKey) throw new Error('No API key provided for Radar API');

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20000);

  let cells: StormCell[] = [];
  let scanTimestamp: number | undefined;

  try {
    // 1. Fetch ODIM composite metadata from MeteoGate
    const metaResponse = await fetch(
      'https://api.meteogate.eu/eu-eumetnet-weather-radar/collections/observations/locations/0-20010-0-OPERA?parameter-name=DBZH:comp&level=0.0&format=ODIM',
      {
        headers: {
          apikey: apiKey,
          Accept: 'application/json',
        },
        signal: controller.signal,
      }
    );

    if (!metaResponse.ok) {
      throw new Error(`Failed to fetch ODIM metadata: HTTP ${metaResponse.status}`);
    }

    const metaData = (await metaResponse.json()) as any;
    const links = (metaData.links || []) as Array<{ href: string; rel?: string }>;
    const h5Links = links.filter((l) => l.href && l.href.endsWith('.h5'));

    if (h5Links.length === 0) {
      throw new Error('No ODIM .h5 files found in MeteoGate response');
    }

    // Latest scan is the last item
    const latestLink = h5Links[h5Links.length - 1];
    if (!latestLink || !latestLink.href) {
      throw new Error('Invalid latest ODIM scan link in MeteoGate response');
    }

    console.log(`📡 [Radar Ingestion] Downloading latest ODIM scan: ${latestLink.href}`);

    // 2. Fetch the .h5 binary file
    const fileResponse = await fetch(latestLink.href, { signal: controller.signal });
    if (!fileResponse.ok) {
      throw new Error(`Failed to download ODIM .h5 file: HTTP ${fileResponse.status}`);
    }

    const arrayBuffer = await fileResponse.arrayBuffer();
    clearTimeout(timeoutId);

    // 3. Parse HDF5 container in-memory via jsfive
    const h5File = new hdf5.File(arrayBuffer, 'OPERA.h5');
    const productAttrs = h5File.get('what')?.attrs || {};
    scanTimestamp = parseOdimTimestamp(productAttrs.date, productAttrs.time) ?? undefined;
    if (scanTimestamp === undefined) throw new Error('Missing or invalid ODIM scan date/time');
    if (scanTimestamp < Date.now() - 20 * 60 * 1000 || scanTimestamp > Date.now() + 2 * 60 * 1000) {
      throw new Error('ODIM scan timestamp is stale or unexpectedly in the future');
    }

    const whereAttrs = h5File.get('where')?.attrs || {};
    const rawProjDef = (whereAttrs.projdef || '').replace(/\0/g, '').trim();

    if (!rawProjDef) {
      throw new Error('Missing projection definition in ODIM file');
    }

    const rawData = h5File.get('dataset1/data1/data');
    if (!rawData || !rawData.value) {
      throw new Error('Missing reflectivity data array in ODIM file');
    }

    const dataAttrs = h5File.get('dataset1/data1/what')?.attrs || {};
    const gain = Number(dataAttrs.gain);
    const offset = Number(dataAttrs.offset);
    const nodata = Number(dataAttrs.nodata);
    const undetect = Number(dataAttrs.undetect);
    if (![gain, offset, nodata, undetect].every(Number.isFinite)) {
      throw new Error('Missing or invalid ODIM reflectivity gain, offset, nodata, or undetect metadata');
    }

    const values = rawData.value as Float64Array;
    const width = Number(whereAttrs.xsize);
    const height = Number(whereAttrs.ysize);
    const xScale = Number(whereAttrs.xscale);
    const yScale = Number(whereAttrs.yscale);
    const lowerLeftLon = Number(whereAttrs.LL_lon);
    const lowerLeftLat = Number(whereAttrs.LL_lat);

    if (![width, height, xScale, yScale, lowerLeftLon, lowerLeftLat].every(Number.isFinite)
      || width <= 0 || height <= 0 || xScale <= 0 || yScale <= 0) {
      throw new Error('Missing or invalid ODIM grid dimensions, pixel scale, or lower-left coordinates');
    }

    console.log(`📡 [Radar Ingestion] Parsing grid ${width}x${height} using LAEA projection...`);

    // 4. Group connected high-reflectivity pixels into echo objects. Connected
    // components avoid fixed-bin centroid jumps when an echo crosses a bin edge.
    interface GridCluster {
      maxDbz: number;
      sumR: number;
      sumC: number;
      count: number;
    }
    const echoPixels = new Map<number, number>();

    for (let r = 0; r < height; r += 2) {
      const rowOffset = r * width;
      for (let c = 0; c < width; c += 2) {
        const rawValue = values[rowOffset + c];
        if (typeof rawValue === 'number' && rawValue !== nodata && rawValue !== undetect) {
          const val = rawValue * gain + offset;
          if (val < MIN_TRACK_REFLECTIVITY_DBZ || val > 85) continue;
          echoPixels.set(r * width + c, val);
        }
      }
    }

    // ODIM LL_lon/LL_lat identify the lower-left pixel corner. Pixel scales and
    // dimensions provide the projected grid origin and pixel centers.
    const toProjection = proj4('WGS84', rawProjDef);
    const [originX, originY] = toProjection.forward([lowerLeftLon, lowerLeftLat]);

    // 5. Convert cluster centroids from projection coordinates to WGS84.
    const converter = proj4(rawProjDef, 'WGS84');

    const visited = new Set<number>();
    let clusterNumber = 0;
    for (const [pixelIndex, dbz] of echoPixels) {
      if (visited.has(pixelIndex)) continue;
      const queue = [pixelIndex];
      visited.add(pixelIndex);
      const cluster: GridCluster = { maxDbz: dbz, sumR: 0, sumC: 0, count: 0 };

      for (let queueIndex = 0; queueIndex < queue.length; queueIndex++) {
        const currentIndex = queue[queueIndex]!;
        const row = Math.floor(currentIndex / width);
        const col = currentIndex % width;
        cluster.maxDbz = Math.max(cluster.maxDbz, echoPixels.get(currentIndex)!);
        cluster.sumR += row;
        cluster.sumC += col;
        cluster.count++;
        for (const rowOffset of [-2, 0, 2]) {
          for (const colOffset of [-2, 0, 2]) {
            if (rowOffset === 0 && colOffset === 0) continue;
            const neighborRow = row + rowOffset;
            const neighborCol = col + colOffset;
            if (neighborRow < 0 || neighborRow >= height || neighborCol < 0 || neighborCol >= width) continue;
            const neighborIndex = neighborRow * width + neighborCol;
            if (echoPixels.has(neighborIndex) && !visited.has(neighborIndex)) {
              visited.add(neighborIndex);
              queue.push(neighborIndex);
            }
          }
        }
      }

      const avgRow = cluster.sumR / cluster.count;
      const avgCol = cluster.sumC / cluster.count;

      // Image rows start at the top; projected Y increases northward.
      const projX = originX + (avgCol + 0.5) * xScale;
      const projY = originY + (height - avgRow - 0.5) * yScale;
      const [lon, lat] = converter.forward([projX, projY]);

      if ([lat, lon].every(Number.isFinite)) {
        cells.push({
          id: `radar-${scanTimestamp}-${clusterNumber++}`,
          centroidLat: lat,
          centroidLon: lon,
          maxDbz: Math.round(cluster.maxDbz * 10) / 10,
        });
      }
    }

    console.log(`📥 [Radar Ingestion] Extracted ${cells.length} high-reflectivity echo clusters across Europe.`);
  } catch (err: any) {
    clearTimeout(timeoutId);
    console.error(`❌ [Radar Ingestion] Live ODIM fetch failed: ${err.message}`);
    throw err;
  }

  if (scanTimestamp === undefined) return cells;
  if (previousScan?.timestamp === scanTimestamp) {
    console.log('[Radar Ingestion] Latest scan was already processed.');
    return cells;
  }

  const currentCells = previousScan
    ? trackRadarCells(previousScan.cells, previousScan.timestamp, cells, scanTimestamp)
    : cells;
  previousScan = { timestamp: scanTimestamp, cells: currentCells.map((cell) => ({ ...cell })) };

  if (!currentCells.some((cell) => cell.speedKmh !== undefined)) {
    console.log('[Radar Ingestion] Stored scan as tracking baseline; no reliable motion estimates yet.');
    return currentCells;
  }

  const alerts = await processRadarCells(currentCells);
  for (const alert of alerts) {
    const cellId = alert.stormCellId;
    const expiresAt = new Date(Date.now() + Math.max(15, alert.etaMinutes + 10) * 60_000).toISOString();
    const dedup = await evaluateAlertDeduplication(alert.telegramChatId, cellId, 1, undefined, expiresAt);
    if (!dedup.shouldSend) continue;

    await alertDispatchQueue.add('dispatch-alert', {
      radar: {
        stormCellId: alert.stormCellId,
        etaMinutes: alert.etaMinutes,
        speedKmh: alert.speedKmh,
        headingDeg: alert.headingDeg,
        maxDbz: alert.maxDbz,
      },
      user: {
        id: 0,
        userId: alert.userId,
        telegramChatId: alert.telegramChatId,
        locationName: alert.locationName,
        h3Index: alert.h3Index,
        lat: alert.lat,
        lon: alert.lon,
      },
      reason: dedup.reason,
      dedupTimestamp: dedup.timestamp,
    }, { priority: 3 });
  }

  return currentCells;
}

function parseOdimTimestamp(dateValue: unknown, timeValue: unknown): number | null {
  const date = String(dateValue ?? '').replace(/\0/g, '').trim();
  const time = String(timeValue ?? '').replace(/\0/g, '').trim();
  if (!/^\d{8}$/.test(date) || !/^\d{6}$/.test(time)) return null;
  const timestamp = Date.parse(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}Z`);
  return Number.isFinite(timestamp) ? timestamp : null;
}
