import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { editFileTool } from '../src/tools/file-ops.js';
import { CodeVerifier } from '../src/agent/verifier.js';
import { AgentLoop } from '../src/agent/loop.js';
import { TerminalRenderer } from '../src/ui/renderer.js';
import { AgentContext } from '../src/types.js';
import { ILLMProvider } from '../src/providers/types.js';

class MockLLMProvider implements ILLMProvider {
  constructor(private modelName: string = 'mock-model') {}
  async chat() {
    return { content: 'Mock response', usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 } };
  }
  async isHealthy() { return true; }
  getModel() { return this.modelName; }
  setModel(model: string) { this.modelName = model; }
  async getAvailableModels() { return [this.modelName]; }
}

test('Harness Hardening - editFileTool preserves CRLF line endings on Windows/CRLF files', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locode-crlf-test-'));
  const filePath = path.join(tmpDir, 'crlf.txt');
  const crlfContent = 'line 1\r\nline 2 with target\r\nline 3\r\n';
  await fs.writeFile(filePath, crlfContent, 'utf8');

  const ctx: AgentContext = {
    cwd: tmpDir,
    autoApprove: true,
    model: 'mock-model'
  };

  const editRes = await editFileTool.execute({
    path: 'crlf.txt',
    target_content: 'line 2 with target',
    replacement_content: 'line 2 updated'
  }, ctx);

  assert.equal(editRes.isError, undefined);
  const updatedContent = await fs.readFile(filePath, 'utf8');

  // Must contain updated text
  assert.ok(updatedContent.includes('line 2 updated'));
  // Must preserve CRLF line endings everywhere
  assert.ok(updatedContent.includes('\r\n'));
  assert.equal(updatedContent, 'line 1\r\nline 2 updated\r\nline 3\r\n');

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('Harness Hardening - AgentLoop.normalizeResponse preserves thought_signature for Gemini 3', () => {
  const renderer = new TerminalRenderer();
  const loop = new AgentLoop({
    cwd: process.cwd(),
    provider: 'gemini',
    model: 'gemini-3.6-flash'
  }, renderer, new MockLLMProvider('gemini-3.6-flash'));

  const rawGeminiResponse = {
    content: 'Thinking about the code...',
    tool_calls: [
      {
        id: 'call_123',
        type: 'function',
        function: {
          name: 'view_file',
          arguments: { path: 'src/index.ts' }
        },
        thoughtSignature: 'sig_camel_case_12345',
        thought_signature: 'sig_snake_case_67890'
      }
    ],
    usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 }
  };

  const normalized = loop.normalizeResponse(rawGeminiResponse);

  assert.equal(normalized.type, 'TOOL_CALLS');
  assert.equal(normalized.toolCalls?.length, 1);
  const tc = normalized.toolCalls![0] as any;
  assert.equal(tc.thoughtSignature, 'sig_camel_case_12345');
  assert.equal(tc.thought_signature, 'sig_snake_case_67890');
});

test('Harness Hardening - CodeVerifier.runFastLint isolates errors to the target file', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locode-fastlint-test-'));
  await fs.writeFile(path.join(tmpDir, 'package.json'), JSON.stringify({ scripts: { typecheck: 'npx tsc --noEmit' } }), 'utf8');

  try {
    // 1. Mock runner returning error only in an unrelated file
    const unrelatedOutput = `
src/other-module.ts:15:10 - error TS2304: Cannot find name 'foo'.
    `;
    const origRun = CodeVerifier.run;
    (CodeVerifier as any).run = async () => ({
      passed: false,
      command: 'npx tsc --noEmit',
      errorOutput: unrelatedOutput
    });

    const checkTarget = await CodeVerifier.runFastLint(tmpDir, 'src/target-file.ts');
    // Pre-existing unrelated error must NOT fail the fast-lint check on target-file.ts
    assert.equal(checkTarget.passed, true);

    // 2. Mock runner returning error in the target file
    const targetErrorOutput = `
src/target-file.ts:5:2 - error TS2322: Type 'number' is not assignable to type 'string'.
    `;
    (CodeVerifier as any).run = async () => ({
      passed: false,
      command: 'npx tsc --noEmit',
      errorOutput: targetErrorOutput
    });

    const checkTargetFail = await CodeVerifier.runFastLint(tmpDir, 'src/target-file.ts');
    assert.equal(checkTargetFail.passed, false);

    // Restore original run
    (CodeVerifier as any).run = origRun;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('Harness Hardening - Terminal non-zero exit codes do not trip the tool failure circuit breaker', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locode-cb-test-'));
  const renderer = new TerminalRenderer();
  const mockProvider = new MockLLMProvider();

  let turn = 0;
  mockProvider.chat = async () => {
    turn++;
    // Run 6 failing commands in sequence.
    // In local mode, the circuit breaker limit is 5 consecutive failures.
    // Shell non-zero exits must NOT trip the circuit breaker.
    if (turn <= 6) {
      return {
        content: `Investigating failure ${turn}...`,
        tool_calls: [{
          id: `cmd_${turn}`,
          type: 'function',
          function: { name: 'run_command', arguments: { command: `node -e "console.error('err ${turn}'); process.exit(1)"` } }
        }]
      };
    } else {
      return {
        content: 'I diagnosed the failing tests across all runs.'
      };
    }
  };

  const loop = new AgentLoop({
    cwd: tmpDir,
    autoApprove: true,
    provider: 'ollama', // Use local mode where limit is 5
    model: 'qwen2.5-coder:7b'
  }, renderer, mockProvider);

  await loop.run('Investigate 6 failing test commands');

  // Verify the loop completed all 6 turns without tripping the 5-failure circuit breaker
  const stats = loop.getStats();
  assert.equal(stats.toolCalls, 6);

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('Harness Hardening - Cloud mode allows model to continue after verification passes without premature block', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locode-cloud-verif-'));
  const renderer = new TerminalRenderer();
  const mockProvider = new MockLLMProvider();

  let turn = 0;
  mockProvider.chat = async () => {
    turn++;
    if (turn === 1) {
      // Step 1: Write file
      return {
        content: '',
        tool_calls: [{
          id: 'c1',
          type: 'function',
          function: { name: 'write_file', arguments: { path: 'a.txt', content: 'hello' } }
        }]
      };
    } else if (turn === 2) {
      // Step 2: Verification command
      return {
        content: '',
        tool_calls: [{
          id: 'c2',
          type: 'function',
          function: { name: 'run_command', arguments: { command: 'node -e "process.exit(0)"' } }
        }]
      };
    } else if (turn === 3) {
      // Step 3: Frontier model performs an additional check or writes another file
      return {
        content: '',
        tool_calls: [{
          id: 'c3',
          type: 'function',
          function: { name: 'write_file', arguments: { path: 'b.txt', content: 'world' } }
        }]
      };
    } else {
      return {
        content: 'Both files created and verified.'
      };
    }
  };

  const loop = new AgentLoop({
    cwd: tmpDir,
    autoApprove: true,
    provider: 'groq',
    model: 'qwen/qwen3.8-27b'
  }, renderer, mockProvider);

  await loop.run('Create two verified files');

  // Must have successfully executed all 3 tools without premature abort
  const stats = loop.getStats();
  assert.equal(stats.toolCalls, 3);
  assert.equal(stats.failedToolCalls, 0);

  const fileA = await fs.readFile(path.join(tmpDir, 'a.txt'), 'utf8');
  const fileB = await fs.readFile(path.join(tmpDir, 'b.txt'), 'utf8');
  assert.equal(fileA, 'hello');
  assert.equal(fileB, 'world');

  await fs.rm(tmpDir, { recursive: true, force: true });
});
