import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { resolveFileMentions } from '../src/agent/mentions.js';

test('Mentions - resolve @file syntax correctly', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locode-mention-'));
  const testFilePath = path.join(tmpDir, 'sample.txt');
  await fs.writeFile(testFilePath, 'const value = 42;\nexport default value;', 'utf8');

  // Test mention resolution
  const prompt = 'Can you review @sample.txt and improve it?';
  const res = await resolveFileMentions(prompt, tmpDir);

  assert.deepEqual(res.injectedFiles, ['sample.txt']);
  assert.match(res.processedPrompt, /### File: sample\.txt/);
  assert.match(res.processedPrompt, /const value = 42;/);

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('Mentions - ignore non-existent files gracefully', async () => {
  const prompt = 'Check @nonexistent.js';
  const res = await resolveFileMentions(prompt, process.cwd());
  assert.equal(res.injectedFiles.length, 0);
  assert.equal(res.contextBlock, '');
});
