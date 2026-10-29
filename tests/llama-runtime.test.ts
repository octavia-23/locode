import test from 'node:test';
import assert from 'node:assert/strict';
import { LlamaCppRuntime } from '../src/runtime/manager.js';
import { LlamaCppTurboQuantProvider } from '../src/providers/llama-cpp.js';
import { createLLMProvider } from '../src/providers/factory.js';
import { INFERENCE_PROFILES, resolveProfileForHardware, resolveProfileConfig } from '../src/runtime/profiles.js';
import { RuntimeDetector } from '../src/runtime/detector.js';
import { AgentContext, ToolDefinition } from '../src/types.js';

test('RuntimeProfiles - contains performance, large-context, and balanced profiles', () => {
  assert.ok(INFERENCE_PROFILES['ultra-context']);
  assert.equal(INFERENCE_PROFILES['ultra-context'].contextSize, 262144);
  assert.equal(INFERENCE_PROFILES['ultra-context'].nCpuMoe, 34);
  assert.equal(INFERENCE_PROFILES['ultra-context'].cacheTypeK, 'turbo4');
  assert.equal(INFERENCE_PROFILES['ultra-context'].cacheTypeV, 'turbo3');

  assert.ok(INFERENCE_PROFILES.performance);
  assert.equal(INFERENCE_PROFILES.performance.contextSize, 32768);
  assert.equal(INFERENCE_PROFILES.performance.nCpuMoe, 24);
  assert.equal(INFERENCE_PROFILES.performance.cacheTypeK, 'q4_0');
  assert.equal(INFERENCE_PROFILES.performance.cacheTypeV, 'q4_0');

  assert.ok(INFERENCE_PROFILES['large-context']);
  assert.equal(INFERENCE_PROFILES['large-context'].contextSize, 131072);
  assert.equal(INFERENCE_PROFILES['large-context'].cacheTypeK, 'turbo4');

  assert.ok(INFERENCE_PROFILES.balanced);
  assert.equal(INFERENCE_PROFILES.balanced.contextSize, 65536);
  assert.equal(INFERENCE_PROFILES.balanced.cacheTypeK, 'q8_0');
  assert.equal(INFERENCE_PROFILES.balanced.cacheTypeV, 'q8_0');
});

test('RuntimeProfiles - resolveProfileForHardware maps memory budgets deterministically', () => {
  // 8GB VRAM (8192 MB < 10240 MB) -> performance
  const hw8gb: any = { type: 'nvidia', totalVramMb: 8192, totalRamMb: 32768 };
  const p8 = resolveProfileForHardware(hw8gb);
  assert.equal(p8.profileName, 'performance');
  assert.equal(p8.contextSize, 32768);
  assert.equal(p8.cacheTypeK, 'q4_0');

  // 16GB VRAM (16384 MB in 10240 - 24576 MB) -> balanced
  const hw16gb: any = { type: 'nvidia', totalVramMb: 16384, totalRamMb: 32768 };
  const p16 = resolveProfileForHardware(hw16gb);
  assert.equal(p16.profileName, 'balanced');
  assert.equal(p16.contextSize, 65536);
  assert.equal(p16.cacheTypeK, 'q8_0');

  // 32GB Unified Memory Apple Silicon (32768 MB in 24577 - 49152 MB) -> large-context
  const hw32gb: any = { type: 'apple-silicon', totalVramMb: 32768, totalRamMb: 32768 };
  const p32 = resolveProfileForHardware(hw32gb);
  assert.equal(p32.profileName, 'large-context');
  assert.equal(p32.contextSize, 131072);

  // 64GB High-Capacity Rig (65536 MB > 49152 MB) -> ultra-context
  const hw64gb: any = { type: 'nvidia', totalVramMb: 65536, totalRamMb: 131072 };
  const p64 = resolveProfileForHardware(hw64gb);
  assert.equal(p64.profileName, 'ultra-context');
  assert.equal(p64.contextSize, 262144);
});

test('LlamaCppRuntime - buildArgs generates exact optimized TurboQuant CLI arguments', () => {
  const runtime = new LlamaCppRuntime({
    modelPath: 'C:\\models\\qwen35b.gguf',
    modelAlias: 'locode-qwen35b-a3b',
    port: 8081,
    contextSize: 32768,
    nCpuMoe: 24,
    nGpuLayers: 999,
    batchSize: 2048,
    ubatchSize: 512,
    threads: 12,
    flashAttention: true,
    cacheTypeK: 'turbo4',
    cacheTypeV: 'turbo4',
    noMmap: true,
    mlock: true,
    jinja: true
  });

  const flags = {
    supportsTurbo4: true,
    supportsCpuMoe: true,
    supportsFlashAttn: true,
    supportsNoMmap: true,
    supportsMlock: true,
    supportsJinja: true,
    supportsCacheReuse: true,
    supportsFitOff: true,
    supportsReasoningFormat: true
  };

  const args = runtime.buildArgs(flags);

  assert.ok(args.includes('-m'));
  assert.ok(args.includes('C:\\models\\qwen35b.gguf'));
  assert.ok(args.includes('--alias'));
  assert.ok(args.includes('locode-qwen35b-a3b'));
  assert.ok(args.includes('-c'));
  assert.ok(args.includes('32768'));
  assert.ok(args.includes('-ngl'));
  assert.ok(args.includes('999'));
  assert.ok(args.includes('--n-cpu-moe'));
  assert.ok(args.includes('24'));
  assert.ok(args.includes('-b'));
  assert.ok(args.includes('2048'));
  assert.ok(args.includes('-ub'));
  assert.ok(args.includes('512'));
  assert.ok(args.includes('-t'));
  assert.ok(args.includes('12'));
  assert.ok(args.includes('--flash-attn'));
  assert.ok(args.includes('--cache-type-k'));
  assert.ok(args.includes('turbo4'));
  assert.ok(args.includes('--cache-type-v'));
  assert.ok(args.includes('turbo4'));
  assert.ok(args.includes('--no-mmap'));
  assert.ok(args.includes('--mlock'));
  assert.ok(args.includes('--jinja'));
  assert.ok(args.includes('--reasoning-format'));
  assert.ok(args.includes('none'));
});

test('LlamaCppRuntime - gracefully drops unsupported flags when binary lacks them', () => {
  const runtime = new LlamaCppRuntime({
    modelPath: 'C:\\models\\qwen35b.gguf',
    modelAlias: 'locode-qwen35b-a3b'
  });

  const limitedFlags = {
    supportsTurbo4: false,
    supportsCpuMoe: false,
    supportsFlashAttn: false,
    supportsNoMmap: false,
    supportsMlock: false,
    supportsJinja: true,
    supportsCacheReuse: false,
    supportsFitOff: false,
    supportsReasoningFormat: false
  };

  const args = runtime.buildArgs(limitedFlags);
  assert.ok(!args.includes('--cache-type-k'));
  assert.ok(!args.includes('--n-cpu-moe'));
  assert.ok(!args.includes('--flash-attn'));
  assert.ok(!args.includes('--no-mmap'));
  assert.ok(!args.includes('--mlock'));
  assert.ok(!args.includes('--fit'));
  assert.ok(!args.includes('--reasoning-format'));
  assert.ok(args.includes('--jinja'));
});

test('LlamaCppRuntime - port allocation finds open localhost port', async () => {
  const runtime = new LlamaCppRuntime();
  const port = await runtime.findAvailablePort(8081);
  assert.ok(port >= 8081, 'Allocated port should be >= 8081');
});

test('createLLMProvider - returns LlamaCppTurboQuantProvider when provider is llamacpp', () => {
  const context: AgentContext = {
    cwd: process.cwd(),
    autoApprove: true,
    model: 'locode-qwen35b-a3b',
    ollamaHost: 'http://127.0.0.1:11434',
    provider: 'llamacpp',
    numCtx: 32768
  };

  const provider = createLLMProvider(context);
  assert.ok(provider instanceof LlamaCppTurboQuantProvider);
  assert.equal(provider.getModel(), 'locode-qwen35b-a3b');
  assert.equal(provider.getNumCtx?.(), 32768);
});

test('createLLMProvider - context switching updates numCtx', () => {
  const context: AgentContext = {
    cwd: process.cwd(),
    autoApprove: true,
    model: 'locode-qwen35b-a3b',
    ollamaHost: 'http://127.0.0.1:11434',
    provider: 'llamacpp',
    numCtx: 32768
  };

  const provider = createLLMProvider(context);
  assert.equal(provider.getNumCtx?.(), 32768);

  provider.setNumCtx?.(65536);
  assert.equal(provider.getNumCtx?.(), 65536);
});

test('createLLMProvider - preserves Ollama provider compatibility', () => {
  const context: AgentContext = {
    cwd: process.cwd(),
    autoApprove: true,
    model: 'qwen2.5-coder:7b',
    ollamaHost: 'http://127.0.0.1:11434',
    provider: 'ollama',
    numCtx: 8192
  };

  const provider = createLLMProvider(context);
  assert.equal(provider.getModel(), 'qwen2.5-coder:7b');
  assert.equal(provider.getNumCtx?.(), 8192);
});
