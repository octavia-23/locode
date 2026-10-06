import test from 'node:test';
import assert from 'node:assert/strict';
import { ContextManager } from '../src/agent/context.js';

test('Context Compaction - preserves critical stack traces and compiler errors', () => {
  const cm = new ContextManager(500);

  const errorOutput = `
> test-project@1.0.0 test
> tsc --noEmit

src/agent/auth.ts:14:25 - error TS2339: Property 'verifyToken' does not exist on type 'AuthService'.
  14 const token = authService.verifyToken(req.headers.auth);
                               ~~~~~~~~~~~
src/agent/auth.ts:28:10 - error TS2304: Cannot find name 'JwtPayload'.
  28 interface Decoded extends JwtPayload {}
                               ~~~~~~~~~~

Found 2 errors in 2 files.
Errors  Files
     2  src/agent/auth.ts:14
` + 'Extra verbose build logging line\n'.repeat(40);

  const compacted = cm.compactToolOutput(errorOutput, 400);

  // Critical error information MUST survive compaction
  assert.ok(compacted.includes('TS2339'), 'TS2339 error code must survive compaction');
  assert.ok(compacted.includes('TS2304'), 'TS2304 error code must survive compaction');
  assert.ok(compacted.includes('auth.ts:14'), 'File name and line number must survive compaction');
  assert.ok(compacted.includes('verifyToken'), 'Failing property/function name must survive compaction');
  assert.ok(compacted.length < errorOutput.length, 'Compacted output must be substantially smaller than raw output');
});

test('Context Compaction - message history respects token budget', () => {
  const cm = new ContextManager(1000);

  const messages = [
    { role: 'system' as const, content: 'You are Locode CLI.' },
    { role: 'user' as const, content: 'Run test suite' },
    {
      role: 'tool' as const,
      content: 'TypeError: Cannot read properties of undefined (reading "id")\n  at getUser (src/user.ts:42:15)\n' + 'Filler log line\n'.repeat(50)
    },
    { role: 'assistant' as const, content: 'I will analyze the error and fix it.' },
    { role: 'user' as const, content: 'Please proceed' }
  ];

  const compacted = cm.compactMessages(messages);
  assert.equal(compacted.length, 5);
  // Tool output compacted while preserving TypeError & stack trace
  assert.ok(compacted[2].content.includes('TypeError'));
  assert.ok(compacted[2].content.includes('src/user.ts:42'));
});

test('Context Compaction - prefix stability preserves message identity when below budget', () => {
  const cm = new ContextManager(8192);

  const messages = [
    { role: 'system' as const, content: 'You are Locode CLI.' },
    { role: 'user' as const, content: 'Read package.json' },
    { role: 'tool' as const, content: '{"name": "test"}' },
    { role: 'assistant' as const, content: 'Package name is test.' }
  ];

  // Under budget: compactMessages must return exact same array reference for 100% KV cache hit
  const result = cm.compactMessages(messages);
  assert.equal(result, messages, 'Messages array should be returned untouched for KV cache stability');
});

test('Context Compaction - folds retain synthesized findings', () => {
  const cm = new ContextManager(500);

  const messages = [
    { role: 'system' as const, content: 'System instruction' },
    { role: 'user' as const, content: 'Initial user prompt' },
    { role: 'tool' as const, content: 'Tool outcome line\n'.repeat(50) },
    { role: 'assistant' as const, content: 'Thought line\n'.repeat(50) },
    { role: 'user' as const, content: 'Followup user prompt' },
    { role: 'tool' as const, content: 'Another tool result\n'.repeat(50) },
    { role: 'assistant' as const, content: 'Recent assistant output' }
  ];

  const digest = 'Discovered auth bug in src/auth.ts at line 42.';
  const compacted = cm.compactMessages(messages, digest);

  const restored = compacted.find(m => m.content.includes('[SESSION CONTEXT RESTORED FROM COMPACT STATE]'));
  assert.ok(restored, 'Should contain restored context message');
  assert.ok(restored.content.includes(digest), 'Synthesized findings must be preserved in compact state');
});
