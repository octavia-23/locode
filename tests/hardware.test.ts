import test from 'node:test';
import assert from 'node:assert/strict';
import { HardwareDetector } from '../src/hardware/detector.js';

test('HardwareDetector - getProfile returns valid hardware profile with truthful distinction', async () => {
  const profile = await HardwareDetector.getProfile('qwen2.5-coder:7b', 8192);

  assert.ok(profile, 'Should return a hardware profile');
  assert.ok(['nvidia', 'apple-silicon', 'cpu'].includes(profile.type), 'Should identify compute device type');
  assert.ok(profile.recommendedCtx > 0, 'Should recommend a non-zero context window');
  assert.ok(profile.totalRamMb > 0, 'Should detect system RAM');
  assert.ok(Array.isArray(profile.notes), 'Notes should be an array');

  // Verify truthful distinctions
  assert.equal(typeof profile.estimatedFullOffload7B, 'boolean');
  assert.equal(typeof profile.measuredGpuOffloadVerified, 'boolean');
  assert.equal(typeof profile.isKvCacheRuntimeEnforced, 'boolean');
  assert.ok(['f16', 'q8_0', 'q4_0'].includes(profile.recommendedKvCache));
  assert.equal(profile.selectedModel, 'qwen2.5-coder:7b');
  assert.equal(profile.selectedCtx, 8192);
});
