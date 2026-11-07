import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SessionMemory } from '../src/agent/memory.js';

test('SessionMemory - forking and multi-session switching', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locode-session-test-'));
  try {
    const mem = new SessionMemory(tmpDir);

    // Initial save on main session
    await mem.saveSession({
      model: 'qwen35b',
      messages: [
        { role: 'user', content: 'Design architecture for feature X' },
        { role: 'assistant', content: 'Proposed architecture: use modular plugins' }
      ],
      lastDecisions: ['Decided to use modular plugins'],
      recentFiles: ['src/index.ts']
    });

    assert.equal(mem.getActiveSessionId(), 'main');
    const mainSession = await mem.loadSession('main');
    assert.ok(mainSession);
    assert.equal(mainSession.messages.length, 2);
    assert.deepEqual(mainSession.lastDecisions, ['Decided to use modular plugins']);

    // Fork the session into an experimental branch
    const forked = await mem.forkSession({
      name: 'Experimental Monolith Branch',
      lastDecisions: ['Exploring monolithic alternative']
    });

    assert.ok(forked.id.startsWith('fork_'));
    assert.equal(forked.name, 'Experimental Monolith Branch');
    assert.equal(forked.parentSessionId, 'main');
    assert.equal(mem.getActiveSessionId(), forked.id);

    // List sessions - should contain both main and the fork
    const list = await mem.listSessions();
    assert.equal(list.length, 2);
    const ids = list.map(s => s.id);
    assert.ok(ids.includes('main'));
    assert.ok(ids.includes(forked.id));

    // Switch back to main session
    const switchedBack = await mem.switchSession('main');
    assert.ok(switchedBack);
    assert.equal(mem.getActiveSessionId(), 'main');

    // Switch back to fork using prefix or name
    const switchedFork = await mem.switchSession('Experimental Monolith');
    assert.ok(switchedFork);
    assert.equal(switchedFork.id, forked.id);
    assert.equal(mem.getActiveSessionId(), forked.id);

    // Delete the fork
    const deleted = await mem.deleteSession(forked.id);
    assert.equal(deleted, true);
    assert.equal(mem.getActiveSessionId(), 'main');

    const remaining = await mem.listSessions();
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].id, 'main');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
