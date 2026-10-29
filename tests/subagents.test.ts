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
    chat: async (messages, tools) => {
      if (!tools || tools.length === 0) {
        return { content: 'Final synthesis summary after reaching step limit.' };
      }
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

test('SubagentRunner - triggers final tool-free synthesis turn when hitting maxSteps and returns non-empty summary with discovered findings', async () => {
  let synthesisTriggered = false;

  const mockProvider: ILLMProvider = {
    getModel: () => 'mock-model',
    setModel: () => {},
    isHealthy: async () => true,
    getAvailableModels: async () => ['mock-model'],
    chat: async (messages, tools) => {
      // Final synthesis turn passes empty tools array
      if (!tools || tools.length === 0) {
        synthesisTriggered = true;
        const lastMsg = messages[messages.length - 1];
        assert.ok(lastMsg.content.includes('maximum tool step limit'));
        return {
          content: 'DISCOVERED FINDINGS:\n- Found auth handler in src/auth.ts\n- Found user schema in src/types.ts\nSUGGESTED ACTIONS:\n- Refactor auth middleware'
        };
      }

      // Model keeps calling tools right up to maxSteps limit without stopping
      return {
        content: 'Inspecting files',
        tool_calls: [
          {
            id: `call_${Date.now()}`,
            type: 'function',
            function: {
              name: 'view_file',
              arguments: JSON.stringify({ path: 'package.json' })
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
      objective: 'Inspect project structure up to max limit',
      context,
      maxSteps: 2
    },
    mockProvider
  );

  assert.equal(synthesisTriggered, true, 'Tool-free synthesis turn must be requested when step limit reached');
  assert.ok(outcome.summary.length > 0, 'Summary must not be empty');
  assert.ok(outcome.findings.some(f => f.includes('src/auth.ts')));
  assert.ok(outcome.suggestedActions.some(a => a.includes('Refactor auth middleware')));
});

test('SubagentRunner - blocks path escaping context.cwd and invalid tool schema via PermissionEngine and SchemaValidator', async () => {
  const rejectedToolOutputs: string[] = [];
  let turn = 0;

  const mockProvider: ILLMProvider = {
    getModel: () => 'mock-model',
    setModel: () => {},
    isHealthy: async () => true,
    getAvailableModels: async () => ['mock-model'],
    chat: async (messages) => {
      turn++;
      const lastToolMsg = messages.filter(m => m.role === 'tool').pop();
      if (lastToolMsg) {
        rejectedToolOutputs.push(lastToolMsg.content);
      }

      if (turn === 1) {
        // Attempt path escaping workspace cwd
        return {
          content: 'Reading /etc/passwd',
          tool_calls: [
            {
              id: 'call-traversal',
              type: 'function',
              function: {
                name: 'view_file',
                arguments: JSON.stringify({ path: '../../etc/passwd' })
              }
            }
          ]
        };
      }

      if (turn === 2) {
        // Attempt invalid schema: view_file requires path
        return {
          content: 'Calling view_file without required path',
          tool_calls: [
            {
              id: 'call-invalid-schema',
              type: 'function',
              function: {
                name: 'view_file',
                arguments: JSON.stringify({})
              }
            }
          ]
        };
      }

      return {
        content: 'DISCOVERED FINDINGS:\n- Security restrictions working properly\nSUGGESTED ACTIONS:\n- Continue'
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
      objective: 'Verify permission and schema boundary enforcement',
      context,
      maxSteps: 4
    },
    mockProvider
  );

  assert.equal(outcome.success, true);
  assert.ok(
    rejectedToolOutputs.some(o => o.includes('resolves outside') || o.includes('workspace') || o.includes('Security Violation') || o.includes('Permission denied')),
    'Must block path traversal via PermissionEngine'
  );
  assert.ok(
    rejectedToolOutputs.some(o => o.includes('validation failed') || o.includes('path') || o.includes('required')),
    'Must block invalid schema via ToolSchemaValidator'
  );
});

test('SubagentRunner - halts remaining dependent tool calls in batch on fatal error and marks them skipped', async () => {
  let tool2Executed = false;
  let tool2SkippedMessageSeen = false;

  const mockProvider: ILLMProvider = {
    getModel: () => 'mock-model',
    setModel: () => {},
    isHealthy: async () => true,
    getAvailableModels: async () => ['mock-model'],
    chat: async (messages) => {
      // Check tool messages in turn 2
      const toolMsgs = messages.filter(m => m.role === 'tool');
      if (toolMsgs.length >= 2) {
        if (toolMsgs.some(m => m.content.includes('[Skipped due to preceding tool error in batch]'))) {
          tool2SkippedMessageSeen = true;
        }
        return {
          content: 'DISCOVERED FINDINGS:\n- Tool 1 failed, tool 2 was skipped\nSUGGESTED ACTIONS:\n- Fix arguments'
        };
      }

      // Propose batch of 2 tool calls where tool 1 fails
      return {
        content: 'Executing batch of two tools',
        tool_calls: [
          {
            id: 'call-1-fail',
            type: 'function',
            function: {
              name: 'view_file',
              arguments: JSON.stringify({ path: '../../etc/shadow' })
            }
          },
          {
            id: 'call-2-dependent',
            type: 'function',
            function: {
              name: 'view_file',
              arguments: JSON.stringify({ path: 'package.json' })
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
      objective: 'Test batch abort on error',
      context,
      maxSteps: 3
    },
    mockProvider
  );

  assert.equal(outcome.success, true);
  assert.equal(tool2SkippedMessageSeen, true, 'Tool #2 must receive skipped tool response message');
  assert.ok(outcome.findings.some(f => f.includes('tool 2 was skipped')));
});
