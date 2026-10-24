import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { OpenAICompatibleProvider } from '../src/providers/openai-compatible.js';
import { ChatMessage, ToolDefinition } from '../src/types.js';

test('OpenAICompatibleProvider - injects OpenRouter headers and handles streaming tool call deltas', async () => {
  let capturedHeaders: any = null;

  const server = http.createServer((req, res) => {
    capturedHeaders = req.headers;
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });

      // Stream text chunk
      res.write(`data: ${JSON.stringify({
        choices: [{ delta: { content: 'Fixing the math function ' } }]
      })}\n\n`);

      // Stream partial tool call chunks across two SSE deltas
      res.write(`data: ${JSON.stringify({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_edit_01',
              function: { name: 'edit_file', arguments: '{"path":"math.js"' }
            }]
          }
        }]
      })}\n\n`);

      res.write(`data: ${JSON.stringify({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              function: { arguments: ',"target":"0","replacement":"a+b"}' }
            }]
          }
        }]
      })}\n\n`);

      // Stream usage
      res.write(`data: ${JSON.stringify({
        usage: { prompt_tokens: 40, completion_tokens: 25, total_tokens: 65 }
      })}\n\n`);

      res.write('data: [DONE]\n\n');
      res.end();
    });
  });

  await new Promise<void>(resolve => server.listen(0, resolve));
  const port = (server.address() as any).port;

  try {
    const provider = new OpenAICompatibleProvider(
      'deepseek/deepseek-r1',
      `http://127.0.0.1:${port}/openrouter.ai/api/v1`,
      'sk-or-test'
    );

    const streamedTokens: string[] = [];
    const response = await provider.chat(
      [{ role: 'user', content: 'fix math' }],
      [],
      (token) => streamedTokens.push(token)
    );

    assert.equal(capturedHeaders['http-referer'], 'https://github.com/locode/locode');
    assert.equal(capturedHeaders['x-title'], 'Locode');
    assert.equal(capturedHeaders['authorization'], 'Bearer sk-or-test');

    assert.equal(streamedTokens.join(''), 'Fixing the math function ');
    assert.equal(response.content, 'Fixing the math function ');
    assert.equal(response.tool_calls?.length, 1);
    assert.equal(response.tool_calls[0].id, 'call_edit_01');
    assert.equal(response.tool_calls[0].function.name, 'edit_file');
    assert.deepEqual(response.tool_calls[0].function.arguments, {
      path: 'math.js',
      target: '0',
      replacement: 'a+b'
    });
    assert.equal(response.usage?.promptTokens, 40);
    assert.equal(response.usage?.completionTokens, 25);
    assert.equal(response.usage?.totalTokens, 65);
  } finally {
    server.close();
  }
});
