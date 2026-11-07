import test from 'node:test';
import assert from 'node:assert/strict';
import { colorizeDiff, renderDiffSummary, WorkspaceDiffSummary } from '../src/ui/diff-viewer.js';

test('DiffViewer - colorizeDiff formats diff headers and insertions/deletions', () => {
  const sampleDiff = [
    'diff --git a/src/agent.ts b/src/agent.ts',
    'index 1234567..89abcdef 100644',
    '--- a/src/agent.ts',
    '+++ b/src/agent.ts',
    '@@ -10,3 +10,4 @@',
    ' const a = 1;',
    '-const b = 2;',
    '+const b = 3;',
    '+const c = 4;'
  ].join('\n');

  const colored = colorizeDiff(sampleDiff);
  assert.ok(colored.includes('diff --git'), 'Contains diff header');
  assert.ok(colored.includes('const b = 3'), 'Contains added line');
  assert.ok(colored.includes('const b = 2'), 'Contains removed line');
});

test('DiffViewer - colorizeDiff truncates massive diffs cleanly', () => {
  const hugeLines: string[] = ['diff --git a/big.txt b/big.txt'];
  for (let i = 0; i < 500; i++) {
    hugeLines.push(`+line ${i}`);
  }
  const colored = colorizeDiff(hugeLines.join('\n'), 50);
  assert.ok(colored.includes('diff lines omitted'), 'Includes truncation notice');
});

test('DiffViewer - renderDiffSummary displays modified files and total counts', () => {
  const summary: WorkspaceDiffSummary = {
    files: [
      { file: 'src/agent/loop.ts', status: 'modified', statusRaw: ' M', insertions: 15, deletions: 3, staged: false },
      { file: 'src/ui/diff.ts', status: 'added', statusRaw: 'A ', insertions: 120, deletions: 0, staged: true },
      { file: 'temp.txt', status: 'untracked', statusRaw: '??', insertions: 5, deletions: 0, staged: false }
    ],
    totalInsertions: 140,
    totalDeletions: 3,
    isClean: false
  };

  const output = renderDiffSummary(summary);
  assert.ok(output.includes('Pending Workspace Changes'), 'Includes header');
  assert.ok(output.includes('src/agent/loop.ts'), 'Lists modified file');
  assert.ok(output.includes('src/ui/diff.ts'), 'Lists added file');
  assert.ok(output.includes('3 changed'), 'Counts changed files');
  assert.ok(output.includes('+140'), 'Shows total insertions');
  assert.ok(output.includes('-3'), 'Shows total deletions');
});

test('DiffViewer - renderDiffSummary handles clean workspace', () => {
  const summary: WorkspaceDiffSummary = {
    files: [],
    totalInsertions: 0,
    totalDeletions: 0,
    isClean: true
  };

  const output = renderDiffSummary(summary);
  assert.ok(output.includes('clean'), 'Indicates clean workspace');
});
