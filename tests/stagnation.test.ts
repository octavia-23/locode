import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { AgentLoop } from '../src/agent/loop.js';
import { StagnationDetector, DEFAULT_STAGNATION_THRESHOLDS } from '../src/agent/stagnation.js';
import { TerminalRenderer } from '../src/ui/renderer.js';
import { AgentContext, ChatMessage, ToolDefinition } from '../src/types.js';
import { ILLMProvider, ChatProviderResponse } from '../src/providers/types.js';

class MockStagnationProvider implements ILLMProvider {
  private queue: Array<(messages: ChatMessage[]) => Promise<ChatProviderResponse> | ChatProviderResponse>;
  private model: string = 'mock-stagnation-llm';

  constructor(responses: Array<(messages: ChatMessage[]) => Promise<ChatProviderResponse> | ChatProviderResponse>) {
    this.queue = [...responses];
  }

  getModel(): string { return this.model; }
  setModel(m: string): void { this.model = m; }
  async isHealthy(): Promise<boolean> { return true; }
  async getAvailableModels(): Promise<string[]> { return [this.model]; }

  async chat(messages: ChatMessage[], tools: ToolDefinition[]): Promise<ChatProviderResponse> {
    const next = this.queue.shift();
    if (!next) {
      return { content: 'Default mock completion' };
    }
    return await next(messages);
  }
}

test('StagnationDetector - Unit detection of EQUIVALENT_TOOL_CALLS with unchanged workspace', async () => {
  const detector = new StagnationDetector({ maxEquivalentToolCalls: 3 });

  // Record 3 identical tool calls with identical result and unchanged workspace
  for (let i = 1; i <= 3; i++) {
    detector.recordStep({
      turn: i,
      toolCallId: `call-${i}`,
      normalizedTool: 'view_file',
      normalizedArgs: { path: 'src/app.ts' },
      resultFingerprint: 'res-hash-1',
      workspaceFingerprint: 'ws-hash-clean',
      isError: false
    });
  }

  const diag = detector.diagnose();
  assert.equal(diag.stagnated, true);
  assert.equal(diag.reason, 'EQUIVALENT_TOOL_CALLS');
  assert.ok(diag.summary.includes('view_file'));
  assert.equal(diag.evidence.length, 3);
});

test('StagnationDetector - Unit detection of INSPECTION_WITHOUT_ACTION', async () => {
  const detector = new StagnationDetector({ maxInspectionsWithoutEdit: 4 });

  const inspectTools = ['view_file', 'search_code', 'list_dir', 'batch_read_files'];
  for (let i = 0; i < 4; i++) {
    detector.recordStep({
      turn: i + 1,
      toolCallId: `inspect-${i}`,
      normalizedTool: inspectTools[i],
      normalizedArgs: { query: 'test' },
      resultFingerprint: `res-${i}`,
      workspaceFingerprint: 'ws-unchanged',
      isError: false
    });
  }

  const diag = detector.diagnose();
  assert.equal(diag.stagnated, true);
  assert.equal(diag.reason, 'INSPECTION_WITHOUT_ACTION');
});

test('StagnationDetector - Exploring distinct files does NOT trigger INSPECTION_WITHOUT_ACTION', async () => {
  const detector = new StagnationDetector({ maxInspectionsWithoutEdit: 8 });

  // 8 distinct files read across a repository (e.g. FlowForge benchmark)
  const distinctFiles = [
    'src/flowforge/graph.py',
    'src/flowforge/node.py',
    'src/flowforge/edge.py',
    'src/flowforge/engine.py',
    'src/flowforge/context.py',
    'src/flowforge/utils.py',
    'src/flowforge/types.py',
    'tests/test_graph.py'
  ];

  for (let i = 0; i < distinctFiles.length; i++) {
    detector.recordStep({
      turn: i + 1,
      toolCallId: `read-${i}`,
      normalizedTool: 'view_file',
      normalizedArgs: { path: distinctFiles[i] },
      resultFingerprint: `res-${i}`,
      workspaceFingerprint: 'ws-unchanged',
      isError: false
    });
  }

  const diag = detector.diagnose();
  assert.equal(diag.stagnated, false, 'Exploring distinct files should not trigger stagnation');
});

test('StagnationDetector - isContinuingStagnation allows inspecting unread file after inspection warning', async () => {
  const detector = new StagnationDetector({ maxInspectionsWithoutEdit: 4 });

  const records = [
    { tool: 'view_file', args: { path: 'src/repeated.py', start_line: 1 } },
    { tool: 'search_code', args: { query: 'foo', path: 'src/repeated.py' } },
    { tool: 'view_file', args: { path: 'src/repeated.py', start_line: 20 } },
    { tool: 'view_file', args: { path: 'src/repeated.py', start_line: 40 } }
  ];

  for (let i = 0; i < records.length; i++) {
    detector.recordStep({
      turn: i + 1,
      toolCallId: `read-${i}`,
      normalizedTool: records[i].tool,
      normalizedArgs: records[i].args,
      resultFingerprint: `res-${i}`,
      workspaceFingerprint: 'ws-unchanged',
      isError: false
    });
  }

  const diag = detector.diagnose();
  assert.equal(diag.stagnated, true);
  assert.equal(diag.reason, 'INSPECTION_WITHOUT_ACTION');

  // Attempting to re-read the same file IS continuing stagnation
  const isContinuingSame = detector.isContinuingStagnation([
    { function: { name: 'view_file', arguments: { path: 'src/repeated.py' } } }
  ]);
  assert.equal(isContinuingSame, true, 'Re-reading already inspected file is continuing stagnation');

  // Attempting to read a new, previously unread file is NOT continuing stagnation
  const isContinuingNew = detector.isContinuingStagnation([
    { function: { name: 'view_file', arguments: { path: 'src/remaining_source.py' } } }
  ]);
  assert.equal(isContinuingNew, false, 'Reading an unread file is allowed and does not continue stagnation');
});

test('StagnationDetector - Unit detection of UNCHANGED_TEST_FAILURE', async () => {
  const detector = new StagnationDetector({ maxUnchangedFailures: 3 });

  for (let i = 1; i <= 3; i++) {
    detector.recordStep({
      turn: i,
      toolCallId: `test-${i}`,
      normalizedTool: 'run_command',
      normalizedArgs: { command: 'npm test' },
      resultFingerprint: 'err-result-hash',
      workspaceFingerprint: 'ws-clean',
      isError: true,
      testOutcome: {
        passed: false,
        errorSignature: 'TypeError: Cannot read properties of undefined (reading foo)',
        command: 'npm test'
      }
    });
  }

  const diag = detector.diagnose();
  assert.equal(diag.stagnated, true);
  assert.equal(diag.reason, 'UNCHANGED_TEST_FAILURE');
  assert.ok(diag.evidence.length >= 3);
});

test('StagnationDetector - Legitimate repeated test after workspace edit does NOT stagnate', async () => {
  const detector = new StagnationDetector({ maxUnchangedFailures: 3 });

  // Test fails on workspace state 1
  detector.recordStep({
    turn: 1,
    toolCallId: 'test-1',
    normalizedTool: 'run_command',
    normalizedArgs: { command: 'npm test' },
    resultFingerprint: 'err-1',
    workspaceFingerprint: 'ws-state-1',
    isError: true,
    testOutcome: {
      passed: false,
      errorSignature: 'Error: missing feature',
      command: 'npm test'
    }
  });

  // Edit applied (workspace changes!)
  detector.recordStep({
    turn: 2,
    toolCallId: 'edit-1',
    normalizedTool: 'edit_file',
    normalizedArgs: { path: 'feature.ts' },
    resultFingerprint: 'ok-edit',
    workspaceFingerprint: 'ws-state-2',
    isError: false
  });

  // Test re-run passes!
  detector.recordStep({
    turn: 3,
    toolCallId: 'test-2',
    normalizedTool: 'run_command',
    normalizedArgs: { command: 'npm test' },
    resultFingerprint: 'pass-result',
    workspaceFingerprint: 'ws-state-2',
    isError: false,
    testOutcome: {
      passed: true,
      errorSignature: '',
      command: 'npm test'
    }
  });

  const diag = detector.diagnose();
  assert.equal(diag.stagnated, false, 'Legitimate verification rerun must not be flagged as stagnation');
});

test('Stagnation Integration - Scenario 1: Identical tool call repeated indefinitely triggers bounded recovery directive', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locode-adv-identical-'));
  try {
    const context: AgentContext = {
      cwd: tmpDir,
      autoApprove: true,
      model: 'mock-llm',
      ollamaHost: 'http://127.0.0.1:11434',
      stagnationThresholds: {
        maxEquivalentToolCalls: 3,
        maxRecoveryAttempts: 2
      }
    };

    let recoveryDirectiveSeen = false;

    // Model repeats run_command with identical arguments
    const responses: Array<(messages: ChatMessage[]) => ChatProviderResponse> = [
      () => ({
        content: 'Running check 1',
        tool_calls: [{ function: { name: 'run_command', arguments: { command: 'git status' } } }]
      }),
      () => ({
        content: 'Running check 2',
        tool_calls: [{ function: { name: 'run_command', arguments: { command: 'git status' } } }]
      }),
      () => ({
        content: 'Running check 3',
        tool_calls: [{ function: { name: 'run_command', arguments: { command: 'git status' } } }]
      }),
      () => ({
        content: 'Running check 4',
        tool_calls: [{ function: { name: 'run_command', arguments: { command: 'git status' } } }]
      }),
      (messages) => {
        const lastTool = messages.find(m => m.role === 'tool' && m.content.includes('[BOUNDED STAGNATION RECOVERY DIRECTIVE'));
        if (lastTool) {
          recoveryDirectiveSeen = true;
        }
        return {
          content: 'Stopping now that recovery directive was received.'
        };
      }
    ];

    const mockProvider = new MockStagnationProvider(responses);
    const renderer = new TerminalRenderer();
    const agent = new AgentLoop(context, renderer, mockProvider);
    await agent.init();

    await agent.run('Investigate repository status');

    assert.equal(recoveryDirectiveSeen, true, 'Model must receive bounded recovery directive on identical tool repetitions');
    const stats = agent.getStats();
    assert.ok(stats.progressLoopsDetected >= 1, 'Loop detection stat must increment');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('Stagnation Integration - Scenario 2: Recovery makes progress and completes successfully', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locode-adv-recovery-success-'));
  try {
    const context: AgentContext = {
      cwd: tmpDir,
      autoApprove: true,
      model: 'mock-llm',
      ollamaHost: 'http://127.0.0.1:11434',
      stagnationThresholds: {
        maxEquivalentToolCalls: 3,
        maxRecoveryAttempts: 2
      }
    };

    let recoveredAndApplied = false;

    const responses: Array<(messages: ChatMessage[]) => ChatProviderResponse> = [
      () => ({
        content: 'Check 1',
        tool_calls: [{ function: { name: 'run_command', arguments: { command: 'node -e "process.exit(1)"' } } }]
      }),
      () => ({
        content: 'Check 2',
        tool_calls: [{ function: { name: 'run_command', arguments: { command: 'node -e "process.exit(1)"' } } }]
      }),
      () => ({
        content: 'Check 3',
        tool_calls: [{ function: { name: 'run_command', arguments: { command: 'node -e "process.exit(1)"' } } }]
      }),
      // On turn 4, model attempts another failing check; stagnation detector intercepts with recovery directive:
      () => ({
        content: 'Check 4',
        tool_calls: [{ function: { name: 'run_command', arguments: { command: 'node -e "process.exit(1)"' } } }]
      }),
      // On turn 5, model receives recovery directive and applies alternative action (write_file):
      (messages) => {
        const lastTool = messages.find(m => m.role === 'tool' && m.content.includes('STAGNATION RECOVERY DIRECTIVE'));
        if (lastTool) {
          recoveredAndApplied = true;
        }
        return {
          content: 'I will write the solution file now.',
          tool_calls: [{
            function: {
              name: 'write_file',
              arguments: { path: 'solution.txt', content: 'resolved' }
            }
          }]
        };
      },
      // Final response after write_file execution:
      () => ({
        content: 'Task completed successfully after recovery.'
      })
    ];

    const mockProvider = new MockStagnationProvider(responses);
    const renderer = new TerminalRenderer();
    const agent = new AgentLoop(context, renderer, mockProvider);
    await agent.init();

    await agent.run('Resolve task');

    assert.equal(recoveredAndApplied, true, 'Agent must receive recovery directive and successfully take alternative action');
    const written = await fs.readFile(path.join(tmpDir, 'solution.txt'), 'utf8');
    assert.equal(written, 'resolved');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('Stagnation Integration - Scenario 3: Persistent stagnation cleanly terminates with diagnostic report after max recovery attempts', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locode-adv-stuck-terminate-'));
  try {
    const context: AgentContext = {
      cwd: tmpDir,
      autoApprove: true,
      model: 'mock-llm',
      ollamaHost: 'http://127.0.0.1:11434',
      stagnationThresholds: {
        maxEquivalentToolCalls: 2,
        maxRecoveryAttempts: 2
      }
    };

    // Model repeats list_dir stubbornly across all recovery attempts
    const responses: Array<() => ChatProviderResponse> = [];
    for (let i = 0; i < 8; i++) {
      responses.push(() => ({
        content: `Stubborn attempt ${i}`,
        tool_calls: [{ function: { name: 'list_dir', arguments: { path: '.' } } }]
      }));
    }

    const mockProvider = new MockStagnationProvider(responses);
    const renderer = new TerminalRenderer();
    const agent = new AgentLoop(context, renderer, mockProvider);
    await agent.init();

    // Must cleanly terminate rather than running indefinitely
    await agent.run('Run until termination');

    const messages = agent.getMessages();
    const terminationMsg = messages.find(m => m.role === 'assistant' && typeof m.content === 'string' && m.content.includes('[STAGNATION TERMINATION REPORT]'));
    assert.ok(terminationMsg, 'Agent must emit clean stagnation termination report with evidence when recovery attempts are exhausted');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('Stagnation Integration - Scenario 4: Context compaction preserves conversation while stagnation detector continues tracking', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locode-adv-compaction-'));
  try {
    // Low context window to force compaction
    const context: AgentContext = {
      cwd: tmpDir,
      autoApprove: true,
      model: 'mock-llm',
      numCtx: 1024,
      ollamaHost: 'http://127.0.0.1:11434'
    };

    const responses: Array<() => ChatProviderResponse> = [
      () => ({
        content: 'Step 1: Write file a',
        tool_calls: [{ function: { name: 'write_file', arguments: { path: 'a.txt', content: 'A'.repeat(500) } } }]
      }),
      () => ({
        content: 'Step 2: Write file b',
        tool_calls: [{ function: { name: 'write_file', arguments: { path: 'b.txt', content: 'B'.repeat(500) } } }]
      }),
      () => ({
        content: 'Step 3: Done'
      })
    ];

    const mockProvider = new MockStagnationProvider(responses);
    const renderer = new TerminalRenderer();
    const agent = new AgentLoop(context, renderer, mockProvider);
    await agent.init();

    await agent.run('Create files a and b under tight token limit');

    const history = agent.getStagnationDetector().getHistory();
    assert.ok(history.length >= 2, 'StagnationDetector must retain signal history across message compactions');
    const fileA = await fs.readFile(path.join(tmpDir, 'a.txt'), 'utf8');
    assert.equal(fileA, 'A'.repeat(500));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('Stagnation Integration - Scenario 5: Clean productive workflow finishes without triggering stagnation detector', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locode-adv-clean-pass-'));
  try {
    const context: AgentContext = {
      cwd: tmpDir,
      autoApprove: true,
      model: 'mock-llm',
      ollamaHost: 'http://127.0.0.1:11434'
    };

    const targetFile = 'calc.js';
    await fs.writeFile(path.join(tmpDir, targetFile), 'function add(a, b) { return 0; }', 'utf8');

    const responses: Array<() => ChatProviderResponse> = [
      () => ({
        content: 'Reading existing calc implementation',
        tool_calls: [{ function: { name: 'view_file', arguments: { path: targetFile } } }]
      }),
      () => ({
        content: 'Fixing add function',
        tool_calls: [{
          function: {
            name: 'edit_file',
            arguments: {
              path: targetFile,
              target_content: 'return 0;',
              replacement_content: 'return a + b;'
            }
          }
        }]
      }),
      () => ({
        content: 'Calculations are fixed and verified.'
      })
    ];

    const mockProvider = new MockStagnationProvider(responses);
    const renderer = new TerminalRenderer();
    const agent = new AgentLoop(context, renderer, mockProvider);
    await agent.init();

    await agent.run('Fix calc.js add function');

    const stats = agent.getStats();
    assert.equal(stats.progressLoopsDetected, 0, 'No loops should be detected for legitimate progressive workflow');
    assert.equal(stats.failedToolCalls, 0, 'No tool failures should occur');
    const updated = await fs.readFile(path.join(tmpDir, targetFile), 'utf8');
    assert.ok(updated.includes('return a + b;'));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('StagnationDetector - 12 distinct inspections trigger the reachable high-volume guard', () => {
  const detector = new StagnationDetector({ maxInspectionsWithoutEdit: 8 });
  for (let i = 0; i < 12; i++) {
    detector.recordStep({
      turn: i + 1,
      toolCallId: `unique-read-${i}`,
      normalizedTool: 'view_file',
      normalizedArgs: { path: `src/file-${i}.ts` },
      resultFingerprint: `result-${i}`,
      workspaceFingerprint: 'unchanged-workspace',
      isError: false
    });
  }

  const diagnosis = detector.diagnose();
  assert.equal(diagnosis.stagnated, true);
  assert.equal(diagnosis.reason, 'INSPECTION_WITHOUT_ACTION');
  assert.equal(diagnosis.evidence.length, 12, 'Evidence should describe the full high-volume inspection window');
});

test('StagnationDetector - workspace fingerprint changes when same-size source content changes outside git', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locode-workspace-fingerprint-'));
  try {
    const filePath = path.join(tmpDir, 'source.ts');
    await fs.writeFile(filePath, 'const a = 1;\n', 'utf8');
    const before = await StagnationDetector.computeWorkspaceFingerprint(tmpDir);
    await fs.writeFile(filePath, 'const b = 1;\n', 'utf8');
    const after = await StagnationDetector.computeWorkspaceFingerprint(tmpDir);

    assert.notEqual(before, after, 'Fingerprint must track content, not only status or line counts');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});


test('StagnationDetector - git workspace fingerprint catches same-line-count tracked edits', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locode-git-fingerprint-'));
  try {
    try {
      execFileSync('git', ['init'], { cwd: tmpDir, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.email', 'locode-test@example.invalid'], { cwd: tmpDir, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.name', 'Locode Test'], { cwd: tmpDir, stdio: 'ignore' });
    } catch {
      t.skip('Git is not available in this environment');
      return;
    }

    const filePath = path.join(tmpDir, 'source.ts');
    await fs.writeFile(filePath, 'const a = 1;\n', 'utf8');
    execFileSync('git', ['add', 'source.ts'], { cwd: tmpDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: tmpDir, stdio: 'ignore' });
    const before = await StagnationDetector.computeWorkspaceFingerprint(tmpDir);

    // Same number of lines and same character count: diff --stat alone cannot distinguish it.
    await fs.writeFile(filePath, 'const b = 1;\n', 'utf8');
    const after = await StagnationDetector.computeWorkspaceFingerprint(tmpDir);
    assert.notEqual(before, after, 'Tracked content changes must alter the workspace fingerprint');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});
