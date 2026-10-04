import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { CodeVerifier } from '../src/agent/verifier.js';

test('CodeVerifier - detectCommand detects typecheck or test in Node project', async () => {
  const cwd = process.cwd();
  const cmd = await CodeVerifier.detectCommand(cwd);

  assert.ok(cmd, 'Should detect a verification command in LOCODE project root');
  assert.equal(cmd, 'npm run typecheck', 'Should prioritize npm run typecheck for TypeScript project');
});

test('CodeVerifier - run executes successfully on clean project', async () => {
  const cwd = process.cwd();
  const result = await CodeVerifier.run(cwd, 'echo "Test passed"');

  assert.equal(result.passed, true);
  assert.equal(result.command, 'echo "Test passed"');
  assert.match(result.output || '', /Test passed/);
});

test('CodeVerifier - captures and sanitizes errors on failure', async () => {
  const cwd = process.cwd();
  const result = await CodeVerifier.run(cwd, 'node -e "console.error(\'TS2339: Property foo does not exist\'); process.exit(1)"');

  assert.equal(result.passed, false);
  assert.match(result.errorOutput || '', /TS2339/);
});
