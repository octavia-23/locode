import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { ExecutionJournal } from '../src/journal/journal.js';
import { JournalRecoveryManager } from '../src/journal/recovery.js';
import { CURRENT_JOURNAL_VERSION } from '../src/journal/types.js';
import { estimatePreflightCost } from '../src/runtime/pricing.js';
import {
  isSensitiveFile,
  isSensitiveKeyName,
  redactStructuredContent,
  redactSensitiveFileContent
} from '../src/utils/secret-redactor.js';
import { AgentLoop } from '../src/agent/loop.js';
import { AgentContext, ChatMessage } from '../src/types.js';
import { TerminalRenderer } from '../src/ui/renderer.js';
import { ILLMProvider, ChatProviderResponse, ModelCapabilities } from '../src/providers/types.js';

class MockRecoveryProvider implements ILLMProvider {
  name = 'mock-recovery-provider';
  private responses: Array<(messages: ChatMessage[]) => ChatProviderResponse>;
  private callIdx = 0;

  constructor(responses: Array<(messages: ChatMessage[]) => ChatProviderResponse>) {
    this.responses = responses;
  }

  async chat(
    messages: ChatMessage[],
    _tools?: any[],
    _onStream?: (chunk: string) => void,
    _options?: any
  ): Promise<ChatProviderResponse> {
    if (this.callIdx < this.responses.length) {
      const resp = this.responses[this.callIdx++](messages);
      return resp;
    }
    return { content: 'Default response' };
  }

  async testConnection(): Promise<boolean> {
    return true;
  }

  setModel(_model: string): void {}

  getModelCapabilities(): ModelCapabilities {
    return {
      supportsTools: true,
      supportsStreaming: true,
      contextWindow: 32768,
      defaultOutputTokens: 4096
    };
  }
}

// ============================================================================
// Phase 0: Policy Defects - Preflight Spending Controls & Secret Protection
// ============================================================================

test('Phase 0 - Preflight Spending Control: blocks expensive turns before request dispatch', () => {
  // With known pricing for claude-3-5-sonnet: $3.00/M in, $15.00/M out
  const estPromptTokens = 100_000;
  const projectedOutputTokens = 8_192;
  const currentTurnCost = 0.50; // already spent $0.50
  const maxCostPerTurn = 0.80;

  // Projected additional cost: (100000*3 + 8192*15)/1e6 = 0.30 + 0.12288 = $0.42288
  // Total projected turn cost: 0.50 + 0.42288 = $0.92288 > $0.80 limit
  const estimate = estimatePreflightCost(
    estPromptTokens,
    projectedOutputTokens,
    currentTurnCost,
    'claude-3-5-sonnet',
    'anthropic',
    maxCostPerTurn
  );

  assert.equal(estimate.isKnown, true);
  assert.equal(estimate.isExceeded, true);
  assert.ok(estimate.projectedTurnCost > maxCostPerTurn);
  assert.ok(estimate.reason?.includes('exceed maximum allowed spend per turn'));
});

test('Phase 0 - Preflight Spending Control: allows turns within configured limit', () => {
  const estimate = estimatePreflightCost(
    1000,
    1000,
    0.0,
    'claude-3-5-sonnet',
    'anthropic',
    1.00
  );

  assert.equal(estimate.isKnown, true);
  assert.equal(estimate.isExceeded, false);
  assert.ok(estimate.projectedTurnCost < 1.00);
});

test('Phase 0 - Preflight Spending Control: handles unknown pricing honestly without fabricating cost', () => {
  const estimate = estimatePreflightCost(
    50000,
    4096,
    0.0,
    'custom-private-cloud-model',
    'custom-provider',
    0.50
  );

  assert.equal(estimate.isKnown, false);
  assert.equal(estimate.isExceeded, false);
  assert.equal(estimate.projectedTurnCost, undefined);
  assert.ok(estimate.reason?.includes('Pricing is unknown'));
});

test('Phase 0 - Secret Protection: recognizes sensitive filenames and filepaths', () => {
  assert.equal(isSensitiveFile('.env'), true);
  assert.equal(isSensitiveFile('.env.production'), true);
  assert.equal(isSensitiveFile('credentials.json'), true);
  assert.equal(isSensitiveFile('client_secret.json'), true);
  assert.equal(isSensitiveFile('server.key'), true);
  assert.equal(isSensitiveFile('cert.pem'), true);
  assert.equal(isSensitiveFile('.npmrc'), true);
  assert.equal(isSensitiveFile('/home/user/.aws/credentials'), true);

  assert.equal(isSensitiveFile('index.ts'), false);
  assert.equal(isSensitiveFile('package.json'), false);
  assert.equal(isSensitiveFile('README.md'), false);
});

test('Phase 0 - Secret Protection: redacts structured key-value and JSON credentials beyond regex patterns', () => {
  // Construct dynamic key to avoid literal scanner matches
  const customDbSecret = ['MyCustom', 'RandomDbPass', '987654321'].join('_');
  const customApiKey = ['my_custom_provider_key', 'abcdef123456'].join('_');

  const envFile = [
    'DATABASE_URL=postgres://localhost:5432/db',
    `DATABASE_PASSWORD=${customDbSecret}`,
    `APP_SECRET_KEY="${customApiKey}"`,
    'PUBLIC_SETTING=true'
  ].join('\n');

  const redactedEnv = redactSensitiveFileContent('.env', envFile);
  assert.ok(!redactedEnv.includes(customDbSecret), 'Database password must be redacted');
  assert.ok(!redactedEnv.includes(customApiKey), 'App secret key must be redacted');
  assert.ok(redactedEnv.includes('PUBLIC_SETTING=true'), 'Non-sensitive config must be preserved');
  assert.ok(redactedEnv.includes('[REDACTED_SECRET]'), 'Must contain redaction token');

  const jsonConfig = JSON.stringify({
    server: 'api.example.com',
    auth: {
      client_secret: customDbSecret,
      access_token: customApiKey,
      timeout_ms: 5000
    }
  });

  const redactedJson = redactSensitiveFileContent('credentials.json', jsonConfig);
  assert.ok(!redactedJson.includes(customDbSecret), 'JSON client_secret must be redacted');
  assert.ok(!redactedJson.includes(customApiKey), 'JSON access_token must be redacted');
  assert.ok(redactedJson.includes('5000'), 'Non-sensitive numbers must be preserved');
});

// ============================================================================
// Phase 1 & 2: Durable Execution Journal Core Functionality
// ============================================================================

test('Phase 1 & 2 - ExecutionJournal: records append-only events with atomic snapshots and redacts secrets', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locode-journal-test-'));
  try {
    const journal = new ExecutionJournal({ cwd: tmpDir });
    await journal.init();

    const mockApiKey = ['sk', 'ant', 'api03', 'supersecretkey1234567890abcdef'].join('-');

    // 1. Record task started
    await journal.recordEvent('task_started', {
      objective: 'Refactor auth controller',
      model: 'mock-model',
      provider: 'anthropic',
      executionProfile: { safetyCeiling: 25 },
      cwd: tmpDir
    });

    // 2. Record tool proposal with secret arguments
    await journal.recordEvent('tool_call_proposed', {
      toolCallId: 'call_1',
      toolName: 'write_file',
      arguments: {
        path: '.env',
        content: `API_KEY=${mockApiKey}\nDEBUG=true`
      }
    }, 'call_1');

    // 3. Verify event was persisted to journal.jsonl and secrets were redacted
    const events = await journal.readEvents();
    assert.equal(events.length, 2);
    assert.equal(events[0].type, 'task_started');
    assert.equal(events[1].type, 'tool_call_proposed');
    assert.equal(events[1].toolCallId, 'call_1');

    const jsonlContent = await fs.readFile(journal.getJournalFilePath(), 'utf8');
    assert.ok(!jsonlContent.includes(mockApiKey), 'Journal file must never persist raw secrets');
    assert.ok(jsonlContent.includes('[REDACTED_SECRET]'), 'Journal file must redact sensitive keys');

    // 4. Create atomic snapshot
    const snapshot = await journal.createSnapshot({
      pendingObjectives: ['Step 2: Add validation'],
      completedObjectives: ['Step 1: Setup'],
      decisions: ['Use Argon2 hashing']
    });

    assert.equal(snapshot.version, CURRENT_JOURNAL_VERSION);
    assert.equal(snapshot.lastSeq, 2);
    assert.equal(snapshot.pendingObjectives[0], 'Step 2: Add validation');
    assert.equal(snapshot.decisions[0], 'Use Argon2 hashing');

    // 5. Verify snapshot file was persisted
    const loadedSnapshot = await journal.readSnapshot();
    assert.ok(loadedSnapshot !== null);
    assert.equal(loadedSnapshot?.lastSeq, 2);
    assert.equal(loadedSnapshot?.toolCalls['call_1'].proposed, true);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

// ============================================================================
// Phase 3 & 4: Crash Simulation and Failure Recovery
// ============================================================================

test('Phase 4 - Interruption after model proposes tool call before execution', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locode-crash-proposed-'));
  try {
    const journal = new ExecutionJournal({ cwd: tmpDir });
    await journal.init();

    await journal.recordEvent('task_started', {
      objective: 'Update dependencies',
      model: 'mock-model',
      provider: 'ollama',
      executionProfile: {},
      cwd: tmpDir
    });

    // Model proposes a tool call, then process is killed immediately before execution
    await journal.recordEvent('tool_call_proposed', {
      toolCallId: 'call_crash_1',
      toolName: 'edit_file',
      arguments: { path: 'package.json', target_content: '1.0.0', replacement_content: '1.0.1' }
    }, 'call_crash_1');

    await journal.createSnapshot();

    // Inspect at restart
    const recoveryManager = new JournalRecoveryManager(tmpDir);
    const report = await recoveryManager.inspectWorkspaceAndJournal();

    assert.equal(report.hasJournal, true);
    assert.equal(report.reconciledTools.length, 1);
    const toolRec = report.reconciledTools[0];
    assert.equal(toolRec.toolCallId, 'call_crash_1');
    assert.equal(toolRec.resolution, 'unexecuted');
    assert.equal(toolRec.requiresUserConfirmation, false);
    assert.equal(report.canSafelyResume, true, 'Unexecuted proposal can safely resume without duplication');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('Phase 4 - Interruption after edit changes file but before tool result is persisted', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locode-crash-mid-edit-'));
  try {
    const filePath = 'config.json';
    const initialContent = JSON.stringify({ version: '1.0' });
    const updatedContent = JSON.stringify({ version: '2.0' });
    await fs.writeFile(path.join(tmpDir, filePath), initialContent, 'utf8');

    const beforeHash = crypto.createHash('sha256').update(initialContent).digest('hex');
    const afterHash = crypto.createHash('sha256').update(updatedContent).digest('hex');

    const journal = new ExecutionJournal({ cwd: tmpDir });
    await journal.init();

    await journal.recordEvent('task_started', {
      objective: 'Bump config version',
      model: 'mock-model',
      provider: 'ollama',
      executionProfile: {},
      cwd: tmpDir
    });

    await journal.recordEvent('tool_call_proposed', {
      toolCallId: 'call_edit_1',
      toolName: 'edit_file',
      arguments: { path: filePath }
    }, 'call_edit_1');

    await journal.recordEvent('tool_execution_started', {
      toolCallId: 'call_edit_1',
      toolName: 'edit_file',
      startTime: Date.now()
    }, 'call_edit_1');

    // Simulate edit writing to disk
    await fs.writeFile(path.join(tmpDir, filePath), updatedContent, 'utf8');

    // Record file change with confirmed afterHash, but process crashes before tool_execution_completed
    await journal.recordEvent('file_change_recorded', {
      toolCallId: 'call_edit_1',
      path: filePath,
      beforeHash,
      afterHash,
      changed: true
    }, 'call_edit_1');

    await journal.createSnapshot();

    // Inspect at restart
    const recoveryManager = new JournalRecoveryManager(tmpDir);
    const report = await recoveryManager.inspectWorkspaceAndJournal();

    assert.equal(report.reconciledTools.length, 1);
    const toolRec = report.reconciledTools[0];
    assert.equal(toolRec.toolCallId, 'call_edit_1');
    assert.equal(toolRec.resolution, 'applied_verified');
    assert.equal(toolRec.requiresUserConfirmation, false);
    assert.ok(toolRec.details.includes('mutation completed on disk before process crash'));
    assert.equal(report.canSafelyResume, true, 'Verified applied mutation does not duplicate edit');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('Phase 4 - Interruption during non-idempotent shell command execution is NEVER blindly replayed', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locode-crash-cmd-'));
  try {
    const journal = new ExecutionJournal({ cwd: tmpDir });
    await journal.init();

    await journal.recordEvent('task_started', {
      objective: 'Run migration',
      model: 'mock-model',
      provider: 'ollama',
      executionProfile: {},
      cwd: tmpDir
    });

    await journal.recordEvent('tool_call_proposed', {
      toolCallId: 'call_cmd_1',
      toolName: 'run_command',
      arguments: { command: 'npm run migrate:database' }
    }, 'call_cmd_1');

    // Command started running, then process crashed / killed before completion
    await journal.recordEvent('tool_execution_started', {
      toolCallId: 'call_cmd_1',
      toolName: 'run_command',
      startTime: Date.now()
    }, 'call_cmd_1');

    await journal.createSnapshot();

    const recoveryManager = new JournalRecoveryManager(tmpDir);
    const report = await recoveryManager.inspectWorkspaceAndJournal();

    assert.equal(report.reconciledTools.length, 1);
    const toolRec = report.reconciledTools[0];
    assert.equal(toolRec.toolCallId, 'call_cmd_1');
    assert.equal(toolRec.resolution, 'uncertain_non_idempotent');
    assert.equal(toolRec.requiresUserConfirmation, true, 'Non-idempotent command requires user confirmation');
    assert.equal(report.canSafelyResume, false, 'Cannot automatically resume when uncertain shell command was interrupted');
    assert.equal(report.recommendation, 'reconcile_with_user');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('Phase 4 - Interruption during verification does not report unverified work as complete', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locode-crash-verif-'));
  try {
    const journal = new ExecutionJournal({ cwd: tmpDir });
    await journal.init();

    await journal.recordEvent('task_started', {
      objective: 'Implement feature',
      model: 'mock-model',
      provider: 'ollama',
      executionProfile: {},
      cwd: tmpDir
    });

    // An earlier verification failed
    await journal.recordEvent('verification_completed', {
      command: 'npm test',
      category: 'test',
      status: 'failed',
      passed: false,
      summary: '1 test failed'
    });

    await journal.createSnapshot();

    const recoveryManager = new JournalRecoveryManager(tmpDir);
    const report = await recoveryManager.inspectWorkspaceAndJournal();

    assert.ok(report.lastVerification !== undefined);
    assert.equal(report.lastVerification?.status, 'failed');
    assert.equal(report.lastVerification?.passed, false);
    assert.equal(report.lastVerification?.summary, '1 test failed');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('Phase 4 - Tolerates corrupted or partial journal writes without treating missing info as success', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locode-corrupt-journal-'));
  try {
    const journal = new ExecutionJournal({ cwd: tmpDir });
    await journal.init();

    await journal.recordEvent('task_started', {
      objective: 'Task with abrupt power kill',
      model: 'mock-model',
      provider: 'ollama',
      executionProfile: {},
      cwd: tmpDir
    });

    // Simulate sudden power kill during write: append a half-written, malformed JSON line
    await fs.appendFile(
      journal.getJournalFilePath(),
      '{"version":1,"seq":2,"type":"tool_call_proposed","payloa\n',
      'utf8'
    );

    // Read events back
    const events = await journal.readEvents();
    assert.equal(events.length, 1, 'Corrupted line must be discarded safely');
    assert.equal(events[0].seq, 1);
    assert.equal(events[0].type, 'task_started');

    const recoveryManager = new JournalRecoveryManager(tmpDir);
    const report = await recoveryManager.inspectWorkspaceAndJournal();
    assert.equal(report.hasJournal, true);
    assert.equal(report.snapshot?.lastSeq, 1);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('Phase 4 - Detects workspace file hash divergence at restart', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locode-divergence-'));
  try {
    const filePath = 'index.ts';
    const confirmedContent = 'export const x = 1;';
    await fs.writeFile(path.join(tmpDir, filePath), confirmedContent, 'utf8');
    const confirmedHash = crypto.createHash('sha256').update(confirmedContent).digest('hex');

    const journal = new ExecutionJournal({ cwd: tmpDir });
    await journal.init();

    await journal.recordEvent('task_started', {
      objective: 'Track state',
      model: 'mock-model',
      provider: 'ollama',
      executionProfile: {},
      cwd: tmpDir
    });

    await journal.recordEvent('file_change_recorded', {
      path: filePath,
      afterHash: confirmedHash,
      changed: true
    });

    await journal.recordEvent('verification_completed', {
      command: 'npm test',
      category: 'test',
      status: 'passed',
      passed: true,
      summary: 'Tests passed'
    });

    await journal.createSnapshot();

    // External change made while Locode was not running:
    await fs.writeFile(path.join(tmpDir, filePath), 'export const x = 999; // external edit', 'utf8');

    const recoveryManager = new JournalRecoveryManager(tmpDir);
    const report = await recoveryManager.inspectWorkspaceAndJournal();

    assert.equal(report.divergences.length, 1);
    assert.ok(report.divergences[0].includes('hash diverged'));
    assert.equal(report.canSafelyResume, false);
    assert.equal(report.recommendation, 'reconcile_with_user');
    assert.equal(report.lastVerification?.isValid, false, 'Prior verification must be invalidated by external divergence');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('Phase 4 - End-to-end crash recovery restores objectives and profile into agent', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locode-e2e-recovery-'));
  try {
    const journal = new ExecutionJournal({ cwd: tmpDir });
    await journal.init();

    await journal.recordEvent('task_started', {
      objective: 'Refactor database models',
      model: 'mock-recovery-model',
      provider: 'ollama',
      executionProfile: {
        safetyCeiling: 42,
        privacyPolicy: { allowWebAccess: false, allowFullRepoContext: false }
      },
      cwd: tmpDir
    });

    await journal.createSnapshot({
      pendingObjectives: ['Add foreign keys', 'Write migration'],
      completedObjectives: ['Design schema'],
      decisions: ['Use UUID v4 for primary keys']
    });

    // Start a fresh AgentLoop in the same directory
    const context: AgentContext = {
      cwd: tmpDir,
      model: 'mock-recovery-model',
      autoApprove: true
    };
    const renderer = new TerminalRenderer();
    const provider = new MockRecoveryProvider([() => ({ content: 'Resuming work' })]);
    const agent = new AgentLoop(context, renderer, provider);
    await agent.init();

    // Recover state
    const recoveryManager = new JournalRecoveryManager(tmpDir);
    const report = await recoveryManager.inspectWorkspaceAndJournal();

    assert.equal(report.canSafelyResume, true);
    const applied = await recoveryManager.applyRecoveryToAgent(agent, report);
    assert.equal(applied, true);

    // Verify agent state was restored from journal snapshot
    assert.equal(agent.getExecutionProfile().safetyCeiling, 42);
    assert.equal(agent.getExecutionProfile().privacyPolicy.allowWebAccess, false);
    assert.equal(agent.getContextEngine().getTaskState().objective, 'Refactor database models');
    assert.ok(agent.getContextEngine().getTaskState().decisions.includes('Use UUID v4 for primary keys'));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});
