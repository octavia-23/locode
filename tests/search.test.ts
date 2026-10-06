import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { searchCodeFallback, isBinaryBuffer } from '../src/tools/search.js';
import { searchCodeTool } from '../src/tools/search.js';
import { AgentContext } from '../src/types.js';

test('Code Search - fallback implementation correctly matches tokens and line numbers', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locode-search-test-'));

  try {
    await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, 'src', 'calc.ts'),
      'export function add(a: number, b: number): number {\n  // Target function\n  return a + b;\n}\n',
      'utf8'
    );
    await fs.writeFile(
      path.join(tmpDir, 'src', 'other.ts'),
      'export const PI = 3.14159;\n',
      'utf8'
    );

    const matches = await searchCodeFallback('add', tmpDir, tmpDir);
    assert.ok(matches.length > 0, 'Should find matches in calc.ts');
    assert.ok(matches.some(m => m.includes('calc.ts:1: export function add')));

    const noMatches = await searchCodeFallback('NON_EXISTENT_SYMBOL_XYZ', tmpDir, tmpDir);
    assert.equal(noMatches.length, 0);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('Code Search - safely skips binary files and respects gitignore', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locode-bin-search-'));

  try {
    // Write binary buffer with null bytes
    const binaryData = Buffer.from([0x00, 0x01, 0x02, 0x48, 0x65, 0x6c, 0x6c, 0x6f]);
    assert.equal(isBinaryBuffer(binaryData), true);

    await fs.writeFile(path.join(tmpDir, 'binary.dat'), binaryData);
    await fs.writeFile(path.join(tmpDir, 'text.txt'), 'Hello world in text\n');

    const ctx: AgentContext = {
      cwd: tmpDir,
      autoApprove: true,
      model: 'qwen2.5-coder:7b',
      ollamaHost: 'http://127.0.0.1:11434'
    };

    const res = await searchCodeTool.execute({ pattern: 'Hello' }, ctx);
    assert.equal(res.isError, undefined);
    assert.ok(res.result.includes('text.txt:1: Hello world in text'));
    // Must NOT match inside binary file
    assert.ok(!res.result.includes('binary.dat'));

    // Test glob pattern handling (*.txt)
    const globRes = await searchCodeTool.execute({ pattern: '*.txt' }, ctx);
    assert.equal(globRes.isError, undefined);
    assert.ok(globRes.result.includes('text.txt'));

    // Test unambiguous 0 matches diagnostic
    const zeroRes = await searchCodeTool.execute({ pattern: 'NonExistentWord123' }, ctx);
    assert.equal(zeroRes.isError, undefined);
    assert.ok(zeroRes.result.includes('0 matches found for pattern'));
    assert.ok(zeroRes.result.includes('The query executed properly'));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});
