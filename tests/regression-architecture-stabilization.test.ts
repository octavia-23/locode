import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import { OllamaProvider } from '../src/providers/ollama.js';
import { GeminiProvider } from '../src/providers/gemini.js';
import { AnthropicProvider } from '../src/providers/anthropic.js';
import { OpenAICompatibleProvider } from '../src/providers/openai-compatible.js';
import { LlamaCppTurboQuantProvider } from '../src/providers/llama-cpp.js';
import { getModelCapabilities } from '../src/providers/types.js';
import { LlamaCppRuntime } from '../src/runtime/manager.js';

import { ToolSchemaValidator } from '../src/engine/schema-validator.js';
import { PermissionEngine } from '../src/engine/permission-engine.js';
import { ToolDispatcher } from '../src/engine/tool-dispatcher.js';
import { RecoveryController } from '../src/engine/recovery-controller.js';
import { CodeVerifier } from '../src/agent/verifier.js';
import { ContextEngine } from '../src/agent/context.js';
import { buildSystemPrompt } from '../src/agent/prompt.js';
import {
  LOCAL_CONSERVATIVE_PROFILE,
  CLOUD_FRONTIER_PROFILE,
  resolveExecutionProfile
} from '../src/runtime/profiles.js';
import { viewFileTool, writeFileTool, editFileTool } from '../src/tools/file-ops.js';
import { AgentContext } from '../src/types.js';

// ============================================================================
// 1. Ollama Host Propagation (DEF-01)
// ============================================================================
test('Stabilization DEF-01: OllamaProvider stores, sets, and targets effective configured host', () => {
  const customHost = 'http://192.168.1.150:11434';
  const provider = new OllamaProvider('qwen2.5-coder:7b', customHost, 16384);

  assert.equal(provider.getHost(), customHost, 'Host should be retrievable and match constructor configuration');

  provider.setHost('http://remote-server:11434');
  assert.equal(provider.getHost(), 'http://remote-server:11434', 'Host should update dynamically when setHost is called');

  const capabilities = provider.getCapabilities();
  assert.equal(capabilities.supportsToolCalling, true);
  assert.equal(capabilities.supportsStreaming, true);
  assert.equal(capabilities.maxContextTokens, 16384);
});

// ============================================================================
// 2. Pre-Execution Tool Schema Validation (DEF-02)
// ============================================================================
test('Stabilization DEF-02: ToolSchemaValidator catches missing required fields and type mismatches', () => {
  // Test edit_file schema: requires path, target_content, replacement_content
  const missingArgs = { path: 'index.ts' }; // Missing target_content and replacement_content
  const res1 = ToolSchemaValidator.validate(editFileTool, missingArgs);
  assert.equal(res1.valid, false, 'Validation should fail on missing required properties');
  assert.ok(res1.errors.some(e => e.includes('target_content')), 'Error should list missing target_content');

  // Test type mismatch: path must be string, not number
  const wrongTypeArgs = { path: 12345, target_content: 'foo', replacement_content: 'bar' };
  const res2 = ToolSchemaValidator.validate(editFileTool, wrongTypeArgs);
  assert.equal(res2.valid, false, 'Validation should fail when parameter type does not match schema');
  assert.ok(res2.errors.some(e => e.includes('must be a string')), 'Error should report type mismatch');

  // Test valid args
  const validArgs = { path: 'index.ts', target_content: 'foo', replacement_content: 'bar' };
  const res3 = ToolSchemaValidator.validate(editFileTool, validArgs);
  assert.equal(res3.valid, true, 'Validation should pass for compliant argument schema');
  assert.equal(res3.errors.length, 0);
});

test('Stabilization DEF-02: ToolDispatcher blocks tool execution when schema validation fails', async () => {
  let toolExecuted = false;
  const mockTool = {
    name: 'test_tool',
    description: 'Test Tool',
    parameters: {
      type: 'object' as const,
      properties: {
        filename: { type: 'string', description: 'Name of file' }
      },
      required: ['filename']
    },
    execute: async () => {
      toolExecuted = true;
      return { result: 'executed' };
    }
  };

  const dispatcher = new ToolDispatcher();
  const context: AgentContext = {
    cwd: process.cwd(),
    autoApprove: true,
    model: 'test',
    ollamaHost: 'http://127.0.0.1:11434'
  };

  // Dispatch invalid tool call (missing required 'filename')
  const durableResult = await dispatcher.dispatch(mockTool, {}, context);

  assert.equal(toolExecuted, false, 'Tool execution function must NEVER be called when schema validation fails');
  assert.equal(durableResult.status, 'validation_failed');
  assert.equal(durableResult.isError, true);
  assert.ok(durableResult.output.includes('SCHEMA VALIDATION ERROR'));
});

// ============================================================================
// 3. Verification State Distinction (DEF-03)
// ============================================================================
test('Stabilization DEF-03: CodeVerifier explicitly returns "not-run" when no tests or verifiers exist', async () => {
  const tmpEmptyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locode-empty-project-'));

  try {
    const result = await CodeVerifier.run(tmpEmptyDir);

    assert.equal(result.status, 'not-run', 'Status should be explicitly "not-run"');
    assert.equal(result.passed, false, 'passed should be false to prevent falsely locking down action gates');
    assert.ok(result.reason?.includes('No verification or test command configured'));

    // ContextEngine integration check
    const contextEngine = new ContextEngine(8192, tmpEmptyDir);
    contextEngine.recordVerificationResult(result.passed, result.command || 'verify', result.errorOutput, result.status);

    const taskState = contextEngine.getTaskState();
    assert.equal(taskState.lastVerification?.status, 'not-run');
    assert.equal(taskState.lastVerification?.passed, false);
  } finally {
    await fs.rm(tmpEmptyDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('Stabilization DEF-03: CodeVerifier correctly records "passed" and "failed" execution states', async () => {
  const cwd = process.cwd();

  // Test passed command
  const passResult = await CodeVerifier.run(cwd, 'node -e "process.exit(0)"');
  assert.equal(passResult.status, 'passed');
  assert.equal(passResult.passed, true);

  // Test failed command
  const failResult = await CodeVerifier.run(cwd, 'node -e "console.error(\'Simulated failure\'); process.exit(1)"');
  assert.equal(failResult.status, 'failed');
  assert.equal(failResult.passed, false);
  assert.ok(failResult.errorOutput?.includes('Simulated failure'));
});

// ============================================================================
// 4. Model Capabilities Contract (DEF-04)
// ============================================================================
test('Stabilization DEF-04: All providers explicitly declare capabilities matching operational specs', () => {
  const gemini = new GeminiProvider('gemini-3.8-flash', 'test-key', 'http://127.0.0.1:9999', 1048576);
  const geminiCaps = gemini.getCapabilities();
  assert.equal(geminiCaps.supportsToolCalling, true);
  assert.equal(geminiCaps.supportsStreaming, true);
  assert.equal(geminiCaps.supportsStructuredOutput, true);
  assert.equal(geminiCaps.supportsThinking, true);
  assert.equal(geminiCaps.maxContextTokens, 1048576);

  const anthropic = new AnthropicProvider('claude-3-5-sonnet-20241022', 'test-key', 'http://127.0.0.1:9999', 200000);
  const anthropicCaps = anthropic.getCapabilities();
  assert.equal(anthropicCaps.supportsToolCalling, true);
  assert.equal(anthropicCaps.maxContextTokens, 200000);

  const openai = new OpenAICompatibleProvider('gpt-4o', 'http://127.0.0.1:9999', 'test-key', 128000);
  const openaiCaps = openai.getCapabilities();
  assert.equal(openaiCaps.supportsToolCalling, true);
  assert.equal(openaiCaps.maxContextTokens, 128000);

  const llamaRuntime = new LlamaCppRuntime({ contextSize: 262144 });
  const llamacpp = new LlamaCppTurboQuantProvider(llamaRuntime, 'locode-qwen35b-a3b', 262144);
  const llamaCaps = llamacpp.getCapabilities();
  assert.equal(llamaCaps.supportsToolCalling, true);
  assert.equal(llamaCaps.maxContextTokens, 262144);
  assert.equal(llamaCaps.supportsStructuredOutput, false); // Local quantized model

  // Helper function test
  assert.equal(getModelCapabilities(gemini).supportsToolCalling, true);
});

// ============================================================================
// 5. Cancellation & Configurable Timeouts (DEF-05 & DEF-06)
// ============================================================================
test('Stabilization DEF-05 & DEF-06: GeminiProvider supports caller AbortSignal cancellation', async () => {
  const server = http.createServer((req, res) => {
    // Keep connection open without writing response immediately
  });

  await new Promise<void>(resolve => server.listen(0, resolve));
  const port = (server.address() as any).port;

  try {
    const provider = new GeminiProvider('gemini-3.6-flash', 'test-key', `http://127.0.0.1:${port}`);
    const abortController = new AbortController();

    // Trigger abort after 100ms
    setTimeout(() => abortController.abort(), 100);

    const startTime = Date.now();
    await assert.rejects(
      async () => {
        await provider.chat(
          [{ role: 'user', content: 'test cancellation' }],
          [],
          undefined,
          { signal: abortController.signal, timeoutMs: 5000 }
        );
      },
      (err: any) => {
        const elapsed = Date.now() - startTime;
        return elapsed < 1500; // Aborted quickly, NOT waiting 18 seconds!
      }
    );
  } finally {
    server.close();
  }
});

// ============================================================================
// 6. Permission Engine & Workspace Security
// ============================================================================
test('Stabilization Engine: PermissionEngine enforces read-only mode, containment, and dangerous commands', () => {
  const permEngine = new PermissionEngine({ readOnly: true, allowOutsideWorkspace: false });
  const context: AgentContext = {
    cwd: process.cwd(),
    autoApprove: false,
    model: 'test',
    ollamaHost: 'http://127.0.0.1:11434'
  };

  // 1. Prohibit write_file in read-only mode
  const writeEval = permEngine.evaluate(writeFileTool, { path: 'test.txt', content: 'hello' }, context);
  assert.equal(writeEval.allowed, false);
  assert.ok(writeEval.reason?.includes('read-only mode'));

  // 2. Allow passive view_file in read-only mode
  const readEval = permEngine.evaluate(viewFileTool, { path: 'package.json' }, context);
  assert.equal(readEval.allowed, true);

  // 3. Prohibit path traversal outside workspace
  const outsidePath = path.resolve(process.cwd(), '../../some-external-file.txt');
  const traverseEval = permEngine.evaluate(viewFileTool, { path: outsidePath }, context);
  assert.equal(traverseEval.allowed, false);
  assert.ok(traverseEval.reason?.includes('workspace'));
});

// ============================================================================
// 7. Execution Profiles & Cloud Privacy Gating (DEF-08)
// ============================================================================
test('Stabilization DEF-08: Execution Profiles distinguish local conservative vs cloud frontier', () => {
  const localProfile = resolveExecutionProfile(false);
  assert.equal(localProfile.mode, 'local');
  assert.equal(localProfile.safetyCeiling, 45);
  assert.equal(localProfile.maxExplorationReads, 2);
  assert.equal(localProfile.privacyPolicy.allowFullRepoContext, true, 'Local profiles safely allow full local repo context');

  const cloudProfile = resolveExecutionProfile(true);
  assert.equal(cloudProfile.mode, 'cloud');
  assert.equal(cloudProfile.safetyCeiling, 100);
  assert.equal(cloudProfile.privacyPolicy.allowFullRepoContext, false, 'Cloud profiles must NEVER implicitly transfer full repo context');
  assert.equal(cloudProfile.privacyPolicy.redactSecrets, true);
});

test('Stabilization DEF-08: buildSystemPrompt never transfers full repository context to cloud implicitly', async () => {
  const cwd = process.cwd();

  // Cloud prompt with default privacy policy (allowFullRepoContext: false)
  const cloudPrompt = await buildSystemPrompt(cwd, true, false);
  assert.ok(!cloudPrompt.includes('## Repository Codebase Map'), 'Cloud prompt must omit full repo symbol map when allowFullRepoContext is false');

  // Local prompt allows full repo context
  const localPrompt = await buildSystemPrompt(cwd, false, true);
  assert.ok(localPrompt.includes('## Repository Codebase Map'), 'Local prompt includes repository map for local model guidance');
});

// ============================================================================
// 8. Recovery Controller & Periodic Tool Cycle Detection
// ============================================================================
test('Stabilization Engine: RecoveryController detects periodic cycles (period 1 and period 2 ping-pong)', () => {
  // Period 1 identical repetition
  const rep1 = ['view_file:{"path":"a.ts"}', 'view_file:{"path":"a.ts"}', 'view_file:{"path":"a.ts"}', 'view_file:{"path":"a.ts"}'];
  const cycle1 = RecoveryController.detectToolCycle(rep1);
  assert.equal(cycle1.detected, true);
  assert.equal(cycle1.period, 1);

  // Period 2 A-B-A-B cycle
  const rep2 = [
    'view_file:{"path":"a.ts"}',
    'view_file:{"path":"b.ts"}',
    'view_file:{"path":"a.ts"}',
    'view_file:{"path":"b.ts"}',
    'view_file:{"path":"a.ts"}',
    'view_file:{"path":"b.ts"}'
  ];
  const cycle2 = RecoveryController.detectToolCycle(rep2);
  assert.equal(cycle2.detected, true);
  assert.equal(cycle2.period, 2);

  // Normal progressive sequence
  const progressive = ['view_file:{"path":"a.ts"}', 'search_code:{"query":"fn"}', 'edit_file:{"path":"a.ts"}', 'run_command:{"cmd":"test"}'];
  const cycle3 = RecoveryController.detectToolCycle(progressive);
  assert.equal(cycle3.detected, false);
});
