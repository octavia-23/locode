import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { AgentLoop } from '../src/agent/loop.js';
import { ContextEngine } from '../src/agent/context.js';
import { TerminalRenderer } from '../src/ui/renderer.js';
import { AgentContext, ChatMessage, ToolDefinition } from '../src/types.js';
import { ILLMProvider, ChatProviderResponse } from '../src/providers/types.js';
import { viewFileTool, writeFileTool, editFileTool } from '../src/tools/file-ops.js';

class MockTestProvider implements ILLMProvider {
  private queue: Array<(messages: ChatMessage[]) => Promise<ChatProviderResponse> | ChatProviderResponse>;
  private model: string = 'mock-llm';

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
      return { content: 'Default completion' };
    }
    return await next(messages);
  }
}

test('Agent Loop Reliability - Empty response triggers continuation and recovers cleanly', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locode-empty-recovery-'));
  try {
    const context: AgentContext = {
      cwd: tmpDir,
      autoApprove: true,
      model: 'qwen2.5-coder:7b',
      ollamaHost: 'http://127.0.0.1:11434'
    };

    let continuationPromptReceived = false;

    const mockProvider = new MockTestProvider([
      // Step 1: Model issues tool call
      () => ({
        content: 'Writing temp file',
        tool_calls: [{
          function: {
            name: 'write_file',
            arguments: JSON.stringify({ path: 'test.txt', content: 'hello world' })
          }
        }]
      }),
      // Step 2: Model returns an abnormal EMPTY response (the bug!)
      () => ({
        content: '   ' // empty/whitespace
      }),
      // Step 3: Loop should have recovered and sent [CONTINUATION INSTRUCTION]
      (messages) => {
        const last = messages[messages.length - 1];
        if (last.content.includes('[CONTINUATION INSTRUCTION]')) {
          continuationPromptReceived = true;
        }
        return {
          content: 'I have continued and successfully completed the task.'
        };
      }
    ]);

    const renderer = new TerminalRenderer();
    const agent = new AgentLoop(context, renderer, mockProvider);
    await agent.init();

    await agent.run('Write test.txt and finish');

    assert.equal(continuationPromptReceived, true, 'Agent loop must feed continuation prompt when model goes quiet');
    const stats = agent.getStats();
    assert.equal(stats.emptyGenerations, 1, 'Empty generation counter should be 1');
    assert.equal(stats.recoveries, 1, 'Recovery counter should be 1');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('Agent Loop Reliability - Repeated empty responses terminate cleanly without hanging', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locode-repeated-empty-'));
  try {
    const context: AgentContext = {
      cwd: tmpDir,
      autoApprove: true,
      model: 'qwen2.5-coder:7b',
      ollamaHost: 'http://127.0.0.1:11434'
    };

    // Return empty 5 times in a row
    const mockProvider = new MockTestProvider([
      () => ({ content: '' }),
      () => ({ content: '' }),
      () => ({ content: '' }),
      () => ({ content: '' }),
      () => ({ content: '' })
    ]);

    const renderer = new TerminalRenderer();
    const agent = new AgentLoop(context, renderer, mockProvider);
    await agent.init();

    // Must not hang forever; must terminate after bounded attempts
    await agent.run('Some task');

    const stats = agent.getStats();
    assert.ok(stats.emptyGenerations >= 3);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('Agent Loop Reliability - Repetitive tool loop is trapped by Progress Guard', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locode-progress-loop-'));
  try {
    const context: AgentContext = {
      cwd: tmpDir,
      autoApprove: true,
      model: 'qwen2.5-coder:7b',
      ollamaHost: 'http://127.0.0.1:11434'
    };

    let warningSeen = false;

    // Model repeats the exact same tool call 4 times
    const mockProvider = new MockTestProvider([
      () => ({
        content: 'Check',
        tool_calls: [{ function: { name: 'list_dir', arguments: { path: '.' } } }]
      }),
      () => ({
        content: 'Check again',
        tool_calls: [{ function: { name: 'list_dir', arguments: { path: '.' } } }]
      }),
      () => ({
        content: 'Check again',
        tool_calls: [{ function: { name: 'list_dir', arguments: { path: '.' } } }]
      }),
      () => ({
        content: 'Check again',
        tool_calls: [{ function: { name: 'list_dir', arguments: { path: '.' } } }]
      }),
      (messages) => {
        const last = messages[messages.length - 1];
        if (last.content.includes('[PROGRESS GUARD WARNING]')) {
          warningSeen = true;
        }
        return { content: 'Stopping now.' };
      }
    ]);

    const renderer = new TerminalRenderer();
    const agent = new AgentLoop(context, renderer, mockProvider);
    await agent.init();

    await agent.run('Check folder');

    assert.equal(warningSeen, true, 'Progress Guard must intervene when model repeats identical tool action 4 times');
    const stats = agent.getStats();
    assert.ok(stats.progressLoopsDetected >= 1);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('Context Engine - File modification invalidates cached content', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locode-cache-inval-'));
  try {
    const engine = new ContextEngine(8192, tmpDir);
    const context: AgentContext = {
      cwd: tmpDir,
      autoApprove: true,
      model: 'qwen2.5-coder:7b',
      ollamaHost: 'http://127.0.0.1:11434',
      contextEngine: engine
    };

    const filePath = 'file.txt';
    await fs.writeFile(path.join(tmpDir, filePath), 'Original Content', 'utf8');

    // 1. View file populates cache
    await viewFileTool.execute({ path: filePath }, context);

    // 2. Edit file invalidates cache
    await editFileTool.execute({
      path: filePath,
      target_content: 'Original Content',
      replacement_content: 'Fresh New Content'
    }, context);

    // 3. Subsequent view file gets fresh content
    const viewResult = await viewFileTool.execute({ path: filePath }, context);
    assert.ok(viewResult.result.includes('Fresh New Content'));
    assert.ok(!viewResult.result.includes('Original Content'));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('Context Engine - Deduplicates identical tool outputs across turns', () => {
  const engine = new ContextEngine(1000);
  const toolResult = 'Directory listing: package.json, src/index.ts, src/types.ts';

  const messages: ChatMessage[] = [
    { role: 'system', content: 'System prompt' },
    { role: 'user', content: 'What files exist?' },
    { role: 'tool', content: toolResult },
    { role: 'assistant', content: 'I see the files.' },
    { role: 'user', content: 'Check again.' },
    { role: 'tool', content: toolResult }, // Identical duplicate!
    { role: 'assistant', content: 'Looking again.' },
    { role: 'user', content: 'Final confirmation.' }
  ];

  const compacted = engine.compactMessages(messages);
  // Second tool result should be deduplicated
  const secondTool = compacted.find((m, idx) => idx > 3 && m.role === 'tool');
  assert.ok(secondTool?.content.includes('identical to tool result'));
  const stats = engine.getStats();
  assert.ok(stats.tokensAvoidedByDeduplication > 0);
});

test('Agent Loop - Long task execution allows > 25 steps when making real progress', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locode-long-task-'));
  try {
    const context: AgentContext = {
      cwd: tmpDir,
      autoApprove: true,
      model: 'qwen2.5-coder:7b',
      ollamaHost: 'http://127.0.0.1:11434'
    };

    // Plan a sequence of 30 distinct tool calls (creating 30 files)
    const responses: Array<() => ChatProviderResponse> = [];
    for (let i = 1; i <= 30; i++) {
      const idx = i;
      responses.push(() => ({
        content: `Step ${idx}`,
        tool_calls: [{
          function: {
            name: 'write_file',
            arguments: JSON.stringify({ path: `file_${idx}.txt`, content: `Data ${idx}` })
          }
        }]
      }));
    }
    // Final response
    responses.push(() => ({
      content: 'All 30 files created successfully.'
    }));

    const mockProvider = new MockTestProvider(responses);
    const renderer = new TerminalRenderer();
    const agent = new AgentLoop(context, renderer, mockProvider);
    await agent.init();

    await agent.run('Create 30 files in sequence');

    const stats = agent.getStats();
    assert.ok(stats.toolCalls >= 30, `Agent must have executed 30 tool calls without stopping at 25. Actual: ${stats.toolCalls}`);

    // Verify files were actually created
    const file1 = await fs.readFile(path.join(tmpDir, 'file_1.txt'), 'utf8');
    const file30 = await fs.readFile(path.join(tmpDir, 'file_30.txt'), 'utf8');
    assert.equal(file1, 'Data 1');
    assert.equal(file30, 'Data 30');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});
