import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { loadProjectRules, buildSystemPrompt } from '../src/agent/prompt.js';
import { loadOpenCodeConfig } from '../src/utils/config.js';
import { AgentLoop } from '../src/agent/loop.js';
import { ILLMProvider } from '../src/providers/types.js';
import { TerminalRenderer } from '../src/ui/renderer.js';

class MockLLMProvider implements ILLMProvider {
  private callCount = 0;
  public responses: any[] = [];
  public lastReceivedMessages: any[] = [];

  constructor(private modelName: string = 'qwen3.6-35b') {}

  async chat(messages: any[], tools: any[], onToken?: any, options?: any) {
    this.lastReceivedMessages = messages;
    const resp = this.responses[this.callCount] || {
      content: 'Task completed cleanly.',
      usage: { promptTokens: 50, completionTokens: 10, totalTokens: 60 }
    };
    this.callCount++;
    return resp;
  }

  async isHealthy() { return true; }
  getModel() { return this.modelName; }
  setModel(model: string) { this.modelName = model; }
  async getAvailableModels() { return [this.modelName]; }
}

test('Anti-Stall: Intent-Action Gap Interceptor prevents conversational amnesia', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locode-stall-test-'));
  try {
    const mockProvider = new MockLLMProvider();
    // Step 1: Model promises an action in conversational text without tool calls
    // Step 2: In response to interceptor nudge, model executes a tool call
    // Step 3: Model finishes cleanly
    mockProvider.responses = [
      {
        content: '<think>\n\n</think>\nLet me check the files to understand what needs fixing:',
        usage: { promptTokens: 100, completionTokens: 15, totalTokens: 115 }
      },
      {
        content: 'Reading files now.',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'list_dir', arguments: { path: '.' } }
          }
        ],
        usage: { promptTokens: 120, completionTokens: 20, totalTokens: 140 }
      },
      {
        content: 'All files inspected. Everything is verified and clean.',
        usage: { promptTokens: 150, completionTokens: 12, totalTokens: 162 }
      }
    ];

    const renderer = new TerminalRenderer();
    const agent = new AgentLoop({ cwd: tempDir, provider: 'ollama', model: 'qwen3.6-35b' }, renderer, mockProvider);

    await agent.run('Investigate repository health');

    const history = agent.getMessages();
    // Verify that the Interceptor caught the gap and pushed the [ACTION REQUIRED] directive
    const actionRequiredMsg = history.find(m => m.role === 'user' && typeof m.content === 'string' && m.content.includes('[ACTION REQUIRED]'));
    assert.ok(actionRequiredMsg, 'Expected [ACTION REQUIRED] directive to be injected when model outputted conversational promise');
    assert.match(actionRequiredMsg.content, /stated an intention to act/);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('Anti-Stall: Colloquial Nudge Transformer converts "continue" into imperative directive', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locode-nudge-test-'));
  try {
    const mockProvider = new MockLLMProvider();
    const renderer = new TerminalRenderer();
    const agent = new AgentLoop({ cwd: tempDir, provider: 'ollama', model: 'qwen3.6-35b' }, renderer, mockProvider);

    // Initial user prompt
    await agent.run('Initial task');

    // Follow-up colloquial nudge
    await agent.run('continu3');

    const history = agent.getMessages();
    const lastUserMsg = [...history].reverse().find(m => m.role === 'user');
    assert.ok(lastUserMsg, 'Expected user message in history');
    assert.match(lastUserMsg.content, /\[USER DIRECTIVE\] continu3\. Resume pending milestones immediately/);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('Hierarchical Rules: loadProjectRules loads global and local rules', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locode-rules-test-'));
  try {
    const localRulePath = path.join(tempDir, 'AGENTS.md');
    await fs.writeFile(localRulePath, 'Test invariant: always verify with tsc.', 'utf8');

    const rules = await loadProjectRules(tempDir);
    assert.ok(rules.includes('Test invariant: always verify with tsc.'));
    assert.ok(rules.includes('AGENTS.md'));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('OpenCode Compatibility: loadOpenCodeConfig parses providers and models', () => {
  const configs = loadOpenCodeConfig();
  assert.ok(Array.isArray(configs), 'Expected configs to be an array');
  // If opencode.json exists in user environment, verify it loaded
  const hasLlamaServer = configs.some(c => c.providerName === 'llama.cpp');
  assert.ok(hasLlamaServer, 'Expected llama.cpp to be discovered from user opencode.json');
});
