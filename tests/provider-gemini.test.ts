import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { GeminiProvider } from '../src/providers/gemini.js';
import { ChatMessage, ToolDefinition } from '../src/types.js';

test('GeminiProvider - formats system instructions, contents, and tools correctly', async () => {
  let capturedBody: any = null;
  let capturedUrl: string = '';

  const server = http.createServer((req, res) => {
    capturedUrl = req.url || '';
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      capturedBody = JSON.parse(body);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        candidates: [{
          content: {
            parts: [
              { text: 'I will inspect the file.' },
              { functionCall: { name: 'view_file', args: { path: 'index.ts' } } }
            ],
            role: 'model'
          },
          finishReason: 'STOP'
        }],
        usageMetadata: {
          promptTokenCount: 120,
          candidatesTokenCount: 45,
          totalTokenCount: 165
        }
      }));
    });
  });

  await new Promise<void>(resolve => server.listen(0, resolve));
  const port = (server.address() as any).port;

  try {
    const provider = new GeminiProvider('gemini-2.0-flash', 'test-key', `http://127.0.0.1:${port}`);

    const messages: ChatMessage[] = [
      { role: 'system', content: 'You are an autonomous AI software engineer.' },
      { role: 'user', content: 'Fix the bug in index.ts' },
      { role: 'assistant', content: 'Reading the file...', tool_calls: [{ function: { name: 'view_file', arguments: { path: 'index.ts' } } }] },
      { role: 'tool', name: 'view_file', content: 'const a = 1;' }
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

    assert.ok(capturedUrl.includes('key=test-key'));
    assert.equal(capturedBody.systemInstruction.parts[0].text, 'You are an autonomous AI software engineer.');
    assert.equal(capturedBody.tools[0].functionDeclarations[0].name, 'view_file');
    assert.equal(response.content, 'I will inspect the file.');
    assert.equal(response.tool_calls?.length, 1);
    assert.equal(response.tool_calls[0].function.name, 'view_file');
    assert.deepEqual(response.tool_calls[0].function.arguments, { path: 'index.ts' });
    assert.equal(response.usage?.promptTokens, 120);
    assert.equal(response.usage?.completionTokens, 45);
    assert.equal(response.usage?.totalTokens, 165);
  } finally {
    server.close();
  }
});

test('GeminiProvider - handles SSE streaming response and token dispatch', async () => {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });

      res.write(`data: ${JSON.stringify({
        candidates: [{
          content: { parts: [{ text: 'Step 1: ' }] }
        }]
      })}\n\n`);

      res.write(`data: ${JSON.stringify({
        candidates: [{
          content: { parts: [{ text: 'Running test now.' }] },
          finishReason: 'STOP'
        }],
        usageMetadata: {
          promptTokenCount: 50,
          candidatesTokenCount: 20,
          totalTokenCount: 70
        }
      })}\n\n`);

      res.end();
    });
  });

  await new Promise<void>(resolve => server.listen(0, resolve));
  const port = (server.address() as any).port;

  try {
    const provider = new GeminiProvider('gemini-1.5-pro', 'test-key', `http://127.0.0.1:${port}`);
    const streamedTokens: string[] = [];

    const response = await provider.chat(
      [{ role: 'user', content: 'Run test' }],
      [],
      (token) => streamedTokens.push(token)
    );

    assert.equal(streamedTokens.join(''), 'Step 1: Running test now.');
    assert.equal(response.content, 'Step 1: Running test now.');
    assert.equal(response.usage?.totalTokens, 70);
  } finally {
    server.close();
  }
});

test('GeminiProvider - fails fast when API key is missing', async () => {
  const origGeminiKey = process.env.GEMINI_API_KEY;
  const origGoogleKey = process.env.GOOGLE_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;

  try {
    const provider = new GeminiProvider('gemini-2.0-flash', '', 'http://127.0.0.1:9999');
    await assert.rejects(
      async () => {
        await provider.chat([{ role: 'user', content: 'hello' }], []);
      },
      /Gemini API key is required/
    );
  } finally {
    process.env.GEMINI_API_KEY = origGeminiKey;
    process.env.GOOGLE_API_KEY = origGoogleKey;
  }
});

test('GeminiProvider - automatically falls back to healthy sister model on 503 high demand', async () => {
  const attemptedUrls: string[] = [];

  const server = http.createServer((req, res) => {
    attemptedUrls.push(req.url || '');

    if (req.url?.includes('gemini-3.8-flash')) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: { code: 503, message: 'This model is currently experiencing high demand.', status: 'UNAVAILABLE' }
      }));
      return;
    }

    if (req.url?.includes('gemini-3.6-flash')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        candidates: [{
          content: { parts: [{ text: 'Response from 3.6 fallback' }], role: 'model' },
          finishReason: 'STOP'
        }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 }
      }));
      return;
    }
  });

  await new Promise<void>(resolve => server.listen(0, resolve));
  const port = (server.address() as any).port;

  try {
    const provider = new GeminiProvider('gemini-3.8-flash', 'test-key', `http://127.0.0.1:${port}`);
    const response = await provider.chat([{ role: 'user', content: 'hello' }], []);

    assert.equal(attemptedUrls.length, 2);
    assert.ok(attemptedUrls[0].includes('gemini-3.8-flash'));
    assert.ok(attemptedUrls[1].includes('gemini-3.6-flash'));
    assert.equal(response.content, 'Response from 3.6 fallback');
    assert.equal(provider.getModel(), 'gemini-3.6-flash');
  } finally {
    server.close();
  }
});

