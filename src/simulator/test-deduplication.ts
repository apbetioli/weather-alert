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

  try {
  const baseTimestamp = Math.floor(Date.now() / 1000);

  // -------------------------------------------------------------
  // SWEEP 1: Initial alert detection (severity rank 1)
  // Expected: Code 1 (INITIAL_ALERT) -> shouldSend: true
  // -------------------------------------------------------------
  console.log('📡 [Sweep 1] Radar Sweep t = 0 min: Severity rank 1 detected over user location');
  const sweep1 = await evaluateAlertDeduplication(testUserId, testCellId, 1, baseTimestamp);
  console.log(`   Result: Code ${sweep1.code} (${sweep1.reason}) | shouldSend: ${sweep1.shouldSend}`);

  if (sweep1.code !== 1 || sweep1.reason !== 'INITIAL_ALERT' || !sweep1.shouldSend) {
    console.error('❌ FAIL: Sweep 1 expected Code 1 (INITIAL_ALERT)');
    throw new Error('Sweep 1 expected INITIAL_ALERT');
  }
  console.log('   ✅ PASS: Initial alert approved for dispatch.\n');

  // -------------------------------------------------------------
  // SWEEP 2: Same severity within cooldown
  // Expected: Code 0 (SUPPRESSED) -> shouldSend: false
  // -------------------------------------------------------------
  const tSweep2 = baseTimestamp + 3 * 60; // +3 minutes
  console.log('📡 [Sweep 2] Radar Sweep t = +3 min: Severity rank remains 1');
  const sweep2 = await evaluateAlertDeduplication(testUserId, testCellId, 1, tSweep2);
  console.log(`   Result: Code ${sweep2.code} (${sweep2.reason}) | shouldSend: ${sweep2.shouldSend}`);

  if (sweep2.code !== 0 || sweep2.reason !== 'SUPPRESSED' || sweep2.shouldSend) {
    console.error('❌ FAIL: Sweep 2 expected Code 0 (SUPPRESSED)');
    throw new Error('Sweep 2 expected SUPPRESSED');
  }
  console.log('   ✅ PASS: Redundant alert suppressed by 24-hour cooldown window.\n');

  // -------------------------------------------------------------
  // SWEEP 3: Severity rank increases to 2
  // Expected: Code 2 (ESCALATION) -> shouldSend: true
  // -------------------------------------------------------------
  const tSweep3 = baseTimestamp + 6 * 60; // +6 minutes
  console.log('📡 [Sweep 3] Radar Sweep t = +6 min: Severity rank increases to 2');
  const sweep3 = await evaluateAlertDeduplication(testUserId, testCellId, 2, tSweep3);
  console.log(`   Result: Code ${sweep3.code} (${sweep3.reason}) | shouldSend: ${sweep3.shouldSend}`);

  if (sweep3.code !== 2 || sweep3.reason !== 'ESCALATION' || !sweep3.shouldSend) {
    console.error('❌ FAIL: Sweep 3 expected Code 2 (ESCALATION)');
    throw new Error('Sweep 3 expected ESCALATION');
  }
  console.log('   ✅ PASS: Escalation threshold bypassed cooldown and triggered alert!\n');

  // -------------------------------------------------------------
  // SWEEP 4: Cooldown expiration / Periodic reminder
  // Advance time by 24 hours after Sweep 3 (severity remains 2)
  // Elapsed time = 24 hours (cooldown elapsed)
  // Expected: Code 3 (COOLDOWN_EXPIRED) -> shouldSend: true
  // -------------------------------------------------------------
  const tSweep4 = tSweep3 + 24 * 60 * 60; // +24 hours after last notification
  console.log('📡 [Sweep 4] Radar Sweep t = +24 hours after escalation: Severity remains 2');
  const sweep4 = await evaluateAlertDeduplication(testUserId, testCellId, 2, tSweep4);
  console.log(`   Result: Code ${sweep4.code} (${sweep4.reason}) | shouldSend: ${sweep4.shouldSend}`);

  if (sweep4.code !== 3 || sweep4.reason !== 'COOLDOWN_EXPIRED' || !sweep4.shouldSend) {
    console.error('❌ FAIL: Sweep 4 expected Code 3 (COOLDOWN_EXPIRED)');
    throw new Error('Sweep 4 expected COOLDOWN_EXPIRED');
  }
  console.log('   ✅ PASS: 24-hour cooldown elapsed, reminder update approved for dispatch.\n');

  // Verify state contents in Redis
  const finalState = await redis.hgetall(stateKey);
  console.log('📊 Final Redis State Inspection:');
  console.log(`   - Key: ${stateKey}`);
  console.log(`   - last_notified_at: ${finalState.last_notified_at}`);
  console.log(`   - severity_rank: ${finalState.severity_rank}`);
  console.log(`   - dispatch_count: ${finalState.dispatch_count}`);

  const ttl = await redis.ttl(stateKey);
  console.log(`   - TTL remaining: ${ttl}s (Auto-cleanup configured for 172800s)\n`);

  console.log('🎉 ALL 4 MULTI-SWEEP DEDUPLICATION TESTS PASSED SUCCESSFULLY!\n');
  } finally {
    await redis.del(stateKey);
    await redis.quit();
  }
}

runDeduplicationSuite().catch((err) => {
  console.error('Fatal test error:', err);
  process.exitCode = 1;
});
