import test from 'node:test';
import assert from 'node:assert/strict';
import { ArchitectEngine } from '../src/agent/architect.js';
import { AgentContext } from '../src/types.js';
import { ILLMProvider } from '../src/providers/types.js';

test('ArchitectEngine - diagnose formats senior diagnostic directive', async () => {
  let promptSeen = '';
  const mockProvider: ILLMProvider = {
    getModel: () => 'mock-model',
    setModel: () => {},
    isHealthy: async () => true,
    getAvailableModels: async () => ['mock-model'],
    chat: async (messages) => {
      promptSeen = messages.map(m => m.content).join('\n');
      return {
        content: 'ROOT CAUSE: Missing import in auth.ts\nAFFECTED CONTRACT: auth.ts and index.ts\nSURGICAL FIX: import { verifyToken } from "./jwt.js"'
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

  const plan = await ArchitectEngine.diagnose(
    'TS2304: Cannot find name verifyToken',
    'npm run typecheck',
    [],
    context,
    mockProvider
  );

  assert.ok(plan.includes('ROOT CAUSE'));
  assert.ok(plan.includes('SURGICAL FIX'));
  assert.ok(promptSeen.includes('TS2304'));
  assert.ok(promptSeen.includes('EXECUTIVE ARCHITECTURAL DIAGNOSIS'));
});
