import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runCommandTool } from '../src/tools/terminal.js';
import { AgentLoop } from '../src/agent/loop.js';
import { StagnationDetector } from '../src/agent/stagnation.js';
import { AgentContext, ChatMessage } from '../src/types.js';
import { ILLMProvider, ChatProviderResponse } from '../src/providers/types.js';
import { TerminalRenderer } from '../src/ui/renderer.js';

class MockAgentProvider implements ILLMProvider {
  private queue: Array<(messages: ChatMessage[]) => ChatProviderResponse>;
  private model: string = 'mock-llm';

  constructor(responses: Array<(messages: ChatMessage[]) => ChatProviderResponse>) {
    this.queue = [...responses];
  }

  getModel(): string { return this.model; }
  setModel(m: string): void { this.model = m; }
  async isHealthy(): Promise<boolean> { return true; }
  async getAvailableModels(): Promise<string[]> { return [this.model]; }

  async chat(messages: ChatMessage[]): Promise<ChatProviderResponse> {
    const next = this.queue.shift();
    if (!next) {
      return { content: 'Default completion' };
    }
    return next(messages);
  }
}

test('run_command - returns nonzero exit code with captured output', async () => {
  const ctx: AgentContext = {
    cwd: process.cwd(),
    autoApprove: true,
    model: 'mock',
    ollamaHost: 'http://localhost'
  };

  const res = await runCommandTool.execute({
    command: 'node -e "console.error(\\"syntax error trace\\"); process.exit(42);"'
  }, ctx);

  assert.equal(res.isError, true);
  assert.match(res.result, /status code 42/i);
  assert.match(res.result, /syntax error trace/);
});

test('run_command - slow process completes within timeout and exposes progress', async () => {
  let progressReported = false;
  const ctx: AgentContext = {
    cwd: process.cwd(),
    autoApprove: true,
    model: 'mock',
    ollamaHost: 'http://localhost',
    onCommandProgress: (p) => {
      if (p.elapsedMs >= 0) {
        progressReported = true;
      }
    }
  };

  const start = Date.now();
  const res = await runCommandTool.execute({
    command: 'node -e "setTimeout(() => { console.log(\\"done after wait\\"); }, 400);"'
  }, ctx);

  const duration = Date.now() - start;
  assert.equal(res.isError, undefined);
  assert.match(res.result, /done after wait/);
  assert.ok(duration >= 350, `Should wait for timer, took ${duration}ms`);
  assert.equal(progressReported, true, 'Progress callback should be invoked');
});

test('run_command - process that never exits triggers timeout and terminates safely', async () => {
  const ctx: AgentContext = {
    cwd: process.cwd(),
    autoApprove: true,
    model: 'mock',
    ollamaHost: 'http://localhost'
  };

  const start = Date.now();
  // 300ms timeout on infinite loop
  const res = await runCommandTool.execute({
    command: 'node -e "setInterval(() => {}, 100);"',
    timeout: 350
  }, ctx);

  const duration = Date.now() - start;
  assert.equal(res.isError, true);
  assert.match(res.result, /timed out after 0\.35 seconds/i);
  assert.ok(duration >= 300 && duration < 3000, `Process must time out cleanly, took ${duration}ms`);
});

test('run_command - respects configurable timeout in AgentContext', async () => {
  const ctx: AgentContext = {
    cwd: process.cwd(),
    autoApprove: true,
    model: 'mock',
    ollamaHost: 'http://localhost',
    commandTimeoutMs: 300
  };

  const start = Date.now();
  const res = await runCommandTool.execute({
    command: 'node -e "setInterval(() => {}, 100);"'
  }, ctx);

  const duration = Date.now() - start;
  assert.equal(res.isError, true);
  assert.match(res.result, /timed out after 0\.3 seconds/i);
  assert.ok(duration >= 250 && duration < 3000);
});

test('run_command - cancellation via AbortSignal terminates process tree safely', async () => {
  const controller = new AbortController();
  const ctx: AgentContext = {
    cwd: process.cwd(),
    autoApprove: true,
    model: 'mock',
    ollamaHost: 'http://localhost',
    signal: controller.signal
  };

  const start = Date.now();
  // Cancel 150ms after starting
  setTimeout(() => controller.abort(), 150);

  const res = await runCommandTool.execute({
    command: 'node -e "setInterval(() => {}, 100);"',
    timeout: 30000
  }, ctx);

  const duration = Date.now() - start;
  assert.equal(res.isError, true);
  assert.match(res.result, /cancelled/i);
  assert.ok(duration < 2000, `Cancelled process must terminate quickly, took ${duration}ms`);
});

test('run_command - process reading stdin receives immediate EOF and does not hang', async () => {
  const ctx: AgentContext = {
    cwd: process.cwd(),
    autoApprove: true,
    model: 'mock',
    ollamaHost: 'http://localhost'
  };

  const start = Date.now();
  const res = await runCommandTool.execute({
    command: 'node -e "process.stdin.resume(); process.stdin.on(\'data\', () => {}); process.stdin.on(\'end\', () => { console.log(\\"eof-received\\"); process.exit(0); });"'
  }, ctx);

  const duration = Date.now() - start;
  assert.equal(res.isError, undefined);
  assert.match(res.result, /eof-received/);
  assert.ok(duration < 3000, `Stdin must receive EOF immediately, took ${duration}ms`);
});

test('run_command - noisy interleaved stdout and stderr captured cleanly', async () => {
  const ctx: AgentContext = {
    cwd: process.cwd(),
    autoApprove: true,
    model: 'mock',
    ollamaHost: 'http://localhost'
  };

  const res = await runCommandTool.execute({
    command: 'node -e "console.log(\\"stdout-line-1\\"); console.error(\\"stderr-line-1\\"); console.log(\\"stdout-line-2\\");"'
  }, ctx);

  assert.equal(res.isError, undefined);
  assert.match(res.result, /stdout-line-1/);
  assert.match(res.result, /stderr-line-1/);
  assert.match(res.result, /stdout-line-2/);
});

test('Loop Integration - Legitimate test rerun after source edit is NOT flagged as loop', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locode-test-rerun-'));
  try {
    const context: AgentContext = {
      cwd: tmpDir,
      autoApprove: true,
      model: 'mock-llm',
      ollamaHost: 'http://localhost',
      stagnationThresholds: {
        maxEquivalentToolCalls: 3,
        maxUnchangedFailures: 3,
        maxRecoveryAttempts: 2
      }
    };

    let recoveryWarningTriggered = false;

    // Sequence:
    // Turn 1: run test (fails)
    // Turn 2: edit file
    // Turn 3: rerun test (fails)
    // Turn 4: edit file
    // Turn 5: rerun test (succeeds)
    // Turn 6: final done
    const responses: Array<(messages: ChatMessage[]) => ChatProviderResponse> = [
      () => ({
        content: 'Testing before edit',
        tool_calls: [{ function: { name: 'run_command', arguments: { command: 'node -e "process.exit(1)"' } } }]
      }),
      () => ({
        content: 'Fixing file',
        tool_calls: [{ function: { name: 'write_file', arguments: { path: 'index.js', content: 'v1' } } }]
      }),
      () => ({
        content: 'Testing after edit 1',
        tool_calls: [{ function: { name: 'run_command', arguments: { command: 'node -e "process.exit(1)"' } } }]
      }),
      () => ({
        content: 'Fixing file again',
        tool_calls: [{ function: { name: 'write_file', arguments: { path: 'index.js', content: 'v2' } } }]
      }),
      () => ({
        content: 'Testing after edit 2',
        tool_calls: [{ function: { name: 'run_command', arguments: { command: 'node -e "console.log(\\"all passed\\")"' } } }]
      }),
      (messages) => {
        const warned = messages.some(m => m.role === 'tool' && (m.content.includes('PROGRESS GUARD WARNING') || m.content.includes('STAGNATION RECOVERY DIRECTIVE')));
        if (warned) {
          recoveryWarningTriggered = true;
        }
        return { content: 'Verification complete and all tests pass!' };
      }
    ];

    const mockProvider = new MockAgentProvider(responses);
    const renderer = new TerminalRenderer();
    const agent = new AgentLoop(context, renderer, mockProvider);
    await agent.init();

    await agent.run('Run tests and apply fixes');

    assert.equal(recoveryWarningTriggered, false, 'Legitimate test reruns after source edits must never trigger loop warnings');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('Loop Integration - Distinct command using same tool does not trigger false positive repetition', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locode-distinct-cmd-'));
  try {
    const context: AgentContext = {
      cwd: tmpDir,
      autoApprove: true,
      model: 'mock-llm',
      ollamaHost: 'http://localhost',
      stagnationThresholds: {
        maxEquivalentToolCalls: 3
      }
    };

    let falsePositiveTriggered = false;

    // Model executes 4 DIFFERENT commands with run_command:
    const responses: Array<(messages: ChatMessage[]) => ChatProviderResponse> = [
      () => ({
        content: 'Check node version',
        tool_calls: [{ function: { name: 'run_command', arguments: { command: 'node -v' } } }]
      }),
      () => ({
        content: 'Check git status',
        tool_calls: [{ function: { name: 'run_command', arguments: { command: 'git --version' } } }]
      }),
      () => ({
        content: 'Check npm version',
        tool_calls: [{ function: { name: 'run_command', arguments: { command: 'npm -v' } } }]
      }),
      () => ({
        content: 'Echo test target',
        tool_calls: [{ function: { name: 'run_command', arguments: { command: 'node -e "console.log(\\"ok\\")"' } } }]
      }),
      (messages) => {
        const warned = messages.some(m => m.role === 'tool' && (m.content.includes('PROGRESS GUARD WARNING') || m.content.includes('STAGNATION RECOVERY DIRECTIVE')));
        if (warned) {
          falsePositiveTriggered = true;
        }
        return { content: 'All distinct commands executed successfully.' };
      }
    ];

    const mockProvider = new MockAgentProvider(responses);
    const renderer = new TerminalRenderer();
    const agent = new AgentLoop(context, renderer, mockProvider);
    await agent.init();

    await agent.run('Run environment checks');

    assert.equal(falsePositiveTriggered, false, 'Distinct commands with different arguments must not be flagged as duplicates');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('Loop Integration - Blocked tool call receives structured tool response with tool_call_id', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locode-blocked-tool-'));
  try {
    const context: AgentContext = {
      cwd: tmpDir,
      autoApprove: true,
      model: 'mock-llm',
      ollamaHost: 'http://localhost',
      stagnationThresholds: {
        maxEquivalentToolCalls: 2,
        maxRecoveryAttempts: 2
      }
    };

    let structuredResultSeen = false;

    // Sequence: 2 identical calls, then 3rd is intercepted
    const responses: Array<(messages: ChatMessage[]) => ChatProviderResponse> = [
      () => ({
        content: 'Command 1',
        tool_calls: [{ id: 'tc-call-1', function: { name: 'run_command', arguments: { command: 'node -v' } } }]
      }),
      () => ({
        content: 'Command 2',
        tool_calls: [{ id: 'tc-call-2', function: { name: 'run_command', arguments: { command: 'node -v' } } }]
      }),
      () => ({
        content: 'Command 3 (identical again)',
        tool_calls: [{ id: 'tc-call-3', function: { name: 'run_command', arguments: { command: 'node -v' } } }]
      }),
      (messages) => {
        const blockedMsg = messages.find(m => m.role === 'tool' && m.tool_call_id === 'tc-call-3');
        if (blockedMsg && (blockedMsg.content.includes('STAGNATION RECOVERY DIRECTIVE') || blockedMsg.content.includes('PROGRESS GUARD WARNING'))) {
          structuredResultSeen = true;
        }
        return { content: 'Stopping now that warning was received.' };
      }
    ];

    const mockProvider = new MockAgentProvider(responses);
    const renderer = new TerminalRenderer();
    const agent = new AgentLoop(context, renderer, mockProvider);
    await agent.init();

    await agent.run('Check command');

    assert.equal(structuredResultSeen, true, 'Blocked tool call must receive structured tool result matching its tool_call_id');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});
