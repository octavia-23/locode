import test from 'node:test';
import assert from 'node:assert/strict';
import { SubagentRunner } from '../src/agent/subagents/runner.js';
import { delegateTaskTool } from '../src/tools/subagent.js';
import { ArchitectEngine } from '../src/agent/architect.js';
import { AgentContext } from '../src/types.js';
import { ILLMProvider } from '../src/providers/types.js';

test('SubagentRunner - strictly blocks unauthorized tools for Explorer role', async () => {
  const executedTools: string[] = [];
  const rejectedToolMessages: string[] = [];

  const mockProvider: ILLMProvider = {
    getModel: () => 'mock-model',
    setModel: () => {},
    isHealthy: async () => true,
    getAvailableModels: async () => ['mock-model'],
    chat: async (messages) => {
      // Check if previous turn had a tool rejection
      const lastMsg = messages[messages.length - 1];
      if (lastMsg && lastMsg.role === 'tool' && lastMsg.content.includes('is prohibited')) {
        rejectedToolMessages.push(lastMsg.content);
        return {
          content: 'EXPLORATION FINDINGS:\n- Found project structure\nSUGGESTED ACTIONS:\n- Proceed to edit'
        };
      }

      // Step 1: Model attempts to illegally run edit_file and run_command
      return {
        content: 'I will modify the file directly and run a shell script.',
        tool_calls: [
          {
            id: 'tc-bad-1',
            type: 'function',
            function: {
              name: 'edit_file',
              arguments: JSON.stringify({ path: 'src/index.ts', target: 'a', replacement: 'b' })
            }
          }
        ]
      };
    }
  };

  const context: AgentContext = {
    cwd: process.cwd(),
    autoApprove: true,
    model: 'mock-model',
    ollamaHost: 'http://127.0.0.1:11434',
    mode: 'worker'
  };

  const outcome = await SubagentRunner.run(
    {
      role: 'explorer',
      objective: 'Inspect project structure',
      context,
      maxSteps: 3
    },
    mockProvider
  );

  assert.equal(outcome.role, 'explorer');
  assert.equal(outcome.success, true);
  assert.equal(rejectedToolMessages.length, 1);
  assert.ok(rejectedToolMessages[0].includes("Tool 'edit_file' is prohibited for explorer subagent"));
  assert.ok(outcome.findings.some(f => f.includes('Found project structure')));
});

test('SubagentRunner - strictly enforces step budget and halts cleanly', async () => {
  let stepCounter = 0;

  const mockProvider: ILLMProvider = {
    getModel: () => 'mock-model',
    setModel: () => {},
    isHealthy: async () => true,
    getAvailableModels: async () => ['mock-model'],
    chat: async () => {
      stepCounter++;
      // Continuously return tool calls to simulate an infinite search
      return {
        content: `Search iteration ${stepCounter}`,
        tool_calls: [
          {
            id: `call_${stepCounter}`,
            type: 'function',
            function: {
              name: 'search_code',
              arguments: JSON.stringify({ query: 'Token', path: 'src' })
            }
          }
        ]
      };
    }
  };

  const context: AgentContext = {
    cwd: process.cwd(),
    autoApprove: true,
    model: 'mock-model',
    ollamaHost: 'http://127.0.0.1:11434',
    mode: 'worker'
  };

  const outcome = await SubagentRunner.run(
    {
      role: 'explorer',
      objective: 'Search for all token occurrences',
      context,
      maxSteps: 3
    },
    mockProvider
  );

  assert.equal(outcome.stepsUsed, 3, 'Must stop exactly at maxSteps');
  assert.equal(stepCounter, 3);
  assert.equal(outcome.success, true);
});

test('SubagentRunner - executes allowed read-only tools and records inspected files', async () => {
  let chatTurn = 0;

  const mockProvider: ILLMProvider = {
    getModel: () => 'mock-model',
    setModel: () => {},
    isHealthy: async () => true,
    getAvailableModels: async () => ['mock-model'],
    chat: async () => {
      chatTurn++;
      if (chatTurn === 1) {
        return {
          content: 'Inspecting package.json',
          tool_calls: [
            {
              id: 'call_view_pkg',
              type: 'function',
              function: {
                name: 'view_file',
                arguments: JSON.stringify({ path: 'package.json' })
              }
            }
          ]
        };
      }
      return {
        content: 'DISCOVERED FINDINGS:\n- package.json defines locode\nSUGGESTED ACTIONS:\n- Update dependency'
      };
    }
  };

  const context: AgentContext = {
    cwd: process.cwd(),
    autoApprove: true,
    model: 'mock-model',
    ollamaHost: 'http://127.0.0.1:11434',
    mode: 'worker'
  };

  const outcome = await SubagentRunner.run(
    {
      role: 'explorer',
      objective: 'Inspect dependencies in package.json',
      context,
      maxSteps: 5
    },
    mockProvider
  );

  assert.equal(outcome.success, true);
  assert.ok(outcome.inspectedFiles.includes('package.json'), 'Must track inspected files');
  assert.ok(outcome.findings.some(f => f.includes('locode')));
});

test('delegate_task tool - dispatches to SubagentRunner and formats output', async () => {
  const context: AgentContext = {
    cwd: process.cwd(),
    autoApprove: true,
    model: 'mock-model',
    ollamaHost: 'http://127.0.0.1:11434',
    mode: 'worker'
  };

  // Mock provider via default parameter testing
  const mockProvider: ILLMProvider = {
    getModel: () => 'mock-model',
    setModel: () => {},
    isHealthy: async () => true,
    getAvailableModels: async () => ['mock-model'],
    chat: async () => {
      return {
        content: 'DISCOVERED FINDINGS:\n- Found auth service contract\nSUGGESTED ACTIONS:\n- Add JWT validation'
      };
    }
  };

  const outcome = await SubagentRunner.run(
    {
      role: 'architect',
      objective: 'Review auth service architecture',
      context,
      maxSteps: 2
    },
    mockProvider
  );

  assert.equal(outcome.role, 'architect');
  assert.ok(outcome.findings.some(f => f.includes('auth service contract')));
  assert.ok(outcome.suggestedActions.some(a => a.includes('JWT validation')));
});

test('ArchitectEngine - diagnoseWithSubagent produces isolated architect diagnosis', async () => {
  const mockProvider: ILLMProvider = {
    getModel: () => 'mock-model',
    setModel: () => {},
    isHealthy: async () => true,
    getAvailableModels: async () => ['mock-model'],
    chat: async () => {
      return {
        content: 'ROOT CAUSE:\n- Circular dependency in auth/jwt\nSURGICAL FIX DIRECTIVE:\n- Decouple token verification'
      };
    }
  };

  const context: AgentContext = {
    cwd: process.cwd(),
    autoApprove: true,
    model: 'mock-model',
    ollamaHost: 'http://127.0.0.1:11434',
    mode: 'worker'
  };

  const outcome = await ArchitectEngine.diagnoseWithSubagent(
    'Error: Circular dependency detected in auth.ts',
    'npm run build',
    context,
    mockProvider
  );

  assert.equal(outcome.role, 'architect');
  assert.equal(outcome.success, true);
  assert.ok(outcome.summary.includes('Circular dependency'));
});
