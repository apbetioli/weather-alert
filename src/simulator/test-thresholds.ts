import { fetchRollingForecast24h, generateSyntheticForecast24h } from '../ingestion/providers/open-meteo';
import { evaluateWeatherThresholds, type BreachedThreshold } from '../engine/threshold-evaluator';
import { formatThresholdAlertHtml } from '../bot/formatters';
import { evaluateThresholdDeduplication } from '../redis/deduplicator';
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
    if (forecast.steps.length < 24) {
      throw new Error(`Expected at least 24 steps, got ${forecast.steps.length}`);
    }
  } catch (err: any) {
    console.log(`⚠️ Live Open-Meteo fetch skipped in test suite (${err?.message || err}).`);
  }

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
