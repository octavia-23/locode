import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { RepoMapGenerator } from '../src/agent/repomap.js';

test('RepoMapGenerator - extracts functions, classes, interfaces and formats map', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locode-repomap-test-'));

  try {
    const srcDir = path.join(tmpDir, 'src');
    await fs.mkdir(srcDir, { recursive: true });

    // File 1: TS module with exports
    const tsCode = `
export interface UserConfig {
  id: string;
  name: string;
}

export class ConfigManager {
  load() {}
}

export function parseConfig(raw: string): UserConfig {
  return JSON.parse(raw);
}

export const createDefaultConfig = () => ({ id: '1', name: 'default' });
`;
    await fs.writeFile(path.join(srcDir, 'config.ts'), tsCode, 'utf8');

    // File 2: Python script with functions/classes
    const pyCode = `
class DataPipeline:
    def process(self):
        pass

def run_pipeline(source: str):
    pass
`;
    await fs.writeFile(path.join(srcDir, 'pipeline.py'), pyCode, 'utf8');

    const generator = new RepoMapGenerator(tmpDir);
    const map = await generator.generateMap(20, 2000);

    assert.ok(map.includes('## Repository Codebase Map'));
    assert.ok(map.includes('src/config.ts'));
    assert.ok(map.includes('interface UserConfig'));
    assert.ok(map.includes('class ConfigManager'));
    assert.ok(map.includes('function parseConfig'));
    assert.ok(map.includes('const createDefaultConfig'));
    assert.ok(map.includes('src/pipeline.py'));
    assert.ok(map.includes('class DataPipeline'));
    assert.ok(map.includes('function run_pipeline'));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('RepoMapGenerator - respects file count and token budget limits', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locode-repomap-budget-'));

  try {
    for (let i = 0; i < 10; i++) {
      const code = `export function fn${i}() { return ${i}; }`;
      await fs.writeFile(path.join(tmpDir, `mod_${i}.ts`), code, 'utf8');
    }

    const generator = new RepoMapGenerator(tmpDir);
    // Limit to 3 files
    const map = await generator.generateMap(3, 1000);

    assert.ok(map.includes('## Repository Codebase Map'));
    const occurrences = (map.match(/mod_\d\.ts/g) || []).length;
    assert.ok(occurrences <= 3, `Expected at most 3 files, got ${occurrences}`);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
