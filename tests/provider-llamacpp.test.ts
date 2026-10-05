import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { LlamaCppTurboQuantProvider } from '../src/providers/llama-cpp.js';
import { LlamaCppRuntime } from '../src/runtime/manager.js';
import { ToolDefinition } from '../src/types.js';

test('LlamaCppTurboQuantProvider - e2e simulated server handles chat, streaming, and tool calls', async () => {
  // Spin up a lightweight local mock server simulating llama-server OpenAI API
  const server = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'locode-qwen35b-a3b' }] }));
      return;
    }

    if (req.url === '/v1/chat/completions' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        const parsed = JSON.parse(body);

        if (parsed.stream) {
          // Stream chunks in SSE format
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
          });

          // Send content delta
          res.write(`data: ${JSON.stringify({
            choices: [{ delta: { content: 'I am reading ' } }]
          })}\n\n`);

          // Send tool call delta
          res.write(`data: ${JSON.stringify({
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  id: 'call_1',
                  function: { name: 'view_file', arguments: '{"path":"index.ts"}' }
                }]
              }
            }]
          })}\n\n`);

          // Send usage stats
          res.write(`data: ${JSON.stringify({
            usage: { prompt_tokens: 15, completion_tokens: 8, total_tokens: 23 }
          })}\n\n`);

          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }

        // Non-streaming response with tool_calls
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{
            message: {
              content: 'Inspecting codebase',
              tool_calls: [{
                id: 'call_1',
                type: 'function',
                function: { name: 'view_file', arguments: '{"path":"index.ts"}' }
              }]
            }
          }],
          usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 }
        }));
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as any).port;

  try {
    const runtime = new LlamaCppRuntime({
      port,
      autoStart: false,
      modelAlias: 'locode-qwen35b-a3b'
    });

    const provider = new LlamaCppTurboQuantProvider(runtime, 'locode-qwen35b-a3b', 32768);

    // 1. Health check
    assert.equal(await provider.isHealthy(), true);

    // 2. Available models
    const models = await provider.getAvailableModels();
    assert.deepEqual(models, ['locode-qwen35b-a3b']);

    const dummyTool: ToolDefinition = {
      name: 'view_file',
      description: 'View file contents',
      parameters: { type: 'object', properties: {} },
      execute: async () => ({ result: 'ok' })
    };

    // 3. Streaming Chat with Tool Call & Usage Tokens
    let streamedTokens = '';
    const streamResult = await provider.chat(
      [{ role: 'user', content: 'What is in index.ts?' }],
      [dummyTool],
      (tok) => { streamedTokens += tok; }
    );

    assert.equal(streamedTokens, 'I am reading ');
    assert.equal(streamResult.content, 'I am reading ');
    assert.ok(streamResult.tool_calls && streamResult.tool_calls.length === 1);
    assert.equal(streamResult.tool_calls[0].function.name, 'view_file');
    assert.deepEqual(streamResult.tool_calls[0].function.arguments, { path: 'index.ts' });
    assert.equal(streamResult.usage?.promptTokens, 15);
    assert.equal(streamResult.usage?.completionTokens, 8);

    // 4. Non-Streaming Chat with Tool Call
    const nonStreamResult = await provider.chat(
      [{ role: 'user', content: 'Inspect index.ts' }],
      [dummyTool]
    );

    assert.equal(nonStreamResult.content, 'Inspecting codebase');
    assert.ok(nonStreamResult.tool_calls && nonStreamResult.tool_calls.length === 1);
    assert.equal(nonStreamResult.tool_calls[0].function.name, 'view_file');
    assert.deepEqual(nonStreamResult.tool_calls[0].function.arguments, { path: 'index.ts' });
    assert.equal(nonStreamResult.usage?.promptTokens, 20);
    assert.equal(nonStreamResult.usage?.completionTokens, 10);

    // 5. Multi-turn chat message formatting with tool_call_id
    const multiTurnMessages = [
      { role: 'user' as const, content: 'Check file' },
      {
        role: 'assistant' as const,
        content: '',
        tool_calls: [{ id: 'call_abc_123', type: 'function', function: { name: 'view_file', arguments: { path: 'a.ts' } } }]
      },
      {
        role: 'tool' as const,
        name: 'view_file',
        tool_call_id: 'call_abc_123',
        content: 'export const x = 1;'
      }
    ];

    const turn2Result = await provider.chat(multiTurnMessages, [dummyTool]);
    assert.ok(turn2Result);
  } finally {
    server.close();
  }
});
