import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { MCPManager } from '../src/mcp/manager.js';

test('MCPManager - loadConfiguration from .mcp.json', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locode-mcp-'));
  const mcpConfigPath = path.join(tmpDir, '.mcp.json');

  const configContent = {
    mcpServers: {
      mockserver: {
        command: 'node',
        args: ['-e', 'console.log("mock")']
      }
    }
  };

  await fs.writeFile(mcpConfigPath, JSON.stringify(configContent, null, 2), 'utf8');

  const manager = new MCPManager(tmpDir);
  const loaded = await manager.loadConfiguration();

  assert.ok(loaded);
  assert.ok(loaded.mcpServers?.mockserver);
  assert.equal(loaded.mcpServers?.mockserver.command, 'node');

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('MCPManager - return empty list when no .mcp.json exists', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locode-mcp-empty-'));
  const manager = new MCPManager(tmpDir);
  const loaded = await manager.loadConfiguration();

  assert.equal(loaded, null);
  const tools = await manager.init();
  assert.equal(tools.length, 0);

  await fs.rm(tmpDir, { recursive: true, force: true });
});
