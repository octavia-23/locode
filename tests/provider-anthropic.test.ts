import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AnthropicProvider } from '../src/providers/anthropic.js';
import { ChatMessage, ToolDefinition } from '../src/types.js';

test('AnthropicProvider - formats system prompt, merges tool results into user turns, and parses tools', async () => {
  let capturedBody: any = null;
  let capturedHeaders: any = null;

  const server = http.createServer((req, res) => {
    capturedHeaders = req.headers;
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      capturedBody = JSON.parse(body);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'text', text: 'Inspecting code...' },
          {
            type: 'tool_use',
            id: 'toolu_01',
            name: 'view_file',
            input: { path: 'src/main.ts' }
          }
        ],
        stop_reason: 'tool_use',
        usage: {
          input_tokens: 250,
          output_tokens: 42
        }
      }));
    });
  });

  await new Promise<void>(resolve => server.listen(0, resolve));
  const port = (server.address() as any).port;

  try {
    const provider = new AnthropicProvider('claude-3-5-sonnet-20241022', 'sk-ant-test', `http://127.0.0.1:${port}`);

    const messages: ChatMessage[] = [
      { role: 'system', content: 'You are Claude Code developer agent.' },
      { role: 'user', content: 'Fix the failing test' },
      { role: 'assistant', content: 'Checking...', tool_calls: [{ id: 'call_1', function: { name: 'run_command', arguments: { command: 'npm test' } } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'FAIL test.ts' }
    ];

    const tools: ToolDefinition[] = [{
      name: 'view_file',
      description: 'View file content',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'File path' } },
        required: ['path']
      },
      execute: async () => ({ result: '' })
    }];

    const response = await provider.chat(messages, tools);

    assert.equal(capturedHeaders['x-api-key'], 'sk-ant-test');
    assert.equal(capturedHeaders['anthropic-version'], '2023-06-01');
    assert.equal(capturedHeaders['anthropic-beta'], 'prompt-caching-2024-07-31');
    assert.deepEqual(capturedBody.system, [
      {
        type: 'text',
        text: 'You are Claude Code developer agent.',
        cache_control: { type: 'ephemeral' }
      }
    ]);
    assert.equal(capturedBody.tools[0].name, 'view_file');
    assert.deepEqual(capturedBody.tools[0].input_schema, {
      type: 'object',
      properties: { path: { type: 'string', description: 'File path' } },
      required: ['path']
    });

    // Verify messages alternation and tool result inside user turn
    const lastMsg = capturedBody.messages[capturedBody.messages.length - 1];
    assert.equal(lastMsg.role, 'user');
    assert.equal(lastMsg.content[0].type, 'tool_result');
    assert.equal(lastMsg.content[0].tool_use_id, 'call_1');

    assert.equal(response.content, 'Inspecting code...');
    assert.equal(response.tool_calls?.length, 1);
    assert.equal(response.tool_calls[0].id, 'toolu_01');
    assert.equal(response.tool_calls[0].function.name, 'view_file');
    assert.deepEqual(response.tool_calls[0].function.arguments, { path: 'src/main.ts' });
    assert.equal(response.usage?.promptTokens, 250);
    assert.equal(response.usage?.completionTokens, 42);
    assert.equal(response.usage?.totalTokens, 292);
  } finally {
    server.close();
  }
});

test('AnthropicProvider - handles SSE streaming events with delta text and tool JSON assembly', async () => {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });

      // 1. message_start
      res.write(`data: ${JSON.stringify({
        type: 'message_start',
        message: {
          id: 'msg_999',
          usage: { input_tokens: 180, output_tokens: 1 }
        }
      })}\n\n`);

      // 2. content_block_start text
      res.write(`data: ${JSON.stringify({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' }
      })}\n\n`);

      // 3. content_block_delta text
      res.write(`data: ${JSON.stringify({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Reading directory...' }
      })}\n\n`);

      // 4. content_block_start tool_use
      res.write(`data: ${JSON.stringify({
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'toolu_abc', name: 'list_dir', input: {} }
      })}\n\n`);

      // 5. content_block_delta input_json_delta
      res.write(`data: ${JSON.stringify({
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"path":".' }
      })}\n\n`);

      res.write(`data: ${JSON.stringify({
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '"}' }
      })}\n\n`);

      // 6. message_delta
      res.write(`data: ${JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' },
        usage: { output_tokens: 35 }
      })}\n\n`);

      res.write('data: {"type":"message_stop"}\n\n');
      res.end();
    });
  });

  await new Promise<void>(resolve => server.listen(0, resolve));
  const port = (server.address() as any).port;

  try {
    const provider = new AnthropicProvider('claude-3-5-sonnet-20241022', 'sk-ant-test', `http://127.0.0.1:${port}`);
    const streamedTokens: string[] = [];

    const response = await provider.chat(
      [{ role: 'user', content: 'What files are here?' }],
      [],
      (token) => streamedTokens.push(token)
    );

    assert.equal(streamedTokens.join(''), 'Reading directory...');
    assert.equal(response.content, 'Reading directory...');
    assert.equal(response.tool_calls?.length, 1);
    assert.equal(response.tool_calls[0].id, 'toolu_abc');
    assert.equal(response.tool_calls[0].function.name, 'list_dir');
    assert.deepEqual(response.tool_calls[0].function.arguments, { path: '.' });
    assert.equal(response.usage?.promptTokens, 180);
    assert.equal(response.usage?.completionTokens, 35);
    assert.equal(response.usage?.totalTokens, 215);
  } finally {
    server.close();
  }
});
