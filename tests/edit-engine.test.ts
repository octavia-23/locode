import test from 'node:test';
import assert from 'node:assert/strict';
import { MultiStrategyEditEngine } from '../src/tools/edit-engine.js';

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
