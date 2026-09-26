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
