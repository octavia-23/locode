import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { MultiStrategyEditEngine } from '../src/tools/edit-engine.js';
import { multiEditFileTool } from '../src/tools/file-ops.js';
import { AgentContext } from '../src/types.js';

test('MultiStrategyEditEngine - exact match replacement', () => {
  const file = `function greet() {\n  return "hello";\n}`;
  const res = MultiStrategyEditEngine.apply(file, 'return "hello";', 'return "world";');

  assert.equal(res.success, true);
  assert.equal(res.strategyUsed, 'exact');
  assert.equal(res.content, `function greet() {\n  return "world";\n}`);
});

test('MultiStrategyEditEngine - strips view_file line numbers fallback', () => {
  const file = `const a = 1;\nconst b = 2;\nconst c = 3;`;
  const target = `  2: const b = 2;\n  3: const c = 3;`;
  const replacement = `const b = 20;\nconst c = 30;`;

  const res = MultiStrategyEditEngine.apply(file, target, replacement);
  assert.equal(res.success, true);
  assert.equal(res.strategyUsed, 'clean-line-numbers');
  assert.equal(res.content, `const a = 1;\nconst b = 20;\nconst c = 30;`);
});

test('MultiStrategyEditEngine - whitespace & indentation normalized matching', () => {
  const file = `function compute() {\n    const x = 10;\n    const y = 20;\n    return x + y;\n}`;
  // Target has 2 spaces indentation instead of 4 spaces
  const target = `  const x = 10;\n  const y = 20;`;
  const replacement = `    const x = 100;\n    const y = 200;`;

  const res = MultiStrategyEditEngine.apply(file, target, replacement);
  assert.equal(res.success, true);
  assert.equal(res.strategyUsed, 'whitespace-trimmed');
  assert.ok(res.content.includes('const x = 100;'));
  assert.ok(res.content.includes('return x + y;'));
});

test('MultiStrategyEditEngine - anchor context matching for hallucinated middle line', () => {
  const file = `export function processData(input: string) {\n  const sanitized = input.trim();\n  const tokens = sanitized.split(' ');\n  const count = tokens.length;\n  return { sanitized, count };\n}`;
  // Model hallucinated middle line: "const tokens = input.split(' ');" instead of "sanitized.split(' ');"
  const target = `export function processData(input: string) {\n  const sanitized = input.trim();\n  const tokens = input.split(' ');\n  const count = tokens.length;\n  return { sanitized, count };`;
  const replacement = `export function processData(input: string) {\n  return { count: 0 };\n}`;

  const res = MultiStrategyEditEngine.apply(file, target, replacement);
  assert.equal(res.success, true);
  assert.equal(res.strategyUsed, 'anchor-context');
  assert.ok(res.content.includes('return { count: 0 };'));
});

test('MultiStrategyEditEngine - unified diff patch application', () => {
  const file = `line 1\nline 2\nline 3\nline 4\n`;
  const patch = `@@ -2,2 +2,2 @@\n-line 2\n+line two\n line 3\n`;

  const res = MultiStrategyEditEngine.apply(file, patch, '');
  assert.equal(res.success, true);
  assert.equal(res.strategyUsed, 'unified-diff');
  assert.ok(res.content.includes('line two'));
});

test('MultiStrategyEditEngine - returns actionable closest-match diagnostic when target not found', () => {
  const file = `export function authenticateUser(username: string, token: string) {\n  if (!token) throw new Error("Unauthorized");\n  return true;\n}`;
  const target = `export function authenticateUser(username: string, secretToken: string) {\n  if (!secretToken) throw new Error("Invalid");\n}`;

  const res = MultiStrategyEditEngine.apply(file, target, '...', 'auth.ts');
  assert.equal(res.success, false);
  assert.ok(res.error?.includes('Target content not found in auth.ts'));
  assert.ok(res.error?.includes('Closest matching section in file'));
  assert.ok(res.closestMatch !== undefined);
  assert.equal(res.closestMatch?.startLine, 1);
});

test('MultiStrategyEditEngine - fuzzy hunk matching for minor token variations', () => {
  const file = [
    'export class DatabaseClient {',
    '  private connectionPool: Pool;',
    '  private maxRetryAttempts: number = 3;',
    '  private queryTimeoutMs: number = 5000;',
    '  connect() {',
    '    return this.connectionPool.connect();',
    '  }',
    '}'
  ].join('\n');

  // Slight variation in middle lines (e.g., local model hallucinated "retries" and "timeout")
  const target = [
    '  private connectionPool: Pool;',
    '  private retries: number = 3;',
    '  private timeout: number = 5000;'
  ].join('\n');

  const replacement = [
    '  private connectionPool: Pool;',
    '  private maxRetryAttempts: number = 10;',
    '  private queryTimeoutMs: number = 10000;'
  ].join('\n');

  const res = MultiStrategyEditEngine.apply(file, target, replacement, 'db.ts');
  assert.equal(res.success, true);
  assert.equal(res.strategyUsed, 'fuzzy-hunk');
  assert.ok(res.content.includes('maxRetryAttempts: number = 10;'));
  assert.ok(res.content.includes('queryTimeoutMs: number = 10000;'));
});

test('multiEditFileTool - applies multiple hunks sequentially to a single file', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locode-multiedit-'));
  const filePath = path.join(tmpDir, 'service.ts');
  await fs.writeFile(filePath, 'const a = 1;\nconst b = 2;\nconst c = 3;\n', 'utf8');

  const ctx: AgentContext = {
    cwd: tmpDir,
    autoApprove: true,
    model: 'mock-model'
  };

  const res = await multiEditFileTool.execute({
    path: 'service.ts',
    edits: [
      { target_content: 'const a = 1;', replacement_content: 'const a = 10;' },
      { target_content: 'const c = 3;', replacement_content: 'const c = 30;' }
    ]
  }, ctx);

  assert.equal(res.isError, undefined);
  assert.ok(res.result.includes('Successfully applied 2 edit(s) across 1 file(s)'));

  const updated = await fs.readFile(filePath, 'utf8');
  assert.equal(updated, 'const a = 10;\nconst b = 2;\nconst c = 30;\n');
});

test('multiEditFileTool - applies multi-file atomic edits across multiple distinct files', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locode-multifile-'));
  const file1 = path.join(tmpDir, 'alpha.ts');
  const file2 = path.join(tmpDir, 'beta.ts');
  await fs.writeFile(file1, 'export const alpha = 10;\n', 'utf8');
  await fs.writeFile(file2, 'export const beta = 20;\n', 'utf8');

  const ctx: AgentContext = {
    cwd: tmpDir,
    autoApprove: true,
    model: 'mock-model'
  };

  const res = await multiEditFileTool.execute({
    files: [
      {
        path: 'alpha.ts',
        edits: [{ target_content: 'alpha = 10;', replacement_content: 'alpha = 100;' }]
      },
      {
        path: 'beta.ts',
        edits: [{ target_content: 'beta = 20;', replacement_content: 'beta = 200;' }]
      }
    ]
  }, ctx);

  assert.equal(res.isError, undefined);
  assert.ok(res.result.includes('Successfully applied 2 edit(s) across 2 file(s)'));

  const content1 = await fs.readFile(file1, 'utf8');
  const content2 = await fs.readFile(file2, 'utf8');
  assert.equal(content1, 'export const alpha = 100;\n');
  assert.equal(content2, 'export const beta = 200;\n');
});

test('multiEditFileTool - atomic rollback guarantee: 0 files modified on disk if any hunk fails', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locode-rollback-'));
  const file1 = path.join(tmpDir, 'clean.ts');
  const file2 = path.join(tmpDir, 'strict.ts');
  const origClean = 'export const safeValue = 42;\n';
  const origStrict = 'export const invariant = "immutable";\n';

  await fs.writeFile(file1, origClean, 'utf8');
  await fs.writeFile(file2, origStrict, 'utf8');

  const ctx: AgentContext = {
    cwd: tmpDir,
    autoApprove: true,
    model: 'mock-model'
  };

  // Transaction attempts to modify clean.ts (valid), but fails on strict.ts (invalid target)
  const res = await multiEditFileTool.execute({
    files: [
      {
        path: 'clean.ts',
        edits: [{ target_content: 'safeValue = 42;', replacement_content: 'safeValue = 999;' }]
      },
      {
        path: 'strict.ts',
        edits: [{ target_content: 'non_existent_target_string_123', replacement_content: 'boom' }]
      }
    ]
  }, ctx);

  assert.equal(res.isError, true);
  assert.ok(res.result.includes('Transaction aborted'));
  assert.ok(res.result.includes('ATOMIC ROLLBACK: 0 files modified on disk'));

  // PROVE ATOMIC ROLLBACK: clean.ts must be completely untouched!
  const diskClean = await fs.readFile(file1, 'utf8');
  const diskStrict = await fs.readFile(file2, 'utf8');
  assert.equal(diskClean, origClean, 'File 1 must NOT be modified when subsequent hunk fails');
  assert.equal(diskStrict, origStrict, 'File 2 must remain in original state');
});

test('multiEditFileTool - accepts flat edits array format', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locode-flatedits-'));
  const file1 = path.join(tmpDir, 'f1.ts');
  const file2 = path.join(tmpDir, 'f2.ts');
  await fs.writeFile(file1, 'const x = 1;\n', 'utf8');
  await fs.writeFile(file2, 'const y = 2;\n', 'utf8');

  const ctx: AgentContext = {
    cwd: tmpDir,
    autoApprove: true,
    model: 'mock-model'
  };

  const res = await multiEditFileTool.execute({
    edits: [
      { path: 'f1.ts', target_content: 'const x = 1;', replacement_content: 'const x = 11;' },
      { path: 'f2.ts', target_content: 'const y = 2;', replacement_content: 'const y = 22;' }
    ]
  }, ctx);

  assert.equal(res.isError, undefined);
  assert.ok(res.result.includes('Successfully applied 2 edit(s) across 2 file(s)'));

  assert.equal(await fs.readFile(file1, 'utf8'), 'const x = 11;\n');
  assert.equal(await fs.readFile(file2, 'utf8'), 'const y = 22;\n');
});

test('multiEditFileTool - returns error on empty or invalid inputs', async () => {
  const ctx: AgentContext = {
    cwd: process.cwd(),
    autoApprove: true,
    model: 'mock-model'
  };

  const res = await multiEditFileTool.execute({}, ctx);
  assert.equal(res.isError, true);
  assert.ok(res.result.includes('No valid edits provided'));
});

test('MultiStrategyEditEngine - automatically re-indents replacement to match file indentation', () => {
  const file = 'class MyService {\n    // Target file has 4 spaces\n    run() {\n        return true;\n    }\n}';
  // Local model provided target and replacement with 0 or 2 spaces
  const target = '  run() {\n    return true;\n  }';
  const replacement = '  run() {\n    const active = true;\n    return active;\n  }';

  const res = MultiStrategyEditEngine.apply(file, target, replacement, 'service.ts');
  assert.equal(res.success, true);
  assert.equal(res.strategyUsed, 'whitespace-trimmed');
  // Must be re-indented with 4 spaces matching surrounding code
  assert.ok(res.content.includes('    run() {'));
  assert.ok(res.content.includes('        const active = true;'));
  assert.ok(res.content.includes('        return active;'));
});

test('multiEditFileTool - validateSyntax: true rolls back entire transaction if candidate has syntax errors', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locode-syntax-rollback-'));
  const file1 = path.join(tmpDir, 'serviceA.ts');
  const file2 = path.join(tmpDir, 'serviceB.ts');
  const originalA = 'export function getStatus(): string { return "ok"; }\n';
  const originalB = 'export function calculate(): number { return 100; }\n';

  await fs.writeFile(file1, originalA, 'utf8');
  await fs.writeFile(file2, originalB, 'utf8');

  const ctx: AgentContext = {
    cwd: tmpDir,
    autoApprove: true,
    model: 'mock-model'
  };

  // Transaction: file1 valid change, file2 introduces invalid syntax (unclosed function brace)
  const res = await multiEditFileTool.execute({
    validateSyntax: true,
    files: [
      {
        path: 'serviceA.ts',
        edits: [{ target_content: 'return "ok";', replacement_content: 'return "perfect";' }]
      },
      {
        path: 'serviceB.ts',
        edits: [{ target_content: 'return 100;', replacement_content: 'return 100; unclosed syntax (' }]
      }
    ]
  }, ctx);

  assert.equal(res.isError, true);
  assert.ok(res.result.includes('Syntax error detected in "serviceB.ts"'));
  assert.ok(res.result.includes('ATOMIC ROLLBACK: 0 files modified on disk'));

  // Ensure disk files were NEVER written
  assert.equal(await fs.readFile(file1, 'utf8'), originalA);
  assert.equal(await fs.readFile(file2, 'utf8'), originalB);
});

test('MultiStrategyEditEngine - findClosestMatch returns non-null match when target block has more lines than file', () => {
  // File with only 3 lines
  const file = [
    'function computeScore(user: User, score: number): number {',
    '  return score * 1.5;',
    '}'
  ].join('\n');

  // Target block hallucinated with 6 lines (more lines than the file, and token differences preventing anchor match)
  const longTarget = [
    'function computeScore(user: AppUser, initialScore: number): number {',
    '  const bonus = 1.5;',
    '  const adjusted = initialScore * bonus;',
    '  return adjusted;',
    '  // end calculation',
    '}'
  ].join('\n');

  const res = MultiStrategyEditEngine.apply(file, longTarget, 'replacement', 'math.ts');
  assert.equal(res.success, false);
  assert.ok(res.closestMatch !== undefined && res.closestMatch !== null, 'closestMatch should be non-null even when target has more lines than file');
  assert.equal(res.closestMatch?.startLine, 1);
  assert.ok(res.closestMatch?.content.includes('computeScore'));

  const directMatch = (MultiStrategyEditEngine as any).findClosestMatch(file, longTarget);
  assert.ok(directMatch !== null, 'findClosestMatch should return non-null result');
  assert.equal(directMatch.startLine, 1);
});
