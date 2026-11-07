import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { AgentLoop } from '../src/agent/loop.js';
import { handleSlashCommand } from '../src/ui/commands.js';
import { TerminalRenderer } from '../src/ui/renderer.js';
import { AgentContext, ChatMessage, ToolDefinition } from '../src/types.js';
import { ILLMProvider, ChatProviderResponse } from '../src/providers/types.js';
import { getGlobalEnvPath } from '../src/utils/config.js';

class MockLLMProvider implements ILLMProvider {
  private model: string = 'mock-llm';

  getModel(): string { return this.model; }
  setModel(m: string): void { this.model = m; }
  async isHealthy(): Promise<boolean> { return true; }
  async getAvailableModels(): Promise<string[]> {
    return [this.model, 'mock-model-a', 'mock-model-b'];
  }

  async chat(messages: ChatMessage[], tools: ToolDefinition[]): Promise<ChatProviderResponse> {
    return { content: 'mock completion' };
  }
}

test('Slash Commands - /help includes /key, /provider, and /model commands', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locode-cmd-test-'));
  try {
    const context: AgentContext = {
      cwd: tmpDir,
      autoApprove: true,
      model: 'qwen2.5-coder:7b',
      ollamaHost: 'http://127.0.0.1:11434',
      provider: 'ollama'
    };
    const renderer = new TerminalRenderer();
    const provider = new MockLLMProvider();
    const agent = new AgentLoop(context, renderer, provider);

    let logged = '';
    const origLog = console.log;
    console.log = (...args: any[]) => {
      logged += args.join(' ') + '\n';
    };

    try {
      const handled = await handleSlashCommand('/help', agent, provider, renderer, tmpDir);
      assert.equal(handled, true);
      assert.ok(logged.includes('/key [key]'));
      assert.ok(logged.includes('/provider [name]'));
      assert.ok(logged.includes('/model [name]'));
    } finally {
      console.log = origLog;
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('Slash Commands - /key automatically identifies provider and loads models on its own', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locode-key-test-'));
  const origEnv = { ...process.env };
  try {
    const context: AgentContext = {
      cwd: tmpDir,
      autoApprove: true,
      model: 'qwen2.5-coder:7b',
      ollamaHost: 'http://127.0.0.1:11434',
      provider: 'ollama'
    };
    const renderer = new TerminalRenderer();
    const provider = new MockLLMProvider();
    const agent = new AgentLoop(context, renderer, provider);

    // 1. Enter Gemini API key
    const geminiHandled = await handleSlashCommand(
      '/key AIzaSyTestKeyForAutomatedUnitVerification12345',
      agent,
      provider,
      renderer,
      tmpDir
    );
    assert.equal(geminiHandled, true);
    assert.equal(agent.getContext().provider, 'gemini');
    assert.equal(agent.getContext().model, 'gemini-3.6-flash');
    assert.equal(process.env.GEMINI_API_KEY, 'AIzaSyTestKeyForAutomatedUnitVerification12345');
    assert.equal(agent.getContext().numCtx, 1048576);

    // 2. Enter Anthropic API key
    const anthropicHandled = await handleSlashCommand(
      '/key sk-ant-api03-testAnthropicSecretKey987654321',
      agent,
      agent.getProvider(),
      renderer,
      tmpDir
    );
    assert.equal(anthropicHandled, true);
    assert.equal(agent.getContext().provider, 'anthropic');
    assert.equal(agent.getContext().model, 'claude-3-5-sonnet-20241022');
    assert.equal(process.env.ANTHROPIC_API_KEY, 'sk-ant-api03-testAnthropicSecretKey987654321');
    assert.equal(agent.getContext().numCtx, 200000);

    // 3. Enter Groq API key
    const groqHandled = await handleSlashCommand(
      '/key gsk_groqSuperSecretKey123456789012345',
      agent,
      agent.getProvider(),
      renderer,
      tmpDir
    );
    assert.equal(groqHandled, true);
    assert.equal(agent.getContext().provider, 'groq');
    assert.equal(agent.getContext().model, 'qwen/qwen3.8-27b');
    assert.equal(process.env.GROQ_API_KEY, 'gsk_groqSuperSecretKey123456789012345');
    assert.equal(agent.getContext().numCtx, 131072);
  } finally {
    process.env = origEnv;
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('Slash Commands - /provider switches provider and configures context window and models', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locode-prov-test-'));
  const origEnv = { ...process.env };
  try {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-existing-key';
    const context: AgentContext = {
      cwd: tmpDir,
      autoApprove: true,
      model: 'qwen2.5-coder:7b',
      ollamaHost: 'http://127.0.0.1:11434',
      provider: 'ollama'
    };
    const renderer = new TerminalRenderer();
    const provider = new MockLLMProvider();
    const agent = new AgentLoop(context, renderer, provider);

    const handled = await handleSlashCommand('/provider anthropic', agent, provider, renderer, tmpDir);
    assert.equal(handled, true);
    assert.equal(agent.getContext().provider, 'anthropic');
    assert.equal(agent.getContext().model, 'claude-3-5-sonnet-20241022');
    assert.equal(agent.getContext().numCtx, 200000);

    // Unknown provider
    let errorOutput = '';
    renderer.printError = (msg: string) => { errorOutput += msg; };
    await handleSlashCommand('/provider nonexistent-vendor', agent, provider, renderer, tmpDir);
    assert.ok(errorOutput.includes('unknown provider "nonexistent-vendor"'));
  } finally {
    process.env = origEnv;
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('Slash Commands - /model switches model on provider and agent context', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locode-model-test-'));
  try {
    const context: AgentContext = {
      cwd: tmpDir,
      autoApprove: true,
      model: 'qwen2.5-coder:7b',
      ollamaHost: 'http://127.0.0.1:11434',
      provider: 'ollama'
    };
    const renderer = new TerminalRenderer();
    const provider = new MockLLMProvider();
    const agent = new AgentLoop(context, renderer, provider);

    const handled = await handleSlashCommand('/model custom-finetune:14b', agent, provider, renderer, tmpDir);
    assert.equal(handled, true);
    assert.equal(agent.getContext().model, 'custom-finetune:14b');
    assert.equal(provider.getModel(), 'custom-finetune:14b');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
