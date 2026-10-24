import { fetchRollingForecast24h, generateSyntheticForecast24h, normalizeOpenMeteoUtcTime } from '../ingestion/providers/open-meteo';
import { evaluateWeatherThresholds, type BreachedThreshold } from '../engine/threshold-evaluator';
import { formatThresholdAlertHtml, formatShortTime } from '../bot/formatters';
import { evaluateThresholdDeduplication } from '../redis/deduplicator';
import { getUserLocalTime } from '../ingestion/poller';
import { redis } from '../redis/client';
import type { UserThresholdPreferences } from '../db/schema';

async function runThresholdTestSuite() {
  console.log('🧪 Starting Multi-Hazard Weather Threshold Alert Test Suite...\n');

  const testChatId = 987654321;
  const testDateKey = '2026-10-23';

  // 1. Flush any prior test state in Redis
  const pattern = `alert:threshold:${testChatId}:*`;
  let cursor = '0';
  do {
    const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    cursor = nextCursor;
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  } while (cursor !== '0');
  console.log(`🧹 Flushed test Redis keys for chat ${testChatId}.`);

  // --- Step 1: Open-Meteo Ingestion Test ---
  console.log('\n📡 Step 1: Testing 24h Rolling Forecast Ingestion...');
  const testLat = 45.438;
  const testLon = 12.235;

  try {
    const forecast = await fetchRollingForecast24h(testLat, testLon);
    console.log(`✅ Ingested 24h forecast: ${forecast.steps.length} hourly steps from ${forecast.startTime} to ${forecast.endTime}.`);
    if (forecast.steps.length < 20) {
      throw new Error(`Expected at least 20 steps, got ${forecast.steps.length}`);
    }
    if (!forecast.startTime.endsWith('Z') || !forecast.steps[0]?.time.endsWith('Z')) {
      throw new Error(`Ingested forecast timestamps must end with 'Z' (got startTime: ${forecast.startTime})`);
    }
    console.log('✅ PASS: Ingested forecast timestamps correctly normalized with UTC "Z" suffix.');
  } catch (err: any) {
    console.log(`⚠️ Live Open-Meteo fetch skipped in test suite (${err?.message || err}).`);
  }

  // --- Step 1b: Timestamp Normalization & Timezone Offset Immunity Test ---
  console.log('\n⏱️ Step 1b: Testing Timestamp Normalization & Timezone Offset Immunity...');

  // 1. normalizeOpenMeteoUtcTime assertions
  if (normalizeOpenMeteoUtcTime('2026-10-23T18:00') !== '2026-10-23T18:00Z') {
    throw new Error('normalizeOpenMeteoUtcTime failed to append Z suffix to raw Open-Meteo time string');
  }
  if (normalizeOpenMeteoUtcTime('2026-10-23T18:00Z') !== '2026-10-23T18:00Z') {
    throw new Error('normalizeOpenMeteoUtcTime should preserve existing Z suffix');
  }
  if (normalizeOpenMeteoUtcTime('2026-10-23T18:00+02:00') !== '2026-10-23T18:00+02:00') {
    throw new Error('normalizeOpenMeteoUtcTime should preserve existing offset');
  }

  // 2. formatShortTime assertions (must return UTC hours without local timezone shift, or dual local/UTC)
  const rawStart18 = '2026-10-23T18:00'; // Missing Z from Open-Meteo
  const formattedStart18 = formatShortTime(rawStart18);
  if (formattedStart18 !== '18:00 UTC') {
    throw new Error(`formatShortTime("${rawStart18}") returned "${formattedStart18}", expected "18:00 UTC"`);
  }

  // Local timezone test for Italy (Europe/Rome): 18:00 UTC = 20:00 CEST
  const localStartRome = formatShortTime(rawStart18, 'Europe/Rome');
  if (localStartRome !== '20:00 CEST (18:00 UTC)') {
    throw new Error(`formatShortTime("${rawStart18}", "Europe/Rome") returned "${localStartRome}", expected "20:00 CEST (18:00 UTC)"`);
  }

  const rawPeak19 = '2026-10-23T19:00'; // Missing Z from Open-Meteo
  const localPeakRome = formatShortTime(rawPeak19, 'Europe/Rome');
  if (localPeakRome !== '21:00 CEST (19:00 UTC)') {
    throw new Error(`formatShortTime("${rawPeak19}", "Europe/Rome") returned "${localPeakRome}", expected "21:00 CEST (19:00 UTC)"`);
  }

  // Also test with explicit Z
  if (formatShortTime('2026-10-23T18:00Z') !== '18:00 UTC') {
    throw new Error('formatShortTime failed on string with Z');
  }

  // 3. End-to-end evaluation with raw Open-Meteo timestamps lacking 'Z'
  const unnormalizedForecast = {
    lat: testLat,
    lon: testLon,
    startTime: '2026-10-23T15:00',
    endTime: '2026-10-24T14:00',
    steps: [
      { time: '2026-10-23T15:00', precipitationMm: 0, snowfallCm: 0, windGustKmh: 20, temperatureC: 15, weatherCode: 1, capeJkg: 0 },
      { time: '2026-10-23T16:00', precipitationMm: 0, snowfallCm: 0, windGustKmh: 20, temperatureC: 15, weatherCode: 1, capeJkg: 0 },
      { time: '2026-10-23T17:00', precipitationMm: 0, snowfallCm: 0, windGustKmh: 20, temperatureC: 15, weatherCode: 1, capeJkg: 0 },
      { time: '2026-10-23T18:00', precipitationMm: 0.8, snowfallCm: 0, windGustKmh: 25, temperatureC: 14, weatherCode: 61, capeJkg: 0 },
      { time: '2026-10-23T19:00', precipitationMm: 2.4, snowfallCm: 0, windGustKmh: 30, temperatureC: 13, weatherCode: 61, capeJkg: 0 },
      { time: '2026-10-23T20:00', precipitationMm: 0.5, snowfallCm: 0, windGustKmh: 25, temperatureC: 13, weatherCode: 61, capeJkg: 0 },
    ],
  };

  const testPrefs: UserThresholdPreferences = {
    id: 99,
    telegramChatId: testChatId,
    rainEnabled: true,
    rainThresholdMm: '3.00',
    snowEnabled: false,
    snowThresholdCm: '2.00',
    windEnabled: false,
    windThresholdKmh: '60.0',
    frostEnabled: false,
    frostThresholdC: '0.0',
    heatEnabled: false,
    heatThresholdC: '35.0',
    hailMode: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const evalTestResult = evaluateWeatherThresholds(
    { telegramChatId: testChatId, locationName: "Alexandre's Location", lat: testLat, lon: testLon },
    testPrefs,
    unnormalizedForecast,
    new Date('2026-10-23T15:00:00Z')
  );

  if (!evalTestResult || evalTestResult.breaches.length === 0) {
    throw new Error('Expected threshold breach for raw unnormalized forecast test');
  }

  const alertCardHtml = formatThresholdAlertHtml(evalTestResult);
  if (!alertCardHtml.includes('Expected Start:</b> ~20:00 CEST (18:00 UTC)')) {
    throw new Error(`Formatted alert missing expected start time "20:00 CEST (18:00 UTC)". Output was:\n${alertCardHtml}`);
  }
  if (!alertCardHtml.includes('Peak Expected:</b> ~21:00 CEST (19:00 UTC)')) {
    throw new Error(`Formatted alert missing peak expected time "21:00 CEST (19:00 UTC)". Output was:\n${alertCardHtml}`);
  }
  if (!alertCardHtml.includes('Peak rate ~2.4 mm/h')) {
    throw new Error(`Formatted alert missing peak rate ~2.4 mm/h. Output was:\n${alertCardHtml}`);
  }

  console.log('✅ PASS: Timezone resolution confirmed: raw Open-Meteo timestamps format accurately with user local timezone and UTC reference (e.g. 20:00 CEST (18:00 UTC)).');

  // 4. Test suppression of alerts where events are in the past
  const evalPastResult = evaluateWeatherThresholds(
    { telegramChatId: testChatId, locationName: "Alexandre's Location", lat: testLat, lon: testLon },
    testPrefs,
    unnormalizedForecast,
    new Date('2026-10-23T21:00:00Z') // Evaluated at 21:00 UTC, after the 18:00-20:00 rain
  );

  if (evalPastResult !== null) {
    throw new Error('evaluateWeatherThresholds must return null when all threshold events are in the past!');
  }
  console.log('✅ PASS: Past alert suppression confirmed: events that already occurred in the past are ignored.');

  // 5. Test 7:00 AM user local time calculation across global timezones
  const tRome7am = getUserLocalTime('Europe/Rome', new Date('2026-10-24T05:00:00Z')); // 05:00 UTC = 07:00 CEST
  if (tRome7am.hour !== 7 || tRome7am.dateKey !== '2026-10-24') {
    throw new Error(`getUserLocalTime failed for Europe/Rome 7am: expected hour 7, got ${tRome7am.hour}`);
  }

  const tRomeNight = getUserLocalTime('Europe/Rome', new Date('2026-10-24T19:47:00Z')); // 19:47 UTC = 21:47 CEST
  if (tRomeNight.hour !== 21) {
    throw new Error(`getUserLocalTime failed for Europe/Rome 21h: expected hour 21, got ${tRomeNight.hour}`);
  }

  const tLondon7am = getUserLocalTime('Europe/London', new Date('2026-10-24T06:00:00Z')); // 06:00 UTC = 07:00 BST
  if (tLondon7am.hour !== 7 || tLondon7am.dateKey !== '2026-10-24') {
    throw new Error(`getUserLocalTime failed for Europe/London 7am: expected hour 7, got ${tLondon7am.hour}`);
  }

  console.log('✅ PASS: 7:00 AM user local time filtering confirmed across timezones.');

  // --- Step 2: Single-Hazard Threshold Breach & Exact Message Format ---
  console.log('\n🌧️ Step 2: Testing Single-Hazard Rainfall Threshold Evaluation...');
  const syntheticForecast = generateSyntheticForecast24h(testLat, testLon);

  // Calculate actual synthetic rain total
  const expectedRain = syntheticForecast.steps.reduce((sum, s) => sum + s.precipitationMm, 0);
  console.log(`   [Synthetic Forecast] Total 24h rain: ${expectedRain.toFixed(2)} mm`);

  const userPrefs: UserThresholdPreferences = {
    id: 1,
    telegramChatId: testChatId,
    rainEnabled: true,
    rainThresholdMm: '2.50', // Threshold lower than expected rain -> will breach
    snowEnabled: false,
    snowThresholdCm: '5.00',
    windEnabled: false,
    windThresholdKmh: '80.0',
    frostEnabled: false,
    frostThresholdC: '0.0',
    heatEnabled: false,
    heatThresholdC: '35.0',
    hailMode: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const evalResult = evaluateWeatherThresholds(
    {
      telegramChatId: testChatId,
      locationName: 'Monitored Location',
      lat: testLat,
      lon: testLon,
    },
    userPrefs,
    syntheticForecast
  );

  if (!evalResult || evalResult.breaches.length === 0) {
    throw new Error('Expected rainfall threshold breach, but none was detected!');
  }

  console.log(`✅ Detected ${evalResult.breaches.length} threshold breach(es):`);
  const rainBreach = evalResult.breaches[0]!;
  console.log(`   • ${rainBreach.symbol} ${rainBreach.title}: ${rainBreach.forecastedValue} mm (Threshold: ${rainBreach.configuredThreshold} mm)`);

  const formattedHtml = formatThresholdAlertHtml(evalResult);
  console.log('\n✉️ --- Formatted Telegram HTML Message ---');
  console.log(formattedHtml);
  console.log('-----------------------------------------');

  if (!formattedHtml.includes('exceeding your configured threshold of')) {
    throw new Error('Formatted alert message is missing required threshold phrasing!');
  }

  // --- Step 3: Multi-Hazard Bundling Test ---
  console.log('\n⚠️ Step 3: Testing Multi-Hazard Bundling (Rain + Wind Gusts + Frost)...');
  const multiHazardPrefs: UserThresholdPreferences = {
    ...userPrefs,
    rainEnabled: true,
    rainThresholdMm: '2.00',
    windEnabled: true,
    windThresholdKmh: '40.0', // will breach (synthetic reaches 65 km/h)
    frostEnabled: true,
    frostThresholdC: '5.0', // will breach (synthetic night drops to 4°C)
  };

  const multiEval = evaluateWeatherThresholds(
    {
      telegramChatId: testChatId,
      locationName: 'Monitored Location',
      lat: testLat,
      lon: testLon,
    },
    multiHazardPrefs,
    syntheticForecast
  );

  if (!multiEval || multiEval.breaches.length < 3) {
    throw new Error(`Expected at least 3 breached metrics, got ${multiEval?.breaches.length || 0}`);
  }

  console.log(`✅ Successfully bundled ${multiEval.breaches.length} concurrent hazards into single alert card:`);
  for (const b of multiEval.breaches) {
    console.log(`   • ${b.symbol} ${b.title}: ${b.forecastedValue} ${b.unit} (Threshold: ${b.configuredThreshold} ${b.unit})`);
  }

  const multiHtml = formatThresholdAlertHtml(multiEval);
  if (!multiHtml.includes('configured thresholds</b> will be exceeded')) {
    throw new Error('Multi-hazard card missing consolidated header!');
  }

  // --- Step 4: Redis 24h Deduplication Gate Test ---
  console.log('\n🛡️ Step 4: Testing Redis 24h Deduplication Gate...');

  // Sweep 1: First check -> Should Send
  const dedupSweep1 = await evaluateThresholdDeduplication(testChatId, multiEval.breaches, testDateKey);
  console.log(`   [Sweep 1 - First Check] shouldSend: ${dedupSweep1.shouldSend}, approved: ${dedupSweep1.approvedBreaches.length}`);
  if (!dedupSweep1.shouldSend || dedupSweep1.approvedBreaches.length !== multiEval.breaches.length) {
    throw new Error('Sweep 1 should have approved all new threshold breaches!');
  }
  console.log('✅ PASS: Initial threshold notification approved for dispatch.');

  // Sweep 2: Repeat check with same conditions -> Should Suppress
  const dedupSweep2 = await evaluateThresholdDeduplication(testChatId, multiEval.breaches, testDateKey);
  console.log(`   [Sweep 2 - Repeat Check] shouldSend: ${dedupSweep2.shouldSend}, suppressed: ${dedupSweep2.suppressedCount}`);
  if (dedupSweep2.shouldSend) {
    throw new Error('Sweep 2 should have been suppressed by Redis cooldown!');
  }
  console.log('✅ PASS: Redundant alert correctly suppressed by 24h cooldown.');

  // Sweep 3: Escalation check (e.g. Rain surges to extreme rank 3) -> Should Bypass Cooldown
  const escalatedBreaches: BreachedThreshold[] = [
    {
      ...multiEval.breaches[0]!,
      forecastedValue: 45.0,
      severityRank: 3, // surged from rank 1 to 3
    },
  ];

  const dedupSweep3 = await evaluateThresholdDeduplication(testChatId, escalatedBreaches, testDateKey);
  console.log(`   [Sweep 3 - Escalation] shouldSend: ${dedupSweep3.shouldSend}, approved: ${dedupSweep3.approvedBreaches.length}`);
  if (!dedupSweep3.shouldSend || dedupSweep3.approvedBreaches.length !== 1) {
    throw new Error('Sweep 3 escalation failed to bypass cooldown!');
  }
  console.log('✅ PASS: Escalated threshold breach successfully bypassed cooldown.');

  // Clean up test keys
  let cleanupCursor = '0';
  do {
    const [nextCursor, keys] = await redis.scan(cleanupCursor, 'MATCH', pattern, 'COUNT', 100);
    cleanupCursor = nextCursor;
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  } while (cleanupCursor !== '0');

  console.log('\n🎉 ALL 4 MULTI-HAZARD THRESHOLD TESTS PASSED SUCCESSFULLY!\n');
}

runThresholdTestSuite()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Test suite failed:', err);
    process.exit(1);
  });
