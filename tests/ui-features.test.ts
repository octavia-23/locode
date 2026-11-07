import test from 'node:test';
import assert from 'node:assert/strict';
import { handleSlashCommand } from '../src/ui/commands.js';
import { TerminalRenderer } from '../src/ui/renderer.js';
import { AgentLoop } from '../src/agent/loop.js';
import { ILLMProvider } from '../src/providers/types.js';
import { getActiveTheme } from '../src/ui/theme.js';

const mockProvider: ILLMProvider = {
  getModel: () => 'test-model',
  setModel: () => {},
  chat: async () => ({ content: 'done' }),
  isHealthy: async () => true,
  getAvailableModels: async () => ['test-model']
};

test('UI Features - /theme command switches active theme', async () => {
  const renderer = new TerminalRenderer();
  const agent = new AgentLoop({ cwd: process.cwd(), model: 'test' }, renderer, mockProvider);

  const handled = await handleSlashCommand('/theme nord', agent, mockProvider, renderer, process.cwd());
  assert.equal(handled, true);
  assert.equal(getActiveTheme().name, 'nord');

  // Reset to default
  await handleSlashCommand('/theme terracotta', agent, mockProvider, renderer, process.cwd());
  assert.equal(getActiveTheme().name, 'terracotta');
});

test('UI Features - /stats command handles empty and active telemetry', async () => {
  const renderer = new TerminalRenderer();
  const agent = new AgentLoop({ cwd: process.cwd(), model: 'test', numCtx: 32768 }, renderer, mockProvider);

  const handled = await handleSlashCommand('/stats', agent, mockProvider, renderer, process.cwd());
  assert.equal(handled, true);
});

test('UI Features - /find lists workspace files in non-interactive environment', async () => {
  const renderer = new TerminalRenderer();
  const agent = new AgentLoop({ cwd: process.cwd(), model: 'test' }, renderer, mockProvider);

  const handled = await handleSlashCommand('/find package', agent, mockProvider, renderer, process.cwd());
  assert.equal(handled, true);
});

test('UI Features - TerminalRenderer printStatusHUD renders cleanly without error', () => {
  const renderer = new TerminalRenderer();
  let didThrow = false;
  try {
    renderer.printStatusHUD('qwen35b', 'llamacpp', 65536, 12000, true, 'main', 28.4);
  } catch {
    didThrow = true;
  }
  assert.equal(didThrow, false);
});
