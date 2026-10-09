import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { AgentLoop, detectToolExecutionCycle } from '../src/agent/loop.js';
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

test('Agent Loop - Autonomous Action Gate blocks passive read tools after 2 reads and forces edit_file', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locode-action-gate-'));
  try {
    const context: AgentContext = {
      cwd: tmpDir,
      autoApprove: true,
      model: 'qwen2.5-coder:7b',
      ollamaHost: 'http://127.0.0.1:11434'
    };

    const targetFile = 'app.js';
    await fs.writeFile(path.join(tmpDir, targetFile), 'console.log("hello world");', 'utf8');

    let actionGateBlockedSeen = false;

    const mockProvider = new MockTestProvider([
      // Turn 1: read file
      () => ({
        content: 'Inspecting code',
        tool_calls: [{
          function: { name: 'view_file', arguments: { path: targetFile } }
        }]
      }),
      // Turn 2: read file again
      () => ({
        content: 'Inspecting code again',
        tool_calls: [{
          function: { name: 'view_file', arguments: { path: targetFile } }
        }]
      }),
      // Turn 3: Model tries passive view_file a 3rd time (should be blocked by Action Gate!)
      () => ({
        content: 'Trying to read a 3rd time',
        tool_calls: [{
          function: { name: 'view_file', arguments: { path: targetFile } }
        }]
      }),
      // Turn 4: Model inspects tool error with directive and calls edit_file
      (messages) => {
        const lastToolMsg = messages.find(m => m.role === 'tool' && m.content.includes('[EXECUTION BLOCKED - ACTION REQUIRED]'));
        if (lastToolMsg) {
          actionGateBlockedSeen = true;
        }
        return {
          content: 'Editing code now',
          tool_calls: [{
            function: {
              name: 'edit_file',
              arguments: {
                path: targetFile,
                target_content: 'hello world',
                replacement_content: 'hello autonomous world'
              }
            }
          }]
        };
      },
      // Turn 5: Clean final response
      () => ({
        content: 'Successfully updated app.js.'
      })
    ]);

    const renderer = new TerminalRenderer();
    const agent = new AgentLoop(context, renderer, mockProvider);
    await agent.init();

    await agent.run('Update app.js to say hello autonomous world');

    assert.equal(actionGateBlockedSeen, true, 'Action gate must intercept 3rd passive read and provide execution directive');
    const updatedContent = await fs.readFile(path.join(tmpDir, targetFile), 'utf8');
    assert.equal(updatedContent, 'console.log("hello autonomous world");', 'File must be modified by edit_file');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('Cycle Detector - Traps period 1, period 2 (ping-pong), and period 3 cycles', () => {
  // Period 1: identical calls (needs 4)
  const p1 = ['edit:a', 'edit:a', 'edit:a', 'edit:a'];
  const res1 = detectToolExecutionCycle(p1);
  assert.equal(res1.detected, true);
  assert.equal(res1.period, 1);

  // Period 2: alternating A-B-A-B-A-B (needs 3 reps = 6 calls)
  const p2 = ['read:x', 'run:test', 'read:x', 'run:test', 'read:x', 'run:test'];
  const res2 = detectToolExecutionCycle(p2);
  assert.equal(res2.detected, true);
  assert.equal(res2.period, 2);

  // Period 3: A-B-C-A-B-C (needs 2 reps = 6 calls)
  const p3 = ['read:x', 'edit:y', 'run:z', 'read:x', 'edit:y', 'run:z'];
  const res3 = detectToolExecutionCycle(p3);
  assert.equal(res3.detected, true);
  assert.equal(res3.period, 3);

  // Normal non-cyclic sequence
  const normal = ['read:a', 'read:b', 'edit:a', 'run:test', 'read:c'];
  const resNormal = detectToolExecutionCycle(normal);
  assert.equal(resNormal.detected, false);
});

test('Agent Loop Reliability - Circuit breaker halts execution after 5 consecutive tool failures', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locode-circuit-breaker-'));
  try {
    const context: AgentContext = {
      cwd: tmpDir,
      autoApprove: true,
      model: 'qwen2.5-coder:7b',
      ollamaHost: 'http://127.0.0.1:11434'
    };

    // Model attempts 10 failing edit calls in a row on different files
    const responses: Array<() => ChatProviderResponse> = [];
    for (let i = 0; i < 10; i++) {
      const idx = i;
      responses.push(() => ({
        content: `Attempt ${idx}`,
        tool_calls: [{
          function: {
            name: 'edit_file',
            arguments: {
              path: `non_existent_${idx}.js`,
              target_content: 'foo',
              replacement_content: 'bar'
            }
          }
        }]
      }));
    }

    const mockProvider = new MockTestProvider(responses);
    const renderer = new TerminalRenderer();
    const agent = new AgentLoop(context, renderer, mockProvider);
    await agent.init();

    await agent.run('Fix non existent file');

    const stats = agent.getStats();
    // Must halt at exactly 5 consecutive failures, not continuing all 10!
    assert.equal(stats.failedToolCalls, 5, 'Circuit breaker must trip at exactly 5 consecutive tool failures');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('Agent Loop Reliability - Rescues leaked Qwen <tool_call> XML from content and executes tool without looping', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locode-qwen-xml-rescue-'));
  try {
    const context: AgentContext = {
      cwd: tmpDir,
      autoApprove: true,
      model: 'locode-qwen35b-a3b',
      ollamaHost: 'http://127.0.0.1:11434'
    };

    // Model returns tool call leaked inside content XML without populating response.tool_calls
    const mockProvider = new MockTestProvider([
      () => ({
        content: `I will create the target file:
<tool_call>
{"name": "write_file", "arguments": {"path": "rescued.txt", "content": "hello from qwen"}}
</tool_call>`
        // Note: tool_calls is intentionally undefined!
      }),
      () => ({
        content: 'File was written successfully. Task complete.'
      })
    ]);

    const renderer = new TerminalRenderer();
    const agent = new AgentLoop(context, renderer, mockProvider);
    await agent.init();

    await agent.run('Create rescued.txt');

    const createdContent = await fs.readFile(path.join(tmpDir, 'rescued.txt'), 'utf8');
    assert.equal(createdContent, 'hello from qwen');

    const stats = agent.getStats();
    assert.equal(stats.successfulToolCalls, 1, 'Rescued tool call must be counted as successful');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});


