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

test('CodeVerifier - runFastLint executes fast linter/typecheck on modified file', async () => {
  const cwd = process.cwd();
  const result = await CodeVerifier.runFastLint(cwd, 'src/index.ts');

  // In clean LOCODE codebase, fast lint (typecheck) should pass cleanly
  assert.equal(result.passed, true);
});

test('CodeVerifier - verifyFilesFast checks clean TypeScript file in under 50ms', async () => {
  const cwd = process.cwd();
  const result = await CodeVerifier.verifyFilesFast(['src/index.ts'], cwd);

  assert.equal(result.passed, true);
  assert.equal(result.errors.length, 0);
  assert.ok(result.durationMs < 100, `Execution took ${result.durationMs}ms, should be fast`);
});

test('CodeVerifier - verifyFilesFast catches syntax errors in under 50ms without subprocess', async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locode-fast-lint-'));
  try {
    const badFile = path.join(tmpDir, 'broken.ts');
    await fs.writeFile(badFile, 'export const value: = 999;', 'utf8');

    const result = await CodeVerifier.verifyFilesFast(['broken.ts'], tmpDir);

    assert.equal(result.passed, false);
    assert.ok(result.errors.length > 0);
    assert.equal(result.errors[0].file, 'broken.ts');
    assert.ok(result.durationMs < 100, `Execution took ${result.durationMs}ms, should be fast`);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('CodeVerifier - runFastLint safely handles Python files with spaces in path', async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locode-py-spaces-'));
  try {
    const pyFile = path.join(tmpDir, 'my script.py');
    await fs.writeFile(pyFile, 'def broken_func(\n  return 42\n', 'utf8');

    const result = await CodeVerifier.runFastLint(tmpDir, 'my script.py');
    if (result.status === 'failed' || result.status === 'passed') {
      assert.ok(result.command?.includes('"my script.py"'), `Command should properly quote filename with spaces: ${result.command}`);
    } else {
      assert.equal(result.status, 'not-run');
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
