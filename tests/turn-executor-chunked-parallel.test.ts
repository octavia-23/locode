import test from 'node:test';
import assert from 'node:assert/strict';
import { TurnExecutor } from '../src/engine/turn-executor.js';
import { ToolDispatcher } from '../src/engine/tool-dispatcher.js';
import { PermissionEngine } from '../src/engine/permission-engine.js';
import { registerDynamicTool, unregisterDynamicTools } from '../src/tools/index.js';
import { AgentContext } from '../src/types.js';

test('TurnExecutor - mixed batch executes consecutive read-only tools concurrently in cloud mode', async () => {
  const perm = new PermissionEngine({ autoApprove: true });
  const dispatcher = new ToolDispatcher(perm);
  const context: AgentContext = { cwd: process.cwd(), autoApprove: true, model: 'test' };

  let read1Started = 0;
  let read1Finished = 0;
  let read2Started = 0;
  let read2Finished = 0;
  let mutateExecuted = false;

  registerDynamicTool({
    name: 'view_file_mock_a',
    description: 'Read tool A',
    parameters: { type: 'object', properties: {} },
    isReadOnly: true,
    execute: async () => {
      read1Started = Date.now();
      await new Promise(r => setTimeout(r, 40));
      read1Finished = Date.now();
      return 'read-a-done';
    }
  } as any);

  registerDynamicTool({
    name: 'view_file_mock_b',
    description: 'Read tool B',
    parameters: { type: 'object', properties: {} },
    isReadOnly: true,
    execute: async () => {
      read2Started = Date.now();
      await new Promise(r => setTimeout(r, 40));
      read2Finished = Date.now();
      return 'read-b-done';
    }
  } as any);

  registerDynamicTool({
    name: 'edit_file_mock_c',
    description: 'Mutate tool C',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      mutateExecuted = true;
      return 'mutate-c-done';
    }
  });

  try {
    const executor = new TurnExecutor(dispatcher, perm);
    const turnResult = await executor.executeTurnBatch(
      [
        { id: 'c1', function: { name: 'view_file_mock_a', arguments: {} } },
        { id: 'c2', function: { name: 'view_file_mock_b', arguments: {} } },
        { id: 'c3', function: { name: 'edit_file_mock_c', arguments: {} } }
      ],
      context,
      {
        stepCount: 1,
        userInput: 'inspect files and update',
        allowParallelTools: true,
        profile: {
          name: 'cloud-frontier',
          mode: 'cloud',
          safetyCeiling: 100,
          maxExplorationReads: 25,
          forceMutationAfterReads: false,
          allowParallelTools: true,
          enableThinking: true,
          privacyPolicy: { allowFullRepoContext: false, allowWebAccess: true, redactSecrets: false },
          costPolicy: {},
          timeoutMs: 60000
        }
      }
    );

    assert.equal(turnResult.results.length, 3);
    assert.equal(turnResult.results[0].toolName, 'view_file_mock_a');
    assert.equal(turnResult.results[1].toolName, 'view_file_mock_b');
    assert.equal(turnResult.results[2].toolName, 'edit_file_mock_c');
    assert.equal(mutateExecuted, true);

    // Verify read1 and read2 ran concurrently: start times within 25ms of each other
    assert.ok(Math.abs(read1Started - read2Started) < 30, 'Read tools started concurrently');
  } finally {
    unregisterDynamicTools(['view_file_mock_a', 'view_file_mock_b', 'edit_file_mock_c']);
  }
});
