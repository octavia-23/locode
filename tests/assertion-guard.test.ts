import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { TestAssertionGuard } from '../src/engine/assertion-guard.js';
import { editFileTool, writeFileTool, multiEditFileTool } from '../src/tools/file-ops.js';
import { AgentContext } from '../src/types.js';

test('TestAssertionGuard - classifies test files vs production files accurately across languages', () => {
  // Test paths
  assert.equal(TestAssertionGuard.isTestFile('tests/math.test.ts'), true);
  assert.equal(TestAssertionGuard.isTestFile('src/__tests__/auth.spec.js'), true);
  assert.equal(TestAssertionGuard.isTestFile('test_parser.py'), true);
  assert.equal(TestAssertionGuard.isTestFile('backend/api_test.go'), true);
  assert.equal(TestAssertionGuard.isTestFile('tests/integration.rs'), true);
  assert.equal(TestAssertionGuard.isTestFile('specs/engine.spec.tsx'), true);

  // Production paths
  assert.equal(TestAssertionGuard.isTestFile('src/math.ts'), false);
  assert.equal(TestAssertionGuard.isTestFile('src/components/button.tsx'), false);
  assert.equal(TestAssertionGuard.isTestFile('lib/server.py'), false);
  assert.equal(TestAssertionGuard.isTestFile('package.json'), false);
  assert.equal(TestAssertionGuard.isTestFile('Cargo.toml'), false);
});

test('TestAssertionGuard - counts active assertions and ignores comments across languages', () => {
  const tsSample = `
    test('sample', () => {
      const a = 1;
      assert.equal(a, 1);
      expect(a).toBe(1);
      // assert.equal(a, 999);
      /*
        expect(a).toEqual(999);
      */
    });
  `;
  assert.equal(TestAssertionGuard.countAssertions(tsSample), 2);

  const pySample = `
    def test_example(self):
      assert x == 5
      self.assertEqual(y, 10)
      # assert z == 99
      """
      self.assertTrue(False)
      """
  `;
  assert.equal(TestAssertionGuard.countAssertions(pySample), 2);

  const rustSample = `
    #[test]
    fn test_calc() {
      assert_eq!(2 + 2, 4);
      assert!(true_val);
      // assert_ne!(4, 4);
    }
  `;
  assert.equal(TestAssertionGuard.countAssertions(rustSample), 2);
});

test('TestAssertionGuard - allows modifications to production (non-test) files without restriction', () => {
  const oldCode = 'export const add = (a, b) => 0;';
  const newCode = 'export const add = (a, b) => a + b;';
  const res = TestAssertionGuard.validateEdit('src/math.ts', oldCode, newCode, false);
  assert.equal(res.allowed, true);
  assert.equal(res.violation, undefined);
});

test('TestAssertionGuard - allows adding new tests and assertions to test files', () => {
  const oldTest = `
    test('existing', () => {
      assert.equal(add(1, 1), 2);
    });
  `;
  const newTest = `
    test('existing', () => {
      assert.equal(add(1, 1), 2);
    });
    test('new case', () => {
      assert.equal(add(2, 2), 4);
      assert.ok(true);
    });
  `;
  const res = TestAssertionGuard.validateEdit('tests/math.test.ts', oldTest, newTest, false);
  assert.equal(res.allowed, true);
});

test('TestAssertionGuard - strictly blocks deleting assertions in test files', () => {
  const oldTest = `
    test('token check', () => {
      const token = getToken();
      assert.equal(token, "secret");
      expect(token).toBe("secret");
    });
  `;
  // Model deletes assert.equal
  const tampered = `
    test('token check', () => {
      const token = getToken();
      expect(token).toBe("secret");
    });
  `;
  const res = TestAssertionGuard.validateEdit('tests/auth.test.ts', oldTest, tampered, false);
  assert.equal(res.allowed, false);
  assert.equal(res.violation?.type, 'deleted_assertion');
  assert.ok(res.reason?.includes('TEST ASSERTION TAMPERING BLOCKED'));
  assert.ok(res.reason?.includes('Assertion count reduced'));
});

test('TestAssertionGuard - strictly blocks commenting out assertions in test files', () => {
  const oldTest = `
    test('token check', () => {
      const token = getToken();
      assert.equal(token, "secret");
    });
  `;
  // Model comments out the failing assertion
  const commentedOut = `
    test('token check', () => {
      const token = getToken();
      // assert.equal(token, "secret");
    });
  `;
  const res = TestAssertionGuard.validateEdit('tests/auth.test.ts', oldTest, commentedOut, false);
  assert.equal(res.allowed, false);
  assert.equal(res.violation?.type, 'deleted_assertion');
  assert.ok(res.reason?.includes('Assertion count reduced'));
});

test('TestAssertionGuard - strictly blocks deleting entire test cases', () => {
  const oldTest = `
    test('case 1', () => {
      assert.equal(1, 1);
    });
    test('failing edge case', () => {
      assert.equal(compute(), 42);
    });
  `;
  // Model deletes the failing edge case
  const tampered = `
    test('case 1', () => {
      assert.equal(1, 1);
    });
  `;
  const res = TestAssertionGuard.validateEdit('tests/edge.test.ts', oldTest, tampered, false);
  assert.equal(res.allowed, false);
  assert.equal(res.violation?.type, 'deleted_assertion');
});

test('TestAssertionGuard - strictly blocks trivializing assertions with dummy passes', () => {
  const oldTest = `
    test('strict check', () => {
      assert.equal(calculate(), 999);
    });
  `;
  // Model replaces calculation check with dummy assert.ok(true)
  const trivialized = `
    test('strict check', () => {
      assert.ok(true);
    });
  `;
  const res = TestAssertionGuard.validateEdit('tests/strict.test.ts', oldTest, trivialized, false);
  assert.equal(res.allowed, false);
  assert.ok(res.violation?.type === 'trivialized_assertion' || res.violation?.type === 'deleted_assertion');
});

test('TestAssertionGuard - permits test edits when allowTestEdits is explicitly authorized', () => {
  const oldTest = `
    test('legacy test', () => {
      assert.equal(legacyFn(), 10);
    });
  `;
  const refactored = `
    test('v2 test', () => {
      assert.equal(v2Fn(), 20);
    });
  `;
  // With allowTestEdits = true, the edit is permitted
  const res = TestAssertionGuard.validateEdit('tests/api.test.ts', oldTest, refactored, true);
  assert.equal(res.allowed, true);
});

test('TestAssertionGuard Integration - editFileTool blocks assertion deletion on disk and preserves original file', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locode-guard-test-'));
  const testFilePath = path.join(tmpDir, 'service.test.ts');
  const originalContent = `
import { test } from 'node:test';
import assert from 'node:assert';

test('critical service test', () => {
  const val = getServiceVal();
  assert.equal(val, 42);
});
  `;
  await fs.writeFile(testFilePath, originalContent, 'utf8');

  const ctx: AgentContext = {
    cwd: tmpDir,
    autoApprove: true,
    model: 'mock-model',
    ollamaHost: 'http://localhost'
  };

  // 1. Attempt to delete the assertion
  const editRes = await editFileTool.execute({
    path: 'service.test.ts',
    target_content: 'assert.equal(val, 42);',
    replacement_content: '// assertion deleted to make tests pass'
  }, ctx);

  // Must fail with isError: true
  assert.equal(editRes.isError, true);
  assert.ok(editRes.result.includes('TEST ASSERTION TAMPERING BLOCKED'));

  // File on disk MUST be untouched
  const onDisk = await fs.readFile(testFilePath, 'utf8');
  assert.equal(onDisk, originalContent);

  // 2. Overwrite with writeFileTool attempting to strip assertion must also fail
  const writeRes = await writeFileTool.execute({
    path: 'service.test.ts',
    content: `
test('empty test', () => {
  // no assertions
});
    `
  }, ctx);

  assert.equal(writeRes.isError, true);
  assert.ok(writeRes.result.includes('TEST ASSERTION TAMPERING BLOCKED'));

  // 3. Multi-edit file tool with assertion deletion must fail and atomically rollback
  const multiRes = await multiEditFileTool.execute({
    files: [
      {
        path: 'service.test.ts',
        edits: [
          {
            target_content: 'assert.equal(val, 42);',
            replacement_content: ''
          }
        ]
      }
    ]
  }, ctx);

  assert.equal(multiRes.isError, true);
  assert.ok(multiRes.result.includes('TEST ASSERTION TAMPERING BLOCKED'));

  await fs.rm(tmpDir, { recursive: true, force: true });
});
