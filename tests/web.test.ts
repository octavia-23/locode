import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchWebTool, searchWebTool } from '../src/tools/web.js';
import { AgentContext } from '../src/types.js';

const mockCtx: AgentContext = {
  cwd: process.cwd(),
  autoApprove: true,
  model: 'qwen2.5-coder:7b',
  ollamaHost: 'http://127.0.0.1:11434'
};

test('Web Tools - fetch_web extracts content', async () => {
  const res = await fetchWebTool.execute({ url: 'https://example.com' }, mockCtx);
  assert.equal(res.isError, undefined);
  assert.match(res.result, /Example Domain/);
});

test('Web Tools - search_web queries live web', async () => {
  const res = await searchWebTool.execute({ query: 'nodejs official website' }, mockCtx);
  assert.equal(res.isError, undefined);
  assert.match(res.result, /nodejs|Node\.js/i);
});
