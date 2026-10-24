import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt } from '../src/agent/prompt.js';
import {
  StagnationDetector,
  DEFAULT_STAGNATION_THRESHOLDS,
  CLOUD_STAGNATION_THRESHOLDS
} from '../src/agent/stagnation.js';
import { viewFileTool, batchReadFilesTool } from '../src/tools/file-ops.js';
import { isCloudProvider } from '../src/providers/factory.js';
import { AgentLoop } from '../src/agent/loop.js';
import { TerminalRenderer } from '../src/ui/renderer.js';
import { AgentContext } from '../src/types.js';
import { ILLMProvider } from '../src/providers/types.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

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

test('Prompt Profile - Cloud vs Local differentiation', async () => {
  const localPrompt = await buildSystemPrompt(process.cwd(), false);
  const cloudPrompt = await buildSystemPrompt(process.cwd(), true);

  // Local prompt must enforce the tight action-first clamp
  assert.ok(localPrompt.includes('STRICT ACTION-FIRST PRINCIPLE (MAX 2 READS BEFORE EDITING)'));
  assert.ok(localPrompt.includes('Local Quantized'));

  // Cloud prompt must loosen constraints and invite deep architectural reasoning
  assert.ok(cloudPrompt.includes('ARCHITECTURAL EXPLORATION & THOROUGH INVESTIGATION'));
  assert.ok(cloudPrompt.includes('Cloud Frontier'));
  assert.ok(!cloudPrompt.includes('MAX 2 READS BEFORE EDITING'));
  assert.ok(cloudPrompt.includes('abundant context window'));
});

test('StagnationDetector - Cloud thresholds permit extensive exploration without false stagnation', () => {
  const cloudDetector = new StagnationDetector(CLOUD_STAGNATION_THRESHOLDS);
  const localDetector = new StagnationDetector(DEFAULT_STAGNATION_THRESHOLDS);

  // Record 15 distinct read operations with unchanged workspace
  for (let i = 1; i <= 15; i++) {
    const step = {
      turn: i,
      toolCallId: `call-${i}`,
      normalizedTool: 'view_file',
      normalizedArgs: { path: `src/module${i}.ts` },
      resultFingerprint: `res-${i}`,
      workspaceFingerprint: 'unchanged-ws',
      isError: false
    };
    cloudDetector.recordStep(step);
    localDetector.recordStep(step);
  }

  // Local detector must flag stagnation at 8+ reads to protect small models
  const localDiag = localDetector.diagnose();
  assert.equal(localDiag.stagnated, true);
  assert.equal(localDiag.reason, 'INSPECTION_WITHOUT_ACTION');

  // Cloud detector must NOT flag stagnation on 15 reads (budget is 50)
  const cloudDiag = cloudDetector.diagnose();
  assert.equal(cloudDiag.stagnated, false);
});

test('StagnationDetector - Cloud still catches genuine infinite loops and cyclic traps', () => {
  const cloudDetector = new StagnationDetector(CLOUD_STAGNATION_THRESHOLDS);

  // Record 4 identical tool calls with identical args & result
  for (let i = 1; i <= 4; i++) {
    cloudDetector.recordStep({
      turn: i,
      toolCallId: `call-${i}`,
      normalizedTool: 'list_dir',
      normalizedArgs: { path: '.' },
      resultFingerprint: 'empty-dir',
      workspaceFingerprint: 'unchanged-ws',
      isError: false
    });
  }

  // Identical cycle must still be detected and stopped
  const diag = cloudDetector.diagnose();
  assert.equal(diag.stagnated, true);
  assert.equal(diag.reason, 'EQUIVALENT_TOOL_CALLS');
});

test('File Ops - view_file and batch_read expand windows in cloud mode', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locode-cloud-test-'));
  const testFile = path.join(tempDir, 'large.txt');
  
  // Generate 1,500 lines
  const lines = Array.from({ length: 1500 }, (_, i) => `Line ${i + 1}: const x = ${i};`);
  await fs.writeFile(testFile, lines.join('\n'), 'utf8');

  try {
    const localContext: AgentContext = {
      cwd: tempDir,
      model: 'qwen2.5-coder:7b',
      provider: 'ollama'
    };

    const cloudContext: AgentContext = {
      cwd: tempDir,
      model: 'gemini-3.6-flash',
      provider: 'gemini'
    };

    // 1. Local view_file defaults to 600 lines with large file warning
    const localRes = await viewFileTool.execute({ path: 'large.txt' }, localContext);
    assert.ok(localRes.result.includes('NOTICE: Large file (1500 lines)'));
    assert.ok(localRes.result.includes('lines 1-601 of 1500'));

    // 2. Local view_file with explicit high end_line caps window at 700 lines
    const localCappedRes = await viewFileTool.execute({ path: 'large.txt', end_line: 1200 }, localContext);
    assert.ok(localCappedRes.result.includes('Window capped at 700 lines'));
    assert.ok(localCappedRes.result.includes('lines 1-700 of 1500'));

    // 3. Cloud view_file shows all 1,500 lines cleanly without capping at 700 or shouting local warnings
    const cloudRes = await viewFileTool.execute({ path: 'large.txt' }, cloudContext);
    assert.ok(cloudRes.result.includes('lines 1-1500 of 1500'));
    assert.ok(!cloudRes.result.includes('NOTICE: Large file'));
    assert.ok(!cloudRes.result.includes('Window capped at 700 lines'));

    // 3. Batch read expands default lines
    const batchLocal = await batchReadFilesTool.execute({ paths: ['large.txt'] }, localContext);
    assert.ok(batchLocal.result.includes('200 of 1500 lines'));

    const batchCloud = await batchReadFilesTool.execute({ paths: ['large.txt'] }, cloudContext);
    assert.ok(batchCloud.result.includes('500 of 1500 lines'));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('AgentLoop - Configures cloud thresholds automatically when provider is cloud', () => {
  const renderer = new TerminalRenderer();

  const cloudLoop = new AgentLoop({
    cwd: process.cwd(),
    provider: 'gemini',
    model: 'gemini-3.6-flash'
  }, renderer, new MockLLMProvider('gemini-3.6-flash'));

  const localLoop = new AgentLoop({
    cwd: process.cwd(),
    provider: 'ollama',
    model: 'qwen2.5-coder:7b'
  }, renderer, new MockLLMProvider('qwen2.5-coder:7b'));

  const cloudThresholds = cloudLoop.getStagnationDetector().getThresholds();
  const localThresholds = localLoop.getStagnationDetector().getThresholds();

  assert.equal(cloudThresholds.maxInspectionsWithoutEdit, CLOUD_STAGNATION_THRESHOLDS.maxInspectionsWithoutEdit);
  assert.equal(localThresholds.maxInspectionsWithoutEdit, DEFAULT_STAGNATION_THRESHOLDS.maxInspectionsWithoutEdit);
  assert.equal(cloudThresholds.maxRecoveryAttempts, 4);
  assert.equal(localThresholds.maxRecoveryAttempts, 2);
});
