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

test('Context Compaction - evicts older file inspections from prompt history while preserving references', () => {
  const cm = new ContextManager(2000);

  const messages = [
    { role: 'system' as const, content: 'System instruction' },
    { role: 'user' as const, content: 'Please inspect the files' },
    {
      role: 'tool' as const,
      content: 'File: src/heavy.ts (lines 1-200 of 500)\n' + '1: const x = 1;\n'.repeat(200)
    },
    { role: 'assistant' as const, content: 'Now inspecting second file.' },
    { role: 'user' as const, content: 'Proceed' },
    {
      role: 'tool' as const,
      content: 'File: src/second.ts (lines 1-10 of 10)\n1: const y = 2;\n'
    },
    { role: 'assistant' as const, content: 'Analysis done.' }
  ];

  const compacted = cm.compactMessages(messages);
  // Older file inspection at index 2 should have its raw code lines evicted into a compact pointer
  assert.ok(compacted[2].content.includes('[File inspection: src/heavy.ts'), 'Old file inspection must be evicted to reference');
  assert.ok(compacted[2].content.includes('Call view_file again'), 'Placeholder must tell the model how to recover the contents');
  assert.ok(!compacted[2].content.includes('const x = 1;\n1: const x = 1;'), 'Raw 200 lines of code must not be kept');
  // Recent file at index 5 should remain intact
  assert.ok(compacted[5].content.includes('src/second.ts'), 'Recent file must be preserved');
});

test('Context Compaction - tool schema overhead is factored into budget calculation', () => {
  const cm = new ContextManager(32768);
  const budgetDefault = cm.getAvailableContextBudget(2500);
  const budgetNoTools = cm.getAvailableContextBudget(0);

  assert.ok(budgetDefault < budgetNoTools, 'Budget with tool overhead must reserve room for tool schemas');
  assert.ok(budgetDefault <= 32768 - 2500, 'Budget must not allow conversation to reach raw context limit');
});

test('Context Compaction - emergency ceiling cap guarantees total tokens fit within budget', () => {
  const cm = new ContextManager(1000);

  const messages = [
    { role: 'system' as const, content: 'System instruction' },
    { role: 'user' as const, content: 'Run command' },
    { role: 'tool' as const, content: 'Extremely long log output line.\n'.repeat(300) },
    { role: 'assistant' as const, content: 'Analysis' }
  ];

  const compacted = cm.compactMessages(messages);
  const estimatedTokens = cm.estimateMessagesTokens(compacted);
  const budget = cm.getAvailableContextBudget(0);

  assert.ok(estimatedTokens <= budget, `Estimated tokens (${estimatedTokens}) must not exceed budget (${budget})`);
});

test('Context Compaction - duplicate outputs below budget do not evict earlier file source', () => {
  const cm = new ContextManager(8192);
  const fileOutput = 'File: src/example.ts (lines 1-3 of 3)\n1: export const a = 1;\n2: export const b = 2;\n3: export const c = 3;';
  const messages = [
    { role: 'system' as const, content: 'System prompt' },
    { role: 'user' as const, content: 'Fix the implementation.' },
    { role: 'tool' as const, content: fileOutput },
    { role: 'assistant' as const, content: 'I inspected the file.' },
    { role: 'tool' as const, content: 'Directory contents: src, tests' },
    { role: 'tool' as const, content: 'Directory contents: src, tests' },
    { role: 'assistant' as const, content: 'I will use the inspected code.' }
  ];

  const result = cm.compactMessages(messages);
  assert.notEqual(result, messages, 'Exact duplicate results may be deduplicated');
  assert.ok(result[2].content.includes('export const a = 1;'), 'Original source output must remain available');
  assert.ok(!result[2].content.includes('raw code lines folded for token budget'), 'Below-budget duplicate output must not trigger full history compaction');
  assert.equal(cm.getStats().compactionRuns, 0, 'A duplicate below budget must not count as a compaction run');
});

test('Context Engine - any file invalidation clears stale verification', () => {
  const engine = new ContextManager(8192);
  engine.recordVerificationResult(true, 'npm test');
  assert.equal(engine.getTaskState().lastVerification?.passed, true);

  engine.invalidateFile('src/changed.ts');
  assert.equal(engine.getTaskState().lastVerification, undefined, 'Verification must be invalidated as soon as a file is edited');
});

test('Context Compaction - re-reading a folded file always returns its contents (regression: re-read loop)', () => {
  const cm = new ContextManager(8192);
  const viewOut = 'File: src/app.ts (lines 1-120 of 120)\n' +
    Array.from({ length: 120 }, (_, i) => `${i + 1}: const value${i} = compute(${i}); // code`).join('\n');
  const messages: any[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'fix the bug in src/app.ts' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'a', function: { name: 'view_file', arguments: { path: 'src/app.ts' } } }] },
    { role: 'tool', content: viewOut },
    { role: 'assistant', content: '', tool_calls: [{ id: 'b', function: { name: 'search_code', arguments: {} } }] },
    { role: 'tool', content: 'src/app.ts:10: something\n'.repeat(40) },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c', function: { name: 'view_file', arguments: { path: 'src/app.ts' } } }] },
    { role: 'tool', content: viewOut }
  ];
  const compacted = cm.compactMessages(messages);
  assert.ok(compacted[compacted.length - 1].content.includes('compute(50)'), 'newest view_file result must stay intact');
});

test('Context Compaction - Tier 1 pruneStaleToolOutputs replaces superseded view_file with turn pointer', () => {
  const cm = new ContextManager(16384);
  const fileContentV1 = 'File: src/service.ts (lines 1-50 of 50)\n' + 'const line = 1;\n'.repeat(50);
  const fileContentV2 = 'File: src/service.ts (lines 1-50 of 50)\n' + 'const line = 2;\n'.repeat(50);

  const messages: any[] = [
    { role: 'system', content: 'You are Locode CLI.' },
    { role: 'user', content: 'Inspect and fix src/service.ts' },
    // Turn 1: view_file
    {
      role: 'assistant',
      content: 'Inspecting src/service.ts',
      tool_calls: [{ id: 'tc1', function: { name: 'view_file', arguments: { path: 'src/service.ts', startLine: 1, endLine: 50 } } }]
    },
    { role: 'tool', tool_call_id: 'tc1', content: fileContentV1 },
    // Turn 2: edit_file
    {
      role: 'assistant',
      content: 'Editing src/service.ts',
      tool_calls: [{ id: 'tc2', function: { name: 'edit_file', arguments: { path: 'src/service.ts' } } }]
    },
    { role: 'tool', tool_call_id: 'tc2', content: '✓ Successfully updated src/service.ts' },
    // Turn 3: view_file again
    {
      role: 'assistant',
      content: 'Verifying src/service.ts',
      tool_calls: [{ id: 'tc3', function: { name: 'view_file', arguments: { path: 'src/service.ts', startLine: 1, endLine: 50 } } }]
    },
    { role: 'tool', tool_call_id: 'tc3', content: fileContentV2 }
  ];

  cm.pruneStaleToolOutputs(messages);

  // Turn 1 view_file must be superseded
  assert.ok(messages[3].content.startsWith('[Superseded view_file of src/service.ts; latest state is in turn #3]'), 'Turn 1 view_file must point to Turn 3');
  assert.ok(!messages[3].content.includes('const line = 1;'), 'Old file content lines must be removed');

  // Turn 3 view_file must remain intact
  assert.equal(messages[7].content, fileContentV2, 'Latest view_file must stay intact');
});

test('Context Compaction - Tier 1 pruneStaleToolOutputs folds error traces when verification passes', () => {
  const cm = new ContextManager(16384);
  const verboseTrace = [
    '> test-runner',
    'FAIL tests/service.test.ts',
    '  ● Service › returns expected token',
    '    AssertionError: expected "foo" to equal "bar"',
    '      at Object.<anonymous> (tests/service.test.ts:18:12)',
    '      at Promise.then.completed (node_modules/jest/build/runner.js:55:10)',
    '      at runTest (node_modules/jest/build/runner.js:120:14)',
    '      at async TestScheduler.scheduleTests (node_modules/jest/build/scheduler.js:300:20)',
    '      at async runCLI (node_modules/jest/build/cli.js:410:15)'
  ].join('\n');

  const messages: any[] = [
    { role: 'system', content: 'You are Locode CLI.' },
    { role: 'user', content: 'Run tests' },
    // Turn 1: failed test run
    { role: 'assistant', content: 'Running tests', tool_calls: [{ id: 't1', function: { name: 'run_command', arguments: { command: 'npm test' } } }] },
    { role: 'tool', tool_call_id: 't1', content: verboseTrace },
    // Turn 2: edit file
    { role: 'assistant', content: 'Fixing bug', tool_calls: [{ id: 't2', function: { name: 'edit_file', arguments: { path: 'src/service.ts' } } }] },
    { role: 'tool', tool_call_id: 't2', content: '✓ Successfully updated src/service.ts' },
    // Turn 3: test passes
    { role: 'assistant', content: 'Re-running tests', tool_calls: [{ id: 't3', function: { name: 'run_command', arguments: { command: 'npm test' } } }] },
    { role: 'tool', tool_call_id: 't3', content: '✓ Verification passed: `npm test` exited with 0 errors.' }
  ];

  cm.pruneStaleToolOutputs(messages);

  // Turn 1 error output must be folded to 5 lines + summary
  assert.ok(messages[3].content.includes('AssertionError: expected "foo" to equal "bar"'), 'Key assertion line must be retained in first 5 lines');
  assert.ok(messages[3].content.includes('[Remaining 4 lines of resolved error trace folded; verification subsequently passed]'), 'Folded summary note must be appended');
  assert.ok(!messages[3].content.includes('runCLI'), 'Deep stack trace lines beyond line 5 must be pruned');
});

test('Context Compaction - Tier 2 compact folds middle turns into structured <context_checkpoint>', () => {
  const cm = new ContextManager(1000); // Low budget to force compaction
  cm.setObjective('Refactor auth module and pass tests');
  cm.addDecision('Use JWT with RS256 signing');
  cm.recordFileRead('src/auth.ts', 'export const verify = () => true;');
  cm.recordVerificationResult(true, 'npm test');

  const messages: any[] = [
    { role: 'system', content: 'System instruction' },
    { role: 'user', content: 'Refactor auth module and pass tests' },
    // Old middle turns that will be folded
    { role: 'assistant', content: 'Inspecting directory structure.' },
    { role: 'tool', content: 'dir listing: src/, tests/, package.json\n'.repeat(60) },
    { role: 'assistant', content: 'Checking package.json dependencies.' },
    { role: 'tool', content: 'dependencies: jsonwebtoken, jest\n'.repeat(60) },
    // Recent turns to preserve
    { role: 'assistant', content: 'Editing auth service.' },
    { role: 'tool', content: '✓ Successfully updated src/auth.ts' },
    { role: 'assistant', content: 'Running verification.' },
    { role: 'tool', content: '✓ Verification passed: `npm test` exited with 0 errors.' }
  ];

  const compacted = cm.compact(messages, { keepRecentMessages: 4 });

  // System prompt and original user prompt preserved
  assert.equal(compacted[0].role, 'system');
  assert.equal(compacted[1].role, 'user');
  assert.equal(compacted[1].content, 'Refactor auth module and pass tests');

  // Folded checkpoint message exists
  const checkpointMsg = compacted.find(m => m.content.includes('<context_checkpoint>'));
  assert.ok(checkpointMsg, 'Must contain a <context_checkpoint> block');
  assert.ok(checkpointMsg.content.includes('### Active Goal & Constraints'), 'Must contain Active Goal & Constraints section');
  assert.ok(checkpointMsg.content.includes('### Completed Milestones & Verified Edits'), 'Must contain Completed Milestones section');
  assert.ok(checkpointMsg.content.includes('### Working Set Files'), 'Must contain Working Set Files section');
  assert.ok(checkpointMsg.content.includes('### Key Decisions & Rejected Approaches'), 'Must contain Key Decisions section');
  assert.ok(checkpointMsg.content.includes('RS256 signing'), 'Must contain durable decision');
  assert.ok(checkpointMsg.content.includes('src/auth.ts'), 'Must contain relevant working set file');

  // Recent 4 messages preserved
  const lastFour = compacted.slice(-4);
  assert.equal(lastFour[0].content, 'Editing auth service.');
  assert.equal(lastFour[1].content, '✓ Successfully updated src/auth.ts');
  assert.equal(lastFour[2].content, 'Running verification.');
  assert.equal(lastFour[3].content, '✓ Verification passed: `npm test` exited with 0 errors.');
});

test('Context Compaction - SessionMemory and journal snapshots store checkpoint', async () => {
  const { SessionMemory } = await import('../src/agent/memory.js');
  const { ExecutionJournal } = await import('../src/journal/journal.js');
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const os = await import('node:os');

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locode-compact-test-'));
  try {
    const memory = new SessionMemory(tmpDir);
    const journal = new ExecutionJournal({ cwd: tmpDir });
    await journal.init();

    const sampleCheckpoint = '<context_checkpoint>\n### Active Goal & Constraints\nGoal: Pass tests\n</context_checkpoint>';

    // Save session with checkpoint
    await memory.saveSession({
      model: 'test-model',
      messages: [{ role: 'user', content: 'test' }],
      checkpoint: sampleCheckpoint
    });

    const loaded = await memory.loadSession();
    assert.equal(loaded?.checkpoint, sampleCheckpoint, 'SessionMemory must persist and restore checkpoint');

    // Create journal snapshot with checkpoint
    const snapshot = await journal.createSnapshot({
      checkpoint: sampleCheckpoint
    });
    assert.equal(snapshot.checkpoint, sampleCheckpoint, 'ExecutionJournal must persist checkpoint in snapshot');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
