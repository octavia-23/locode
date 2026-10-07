import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { viewFileTool, writeFileTool, editFileTool } from '../src/tools/file-ops.js';
import { listDirTool, searchCodeTool } from '../src/tools/search.js';
import { runCommandTool } from '../src/tools/terminal.js';
import { ContextManager } from '../src/agent/context.js';
import { AgentContext } from '../src/types.js';

test('File Operations - write_file, view_file, and edit_file', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locode-test-'));
  const ctx: AgentContext = {
    cwd: tmpDir,
    autoApprove: true,
    model: 'qwen2.5-coder:7b',
    ollamaHost: 'http://127.0.0.1:11434'
  };

  // 1. write_file
  const writeRes = await writeFileTool.execute({
    path: 'sample.txt',
    content: 'Line 1\nHello World\nLine 3\n'
  }, ctx);
  assert.equal(writeRes.isError, undefined);

  // 2. view_file
  const viewRes = await viewFileTool.execute({
    path: 'sample.txt',
    start_line: 1,
    end_line: 2
  }, ctx);
  assert.equal(viewRes.isError, undefined);
  assert.match(viewRes.result, /Hello World/);

  // 3. edit_file
  const editRes = await editFileTool.execute({
    path: 'sample.txt',
    target_content: 'Hello World',
    replacement_content: 'Hello Antigravity'
  }, ctx);
  assert.equal(editRes.isError, undefined);

  // 4. Verify edit
  const updated = await fs.readFile(path.join(tmpDir, 'sample.txt'), 'utf8');
  assert.match(updated, /Hello Antigravity/);

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('Search Operations - list_dir and search_code', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locode-search-'));
  const ctx: AgentContext = {
    cwd: tmpDir,
    autoApprove: true,
    model: 'qwen2.5-coder:7b',
    ollamaHost: 'http://127.0.0.1:11434'
  };

  await fs.writeFile(path.join(tmpDir, 'app.ts'), 'export const SECRET_KEY = "XYZ123";\n', 'utf8');

  // list_dir
  const listRes = await listDirTool.execute({ path: '.' }, ctx);
  assert.equal(listRes.isError, undefined);
  assert.match(listRes.result, /app\.ts/);

  // search_code
  const searchRes = await searchCodeTool.execute({ pattern: 'SECRET_KEY' }, ctx);
  assert.equal(searchRes.isError, undefined);
  assert.match(searchRes.result, /app\.ts:1:/);

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('ContextManager - token estimation & compaction', () => {
  const cm = new ContextManager(1000);
  assert.ok(cm.estimateTokens('Hello World') > 0);

  const msgs = [
    { role: 'system' as const, content: 'System instruction' },
    { role: 'user' as const, content: 'User goal' },
    { role: 'tool' as const, content: 'A'.repeat(3000) },
    { role: 'assistant' as const, content: 'Assistant step' },
    { role: 'user' as const, content: 'Followup' }
  ];

  const compacted = cm.compactMessages(msgs);
  assert.equal(compacted.length, msgs.length);
  assert.match(compacted[2].content, /\[Output compacted:/);
});

test('Terminal - runCommandTool executes git commands and Windows shims cleanly', async () => {
  const ctx: AgentContext = {
    cwd: process.cwd(),
    autoApprove: true,
    model: 'locode-qwen35b-a3b'
  };

  // 1. git status
  const gitStatusRes = await runCommandTool.execute({ command: 'git status --short' }, ctx);
  assert.equal(gitStatusRes.isError, undefined, 'git status should not return error');
  assert.ok(typeof gitStatusRes.result === 'string');

  // 2. git diff
  const gitDiffRes = await runCommandTool.execute({ command: 'git diff --stat' }, ctx);
  assert.equal(gitDiffRes.isError, undefined, 'git diff should not return error');

  // 3. wc -l shim
  const wcRes = await runCommandTool.execute({ command: 'wc -l package.json' }, ctx);
  assert.equal(wcRes.isError, undefined, 'wc -l shim should succeed on Windows');
  assert.match(wcRes.result, /\d+\s+package\.json/);
});

test('File Operations - edit_file strips accidental view_file line numbers and whitespace', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locode-fuzzy-test-'));
  const ctx: AgentContext = {
    cwd: tmpDir,
    autoApprove: true,
    model: 'locode-qwen35b-a3b'
  };

  const sampleFile = path.join(tmpDir, 'test.css');
  await fs.writeFile(sampleFile, 'body {\n  margin: 0;\n  padding: 0;\n}\n', 'utf8');

  // Model passes target with line numbers: "   2:   margin: 0;\n   3:   padding: 0;"
  const editWithLineNumbers = await editFileTool.execute({
    path: 'test.css',
    target_content: '   2:   margin: 0;\n   3:   padding: 0;',
    replacement_content: '   2:   margin: 10px;\n   3:   padding: 10px;'
  }, ctx);

  assert.equal(editWithLineNumbers.isError, undefined, 'edit_file should succeed despite line numbers');
  const content = await fs.readFile(sampleFile, 'utf8');
  assert.match(content, /margin: 10px;/);
  assert.match(content, /padding: 10px;/);

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('File Operations - batch_read_files inspects multiple files in one call', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locode-batch-read-'));
  const ctx: AgentContext = {
    cwd: tmpDir,
    autoApprove: true,
    model: 'locode-qwen35b-a3b'
  };

  await fs.writeFile(path.join(tmpDir, 'fileA.ts'), 'export const a = 1;\n', 'utf8');
  await fs.writeFile(path.join(tmpDir, 'fileB.ts'), 'export const b = 2;\n', 'utf8');

  const { batchReadFilesTool } = await import('../src/tools/file-ops.js');
  const res = await batchReadFilesTool.execute({
    paths: ['fileA.ts', 'fileB.ts']
  }, ctx);

  assert.equal(res.isError, undefined);
  assert.match(res.result, /fileA\.ts/);
  assert.match(res.result, /export const a = 1;/);
  assert.match(res.result, /fileB\.ts/);
  assert.match(res.result, /export const b = 2;/);

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('SessionMemory - persists and restores conversation and decisions', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locode-memory-'));
  const { SessionMemory } = await import('../src/agent/memory.js');
  const memory = new SessionMemory(tmpDir);

  assert.equal(await memory.hasPreviousSession(), false);

  await memory.saveSession({
    model: 'qwen2.5-coder:7b',
    messages: [
      { role: 'user', content: 'Fix the login bug' },
      { role: 'assistant', content: 'Fixed the login bug in auth.ts' }
    ],
    lastDecisions: ['Used JWT token expiration'],
    recentFiles: ['src/auth.ts']
  });

  assert.equal(await memory.hasPreviousSession(), true);

  const restored = await memory.loadSession();
  assert.ok(restored);
  assert.equal(restored.messages.length, 2);
  assert.equal(restored.messages[0].content, 'Fix the login bug');
  assert.deepEqual(restored.lastDecisions, ['Used JWT token expiration']);
  assert.deepEqual(restored.recentFiles, ['src/auth.ts']);

  await memory.clearSession();
  assert.equal(await memory.hasPreviousSession(), false);

  await fs.rm(tmpDir, { recursive: true, force: true });
});
