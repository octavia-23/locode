import test from 'node:test';
import assert from 'node:assert/strict';
import { LlamaCppRuntime } from '../src/runtime/manager.js';
import { LlamaCppTurboQuantProvider } from '../src/providers/llama-cpp.js';
import { createLLMProvider } from '../src/providers/factory.js';
import { INFERENCE_PROFILES } from '../src/runtime/profiles.js';
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
  assert.equal(INFERENCE_PROFILES.performance.cacheTypeK, 'turbo4');
  assert.equal(INFERENCE_PROFILES.performance.cacheTypeV, 'turbo4');

  assert.ok(INFERENCE_PROFILES['large-context']);
  assert.equal(INFERENCE_PROFILES['large-context'].contextSize, 65536);
  assert.equal(INFERENCE_PROFILES['large-context'].cacheTypeK, 'turbo4');

  assert.ok(INFERENCE_PROFILES.balanced);
  assert.equal(INFERENCE_PROFILES.balanced.contextSize, 16384);
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
    supportsFitOff: true
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
    supportsFitOff: false
  };

  const args = runtime.buildArgs(limitedFlags);
  assert.ok(!args.includes('--cache-type-k'));
  assert.ok(!args.includes('--n-cpu-moe'));
  assert.ok(!args.includes('--flash-attn'));
  assert.ok(!args.includes('--no-mmap'));
  assert.ok(!args.includes('--mlock'));
  assert.ok(!args.includes('--fit'));
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
