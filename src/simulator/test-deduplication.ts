import { redis } from '../redis/client';
import { evaluateAlertDeduplication } from '../redis/deduplicator';

async function runDeduplicationSuite() {
  console.log('🧪 Starting Multi-Sweep Deduplication & Escalation Test Suite...\n');

  const testUserId = 'test_sim_user_88';
  const testCellId = 'CELL_SUPERCELL_VENEZIA';
  const stateKey = `alert:state:${testUserId}:${testCellId}`;

  // Step 0: Clean up any leftover test keys in Redis
  await redis.del(stateKey);
  console.log(`🧹 Flushed test Redis state key: ${stateKey}\n`);

  const baseTimestamp = Math.floor(Date.now() / 1000);

  // -------------------------------------------------------------
  // SWEEP 1: Initial alert detection (Hail 2.0 cm)
  // Expected: Code 1 (INITIAL_ALERT) -> shouldSend: true
  // -------------------------------------------------------------
  console.log('📡 [Sweep 1] Radar Sweep t = 0 min: Hail core 2.0 cm detected over user location');
  const sweep1 = await evaluateAlertDeduplication(testUserId, testCellId, 2.0, baseTimestamp);
  console.log(`   Result: Code ${sweep1.code} (${sweep1.reason}) | shouldSend: ${sweep1.shouldSend}`);

  if (sweep1.code !== 1 || sweep1.reason !== 'INITIAL_ALERT' || !sweep1.shouldSend) {
    console.error('❌ FAIL: Sweep 1 expected Code 1 (INITIAL_ALERT)');
    process.exit(1);
  }
  console.log('   ✅ PASS: Initial alert approved for dispatch.\n');

  // -------------------------------------------------------------
  // SWEEP 2: Minor increase within cooldown (Hail 2.2 cm at t = +3 min)
  // Δ = +0.2 cm (< 1.5 cm threshold), elapsed time 3 min (< 45 min cooldown)
  // Expected: Code 0 (SUPPRESSED) -> shouldSend: false
  // -------------------------------------------------------------
  const tSweep2 = baseTimestamp + 3 * 60; // +3 minutes
  console.log('📡 [Sweep 2] Radar Sweep t = +3 min: Hail core 2.2 cm (+0.2 cm change)');
  const sweep2 = await evaluateAlertDeduplication(testUserId, testCellId, 2.2, tSweep2);
  console.log(`   Result: Code ${sweep2.code} (${sweep2.reason}) | shouldSend: ${sweep2.shouldSend}`);

  if (sweep2.code !== 0 || sweep2.reason !== 'SUPPRESSED' || sweep2.shouldSend) {
    console.error('❌ FAIL: Sweep 2 expected Code 0 (SUPPRESSED)');
    process.exit(1);
  }
  console.log('   ✅ PASS: Redundant alert suppressed by 45-min cooldown window.\n');

  // -------------------------------------------------------------
  // SWEEP 3: Escalation condition met (Hail jumps to 3.8 cm at t = +6 min)
  // Δ = 3.8 cm - 2.2 cm = +1.6 cm (>= 1.5 cm threshold)
  // Expected: Code 2 (ESCALATION) -> shouldSend: true
  // -------------------------------------------------------------
  const tSweep3 = baseTimestamp + 6 * 60; // +6 minutes
  console.log('📡 [Sweep 3] Radar Sweep t = +6 min: Hail core surges to 3.8 cm (Δ = +1.6 cm >= 1.5 cm)');
  const sweep3 = await evaluateAlertDeduplication(testUserId, testCellId, 3.8, tSweep3);
  console.log(`   Result: Code ${sweep3.code} (${sweep3.reason}) | shouldSend: ${sweep3.shouldSend}`);

  if (sweep3.code !== 2 || sweep3.reason !== 'ESCALATION' || !sweep3.shouldSend) {
    console.error('❌ FAIL: Sweep 3 expected Code 2 (ESCALATION)');
    process.exit(1);
  }
  console.log('   ✅ PASS: Escalation threshold bypassed cooldown and triggered alert!\n');

  // -------------------------------------------------------------
  // SWEEP 4: Cooldown expiration / Periodic reminder
  // Advance time by 46 minutes after Sweep 3 (Hail remains 3.8 cm)
  // Elapsed time = 46 min (>= 45 min cooldown)
  // Expected: Code 3 (COOLDOWN_EXPIRED) -> shouldSend: true
  // -------------------------------------------------------------
  const tSweep4 = tSweep3 + 46 * 60; // +46 minutes after last notification
  console.log('📡 [Sweep 4] Radar Sweep t = +52 min (+46 min after escalation): Hail remains 3.8 cm');
  const sweep4 = await evaluateAlertDeduplication(testUserId, testCellId, 3.8, tSweep4);
  console.log(`   Result: Code ${sweep4.code} (${sweep4.reason}) | shouldSend: ${sweep4.shouldSend}`);

  if (sweep4.code !== 3 || sweep4.reason !== 'COOLDOWN_EXPIRED' || !sweep4.shouldSend) {
    console.error('❌ FAIL: Sweep 4 expected Code 3 (COOLDOWN_EXPIRED)');
    process.exit(1);
  }
  console.log('   ✅ PASS: 45-minute cooldown elapsed, reminder update approved for dispatch.\n');

  // Verify state contents in Redis
  const finalState = await redis.hgetall(stateKey);
  console.log('📊 Final Redis State Inspection:');
  console.log(`   - Key: ${stateKey}`);
  console.log(`   - last_notified_at: ${finalState.last_notified_at}`);
  console.log(`   - max_hail_cm: ${finalState.max_hail_cm} cm`);
  console.log(`   - dispatch_count: ${finalState.dispatch_count}`);

  const ttl = await redis.ttl(stateKey);
  console.log(`   - TTL remaining: ${ttl}s (Auto-cleanup configured for 5400s)\n`);

  // Clean up
  await redis.del(stateKey);
  await redis.quit();

  console.log('🎉 ALL 4 MULTI-SWEEP DEDUPLICATION TESTS PASSED SUCCESSFULLY!\n');
}

runDeduplicationSuite().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
