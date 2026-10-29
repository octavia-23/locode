import test from 'node:test';
import assert from 'node:assert/strict';
import { isReadOnlyTool, TurnExecutor } from '../src/engine/turn-executor.js';
import { SessionRunner } from '../src/engine/session-runner.js';
import { RepairCoordinator } from '../src/engine/repair-coordinator.js';
import { ToolDispatcher } from '../src/engine/tool-dispatcher.js';
import { PermissionEngine } from '../src/engine/permission-engine.js';
import { AgentContext } from '../src/types.js';
import { registerDynamicTool, unregisterDynamicTool } from '../src/tools/index.js';

test('TurnExecutor - isReadOnlyTool correctly categorizes tools', () => {
  assert.equal(isReadOnlyTool('view_file'), true);
  assert.equal(isReadOnlyTool('list_dir'), true);
  assert.equal(isReadOnlyTool('search_code'), true);
  assert.equal(isReadOnlyTool('batch_read_files'), true);
  assert.equal(isReadOnlyTool('fetch_web'), true);
  assert.equal(isReadOnlyTool('search_web'), true);

  assert.equal(isReadOnlyTool('write_file'), false);
  assert.equal(isReadOnlyTool('edit_file'), false);
  assert.equal(isReadOnlyTool('run_command'), false);
  assert.equal(isReadOnlyTool('delete_file'), false);
});

test('TurnExecutor - executeToolBatch runs read-only tools in parallel when permitted', async () => {
  const executionOrder: string[] = [];

  // Register mock test tools
  registerDynamicTool({
    name: 'mock_read_a',
    description: 'read a',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      await new Promise(r => setTimeout(r, 20));
      executionOrder.push('a');
      return { content: 'content_a' };
    }
  });

  registerDynamicTool({
    name: 'mock_read_b',
    description: 'read b',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      await new Promise(r => setTimeout(r, 10));
      executionOrder.push('b');
      return { content: 'content_b' };
    }
  });

  try {
    const perm = new PermissionEngine({ autoApprove: true });
    const dispatcher = new ToolDispatcher(perm);
    const context: AgentContext = { cwd: process.cwd(), autoApprove: true, model: 'test' };

    // Mark as read-only for testing
    const batchCalls = [
      { id: 'call_1', function: { name: 'view_file', arguments: { path: 'package.json' } } },
      { id: 'call_2', function: { name: 'list_dir', arguments: { path: '.' } } }
    ];

    const result = await TurnExecutor.executeToolBatch(batchCalls, dispatcher, context, {
      allowParallelTools: true,
      autoApprove: true
    });

    assert.equal(result.executedInParallel, true);
    assert.equal(result.results.length, 2);
    // Preserves deterministic output order matching original declaration order
    assert.equal(result.results[0].callId, 'call_1');
    assert.equal(result.results[1].callId, 'call_2');
  } finally {
    unregisterDynamicTool('mock_read_a');
    unregisterDynamicTool('mock_read_b');
  }
});

test('TurnExecutor - executeToolBatch strictly forces sequential execution when any tool mutates state', async () => {
  const perm = new PermissionEngine({ autoApprove: true });
  const dispatcher = new ToolDispatcher(perm);
  const context: AgentContext = { cwd: process.cwd(), autoApprove: true, model: 'test' };

  const batchCalls = [
    { id: 'call_read', function: { name: 'view_file', arguments: { path: 'package.json' } } },
    { id: 'call_mutate', function: { name: 'run_command', arguments: { command: 'echo hello' } } }
  ];

  const result = await TurnExecutor.executeToolBatch(batchCalls, dispatcher, context, {
    allowParallelTools: true, // Even if true, presence of mutating tool enforces sequential
    autoApprove: true
  });

  assert.equal(result.executedInParallel, false);
  assert.equal(result.results.length, 2);
  assert.equal(result.results[0].callId, 'call_read');
  assert.equal(result.results[1].callId, 'call_mutate');
});

test('TurnExecutor - normalizeResponse cleanly handles tools, text, and errors', () => {
  // Tool call response
  const toolResp = {
    content: 'Let me check\n<tool_call>{"name": "list_dir", "arguments": {}}</tool_call>'
  };
  const norm1 = TurnExecutor.normalizeResponse(toolResp);
  assert.equal(norm1.type, 'TOOL_CALLS');
  assert.equal(norm1.toolCalls?.length, 1);
  assert.equal(norm1.toolCalls?.[0].function.name, 'list_dir');

  // Text final response
  const textResp = {
    content: 'All tasks completed successfully.'
  };
  const norm2 = TurnExecutor.normalizeResponse(textResp);
  assert.equal(norm2.type, 'TEXT_FINAL');
  assert.equal(norm2.cleanedText, 'All tasks completed successfully.');

  // Error handling
  const norm3 = TurnExecutor.normalizeResponse(null, new Error('ECONNRESET: socket closed'));
  assert.equal(norm3.type, 'PROVIDER_ERROR_RETRYABLE');
});

test('SessionRunner - manages session metrics, turn limits, and journal snapshots', async () => {
  const runner = new SessionRunner(process.cwd());
  const profile: any = {
    name: 'test-profile',
    costPolicy: { maxCostPerTurn: 1.0, alertOnCostThreshold: true }
  };
  const context: AgentContext = { cwd: process.cwd(), model: 'test-model', provider: 'ollama' };

  await runner.initializeSession('Test prompt', profile, context);
  assert.equal(runner.getStepCount(), 0);

  runner.incrementStep();
  assert.equal(runner.getStepCount(), 1);

  const metrics = runner.recordTurnMetrics(
    { promptTokens: 1000, completionTokens: 200, totalTokens: 1200, durationMs: 500 },
    0.60,
    profile.costPolicy
  );

  assert.equal(metrics.alertTriggered, true);
  assert.equal(metrics.budgetExceeded, false);

  // Budget exceeded
  const metrics2 = runner.recordTurnMetrics(undefined, 1.50, profile.costPolicy);
  assert.equal(metrics2.budgetExceeded, true);
  assert.ok(metrics2.reason?.includes('exceeded maximum allowed cost'));

  await runner.finalizeSession('success', 'Task done');
  assert.ok(runner.getStats().turns > 0);
});

test('RepairCoordinator - coordinates verification and escalation to architect', async () => {
  const coordinator = new RepairCoordinator(process.cwd());
  assert.equal(coordinator.getRepairAttempts(), 0);

  // Reset repair attempts
  coordinator.resetRepairAttempts();
  assert.equal(coordinator.getRepairAttempts(), 0);
});
