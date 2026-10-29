import test from 'node:test';
import assert from 'node:assert/strict';
import { HardwareDetector, HardwareProfile } from '../src/hardware/detector.js';
import { resolveProfileForHardware } from '../src/runtime/profiles.js';

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

test('HardwareDetector - resolveProfileForHardware maps 8GB, 16GB, 32GB, and 64GB profiles', () => {
  // 8GB NVIDIA -> performance (<10240 MB)
  const rig8GB: HardwareProfile = {
    type: 'nvidia',
    deviceName: 'RTX 4060 8GB',
    totalVramMb: 8192,
    freeVramMb: 7000,
    totalRamMb: 32768,
    freeRamMb: 24000,
    recommendedCtx: 16384,
    backend: 'llamacpp',
    selectedModel: 'test',
    selectedCtx: 16384,
    recommendedKvCache: 'f16',
    isKvCacheRuntimeEnforced: false,
    estimatedFullOffload7B: true,
    measuredGpuOffloadVerified: false,
    notes: []
  };
  const prof8 = resolveProfileForHardware(rig8GB);
  assert.equal(prof8.profileName, 'performance');
  assert.equal(prof8.contextSize, 32768);
  assert.equal(prof8.cacheTypeK, 'q4_0');

  // 16GB NVIDIA -> balanced (10240 - 24576 MB)
  const rig16GB: HardwareProfile = {
    ...rig8GB,
    deviceName: 'RTX 4080 16GB',
    totalVramMb: 16384
  };
  const prof16 = resolveProfileForHardware(rig16GB);
  assert.equal(prof16.profileName, 'balanced');
  assert.equal(prof16.contextSize, 65536);
  assert.equal(prof16.cacheTypeK, 'q8_0');

  // 32GB Apple Silicon Unified -> large-context (24577 - 49152 MB)
  const rig32GB: HardwareProfile = {
    ...rig8GB,
    type: 'apple-silicon',
    deviceName: 'Apple M3 Max 32GB',
    totalVramMb: 32768,
    totalRamMb: 32768
  };
  const prof32 = resolveProfileForHardware(rig32GB);
  assert.equal(prof32.profileName, 'large-context');
  assert.equal(prof32.contextSize, 131072);

  // 64GB Studio -> ultra-context (>49152 MB)
  const rig64GB: HardwareProfile = {
    ...rig8GB,
    type: 'apple-silicon',
    deviceName: 'Apple M2 Ultra 64GB',
    totalVramMb: 65536,
    totalRamMb: 65536
  };
  const prof64 = resolveProfileForHardware(rig64GB);
  assert.equal(prof64.profileName, 'ultra-context');
  assert.equal(prof64.contextSize, 262144);
});
