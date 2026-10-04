import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execa } from 'execa';
import { CheckpointManager } from '../src/git/checkpoint.js';

test('Checkpoint & Undo - handles tracked modifications, untracked files, and deletions', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locode-cp-test-'));

  try {
    // 1. Initialize real git repository
    await execa('git init', { cwd: tmpDir, shell: true });
    await execa('git config user.name "LocodeTester"', { cwd: tmpDir, shell: true });
    await execa('git config user.email "test@locode.dev"', { cwd: tmpDir, shell: true });

    // Initial files
    await fs.writeFile(path.join(tmpDir, 'tracked.txt'), 'Initial tracked content\n', 'utf8');
    await fs.writeFile(path.join(tmpDir, 'to-delete.txt'), 'File to be deleted\n', 'utf8');
    await execa('git add .', { cwd: tmpDir, shell: true });
    await execa('git commit -m "Initial commit"', { cwd: tmpDir, shell: true });

    const manager = new CheckpointManager(tmpDir);

    // Turn 1: Create checkpoint before agent modifies workspace
    const cp1 = await manager.createCheckpoint();
    assert.ok(cp1, 'Checkpoint 1 created');

    // Agent modifies tracked.txt, deletes to-delete.txt, and creates untracked.txt
    await manager.recordPreEditFile('tracked.txt');
    await fs.writeFile(path.join(tmpDir, 'tracked.txt'), 'Modified by agent\n', 'utf8');

    await manager.recordPreEditFile('to-delete.txt');
    await fs.rm(path.join(tmpDir, 'to-delete.txt'));

    await manager.recordPreEditFile('untracked.txt');
    await fs.writeFile(path.join(tmpDir, 'untracked.txt'), 'New untracked file\n', 'utf8');

    // Assert dirty state
    assert.equal(await fs.readFile(path.join(tmpDir, 'tracked.txt'), 'utf8'), 'Modified by agent\n');
    assert.equal(await fs.readFile(path.join(tmpDir, 'untracked.txt'), 'utf8'), 'New untracked file\n');
    const deleteExists = await fs.access(path.join(tmpDir, 'to-delete.txt')).then(() => true).catch(() => false);
    assert.equal(deleteExists, false);

    // Perform Undo
    const undoRes = await manager.undo();
    assert.equal(undoRes.success, true);

    // Verify workspace restored
    const restoredTracked = await fs.readFile(path.join(tmpDir, 'tracked.txt'), 'utf8');
    assert.equal(restoredTracked, 'Initial tracked content\n');

    const restoredDeleted = await fs.readFile(path.join(tmpDir, 'to-delete.txt'), 'utf8');
    assert.equal(restoredDeleted, 'File to be deleted\n');

    const untrackedStillExists = await fs.access(path.join(tmpDir, 'untracked.txt')).then(() => true).catch(() => false);
    assert.equal(untrackedStillExists, false, 'Untracked agent file must be removed on undo');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('Checkpoint & Undo - multiple turns and user pre-existing dirty changes', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locode-cp-multi-'));

  try {
    await execa('git init', { cwd: tmpDir, shell: true });
    await execa('git config user.name "LocodeTester"', { cwd: tmpDir, shell: true });
    await execa('git config user.email "test@locode.dev"', { cwd: tmpDir, shell: true });

    await fs.writeFile(path.join(tmpDir, 'base.txt'), 'Base content\n', 'utf8');
    await execa('git add .', { cwd: tmpDir, shell: true });
    await execa('git commit -m "Initial commit"', { cwd: tmpDir, shell: true });

    // User makes a manual change before launching agent
    await fs.writeFile(path.join(tmpDir, 'user-work.txt'), 'User manual uncommitted draft\n', 'utf8');

    const manager = new CheckpointManager(tmpDir);

    // Checkpoint 1 (stores user work in stash safely)
    await manager.createCheckpoint();

    // Agent modifies base.txt
    await manager.recordPreEditFile('base.txt');
    await fs.writeFile(path.join(tmpDir, 'base.txt'), 'Agent turn 1 edit\n', 'utf8');

    // Agent checkpoint 2
    await manager.createCheckpoint();
    await manager.recordPreEditFile('base.txt');
    await fs.writeFile(path.join(tmpDir, 'base.txt'), 'Agent turn 2 edit\n', 'utf8');

    // Undo Turn 2
    const undo2 = await manager.undo();
    assert.equal(undo2.success, true);
    const contentAfterUndo2 = (await fs.readFile(path.join(tmpDir, 'base.txt'), 'utf8')).replace(/\r\n/g, '\n');
    assert.equal(contentAfterUndo2, 'Agent turn 1 edit\n');

    // Undo Turn 1
    const undo1 = await manager.undo();
    assert.equal(undo1.success, true);
    const contentAfterUndo1 = (await fs.readFile(path.join(tmpDir, 'base.txt'), 'utf8')).replace(/\r\n/g, '\n');
    assert.equal(contentAfterUndo1, 'Base content\n');

    // Crucial safety check: User manual draft must NOT be lost!
    const userWork = (await fs.readFile(path.join(tmpDir, 'user-work.txt'), 'utf8')).replace(/\r\n/g, '\n');
    assert.equal(userWork, 'User manual uncommitted draft\n');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});
