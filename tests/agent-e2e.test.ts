import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { AgentLoop } from '../src/agent/loop.js';
import { TerminalRenderer } from '../src/ui/renderer.js';
import { AgentContext, ChatMessage, ToolDefinition } from '../src/types.js';
import { ILLMProvider, ChatProviderResponse } from '../src/providers/types.js';
import { CodeVerifier } from '../src/agent/verifier.js';

class MockDeterministicProvider implements ILLMProvider {
  private queue: Array<(messages: ChatMessage[]) => ChatProviderResponse>;
  private model: string = 'mock-llm';

  constructor(responses: Array<(messages: ChatMessage[]) => ChatProviderResponse>) {
    this.queue = [...responses];
  }

  getModel(): string { return this.model; }
  setModel(m: string): void { this.model = m; }
  async isHealthy(): Promise<boolean> { return true; }
  async getAvailableModels(): Promise<string[]> { return [this.model]; }

  async chat(messages: ChatMessage[], tools: ToolDefinition[]): Promise<ChatProviderResponse> {
    const next = this.queue.shift();
    if (!next) {
      return { content: 'No more planned responses.' };
    }
    return next(messages);
  }
}

test('E2E Agent Flow 1 - Successful task (Request -> Tool Call -> Modification -> Verification Green)', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locode-e2e-success-'));

  try {
    // Setup minimal project with a test script
    await fs.writeFile(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({
        name: 'e2e-success-proj',
        scripts: { test: 'node -e "if(require(\'./math.js\').add(2,3) === 5) process.exit(0); else process.exit(1)"' }
      })
    );
    await fs.writeFile(path.join(tmpDir, 'math.js'), 'exports.add = (a, b) => 0;\n');

    const context: AgentContext = {
      cwd: tmpDir,
      autoApprove: true,
      model: 'qwen2.5-coder:7b',
      ollamaHost: 'http://127.0.0.1:11434'
    };

    const mockProvider = new MockDeterministicProvider([
      // Step 1: Model decides to edit math.js
      () => ({
        content: 'I will fix the add function in math.js',
        tool_calls: [
          {
            function: {
              name: 'edit_file',
              arguments: JSON.stringify({
                path: 'math.js',
                target_content: 'exports.add = (a, b) => 0;',
                replacement_content: 'exports.add = (a, b) => a + b;'
              })
            }
          }
        ]
      }),
      // Step 2: Model finishes after tool result
      () => ({
        content: 'The add function has been fixed and verified.'
      })
    ]);

    const renderer = new TerminalRenderer();
    const agent = new AgentLoop(context, renderer, mockProvider);
    await agent.init();

    await agent.run('Fix the add function in math.js so tests pass');

    // Verification check: math.js was modified correctly
    const content = await fs.readFile(path.join(tmpDir, 'math.js'), 'utf8');
    assert.ok(content.includes('a + b'));

    // Real verifier check passes
    const vResult = await CodeVerifier.run(tmpDir);
    assert.equal(vResult.passed, true);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('E2E Agent Flow 2 - Failed verification triggers autonomous repair feedback and resolves', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locode-e2e-repair-'));

  try {
    await fs.writeFile(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({
        name: 'e2e-repair-proj',
        scripts: { test: 'node -e "if(require(\'./service.js\').val === 42) process.exit(0); else process.exit(1)"' }
      })
    );
    await fs.writeFile(path.join(tmpDir, 'service.js'), 'exports.val = 0;\n');

    const context: AgentContext = {
      cwd: tmpDir,
      autoApprove: true,
      model: 'qwen2.5-coder:7b',
      ollamaHost: 'http://127.0.0.1:11434'
    };

    let repairPromptSeen = false;

    const mockProvider = new MockDeterministicProvider([
      // Step 1: Model modifies file but with a wrong value (99 instead of 42)
      () => ({
        content: 'Setting service val to 99',
        tool_calls: [
          {
            function: {
              name: 'edit_file',
              arguments: JSON.stringify({
                path: 'service.js',
                target_content: 'exports.val = 0;',
                replacement_content: 'exports.val = 99;'
              })
            }
          }
        ]
      }),
      // Step 2: Model attempts to complete turn without further tool calls
      () => ({
        content: 'Work done'
      }),
      // Step 3: Agent verifier failed! The error was fed back to the model. Model repairs it!
      (messages) => {
        const lastMsg = messages[messages.length - 1];
        if (lastMsg.role === 'user' && lastMsg.content.includes('[AUTONOMOUS VERIFICATION FAILED]')) {
          repairPromptSeen = true;
        }
        return {
          content: 'Repairing val to 42',
          tool_calls: [
            {
              function: {
                name: 'edit_file',
                arguments: JSON.stringify({
                  path: 'service.js',
                  target_content: 'exports.val = 99;',
                  replacement_content: 'exports.val = 42;'
                })
              }
            }
          ]
        };
      },
      // Step 4: Model completes turn after repair
      () => ({
        content: 'Repair complete, tests now pass.'
      })
    ]);

    const renderer = new TerminalRenderer();
    const agent = new AgentLoop(context, renderer, mockProvider);
    await agent.init();

    await agent.run('Set val in service.js to 42');

    assert.equal(repairPromptSeen, true, 'Agent loop must feed verification failure back to model');
    const finalContent = await fs.readFile(path.join(tmpDir, 'service.js'), 'utf8');
    assert.ok(finalContent.includes('42'));

    const vResult = await CodeVerifier.run(tmpDir);
    assert.equal(vResult.passed, true);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('E2E Agent Flow 3 - Architect Escalation when worker fails repeatedly', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locode-e2e-architect-'));

  try {
    await fs.writeFile(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({
        name: 'e2e-arch-proj',
        scripts: { test: 'node -e "if(require(\'./auth.js\').token === \'secret\') process.exit(0); else process.exit(1)"' }
      })
    );
    await fs.writeFile(path.join(tmpDir, 'auth.js'), 'exports.token = "bad";\n');

    const context: AgentContext = {
      cwd: tmpDir,
      autoApprove: true,
      model: 'qwen2.5-coder:7b',
      ollamaHost: 'http://127.0.0.1:11434'
    };

    let architectEscalationPromptSeen = false;

    const mockProvider = new MockDeterministicProvider([
      // 1. Initial flawed edit
      () => ({
        content: 'First edit attempt',
        tool_calls: [{ function: { name: 'edit_file', arguments: JSON.stringify({ path: 'auth.js', target_content: '"bad"', replacement_content: '"bad1"' }) } }]
      }),
      () => ({ content: 'Turn complete 1' }),
      // 2. Failed attempt 1 fed back -> Worker makes second flawed edit
      () => ({
        content: 'Second edit attempt',
        tool_calls: [{ function: { name: 'edit_file', arguments: JSON.stringify({ path: 'auth.js', target_content: '"bad1"', replacement_content: '"bad2"' }) } }]
      }),
      () => ({ content: 'Turn complete 2' }),
      // Architect diagnosis call triggered because repairAttempts reaches 2
      () => ({
        content: 'ROOT CAUSE: token is expected to be "secret"\nAFFECTED CONTRACT: auth.js\nSURGICAL FIX: set exports.token = "secret"'
      }),
      // 3. Worker receives Senior Architect directive and fixes it
      (messages) => {
        const lastMsg = messages[messages.length - 1];
        if (lastMsg.content.includes('[AUTONOMOUS VERIFICATION FAILED - ARCHITECT ESCALATION]')) {
          architectEscalationPromptSeen = true;
        }
        return {
          content: 'Applying architect fix',
          tool_calls: [{ function: { name: 'edit_file', arguments: JSON.stringify({ path: 'auth.js', target_content: '"bad2"', replacement_content: '"secret"' }) } }]
        };
      },
      () => ({ content: 'Everything resolved' })
    ]);

    const renderer = new TerminalRenderer();
    const agent = new AgentLoop(context, renderer, mockProvider);
    await agent.init();

    await agent.run('Fix auth token');

    assert.equal(architectEscalationPromptSeen, true, 'Architect escalation directive must be fed to worker');
    const vResult = await CodeVerifier.run(tmpDir);
    assert.equal(vResult.passed, true);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});
