import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveProvider, isCloudProvider, createLLMProvider } from '../src/providers/factory.js';
import { GeminiProvider } from '../src/providers/gemini.js';
import { AnthropicProvider } from '../src/providers/anthropic.js';
import { OpenAICompatibleProvider } from '../src/providers/openai-compatible.js';
import { OllamaProvider } from '../src/providers/ollama.js';

test('Provider Factory - isCloudProvider identifies cloud vs local runtimes accurately', () => {
  assert.equal(isCloudProvider('gemini'), true);
  assert.equal(isCloudProvider('anthropic'), true);
  assert.equal(isCloudProvider('openai'), true);
  assert.equal(isCloudProvider('openrouter'), true);
  assert.equal(isCloudProvider('groq'), true);
  assert.equal(isCloudProvider('llamacpp'), false);
  assert.equal(isCloudProvider('ollama'), false);
  assert.equal(isCloudProvider('lmstudio'), false);
  assert.equal(isCloudProvider(undefined), false);
});

test('Provider Factory - resolveProvider auto-detects based on model name', () => {
  const origEnv = { ...process.env };
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENROUTER_API_KEY;

  try {
    assert.equal(resolveProvider({ model: 'gemini-2.0-flash' }), 'gemini');
    assert.equal(resolveProvider({ model: 'gemini-1.5-pro' }), 'gemini');
    assert.equal(resolveProvider({ model: 'claude-3-5-sonnet-20241022' }), 'anthropic');
    assert.equal(resolveProvider({ model: 'claude-3-haiku' }), 'anthropic');
    assert.equal(resolveProvider({ model: 'gpt-4o' }), 'openai');
    assert.equal(resolveProvider({ model: 'o3-mini' }), 'openai');
    assert.equal(resolveProvider({ model: 'anthropic/claude-3.5-sonnet' }), 'openrouter');
    assert.equal(resolveProvider({ model: 'deepseek/deepseek-r1' }), 'openrouter');
    assert.equal(resolveProvider({ model: 'qwen2.5-coder:7b' }), 'ollama');
  } finally {
    Object.assign(process.env, origEnv);
  }
});

test('Provider Factory - resolveProvider respects explicit provider override', () => {
  assert.equal(resolveProvider({ provider: 'gemini', model: 'custom-model' }), 'gemini');
  assert.equal(resolveProvider({ provider: 'anthropic', model: 'gemini-2.0-flash' }), 'anthropic');
  assert.equal(resolveProvider({ provider: 'llamacpp', model: 'gpt-4o' }), 'llamacpp');
});

test('Provider Factory - resolveProvider detects environment variables', () => {
  const origEnv = { ...process.env };
  try {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;

    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    assert.equal(resolveProvider({}), 'anthropic');

    delete process.env.ANTHROPIC_API_KEY;
    process.env.GEMINI_API_KEY = 'gemini-test-key';
    assert.equal(resolveProvider({}), 'gemini');

    delete process.env.GEMINI_API_KEY;
    process.env.GROQ_API_KEY = 'gsk-test-key';
    assert.equal(resolveProvider({}), 'groq');

    delete process.env.GROQ_API_KEY;
    process.env.OPENROUTER_API_KEY = 'or-test-key';
    assert.equal(resolveProvider({}), 'openrouter');

    delete process.env.OPENROUTER_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-test-key';
    assert.equal(resolveProvider({}), 'openai');
  } finally {
    process.env = origEnv;
  }
});

test('Provider Factory - createLLMProvider instantiates appropriate provider classes', () => {
  const gemini = createLLMProvider({
    cwd: process.cwd(),
    autoApprove: true,
    model: 'gemini-3.8-flash',
    ollamaHost: 'http://127.0.0.1:11434',
    provider: 'gemini',
    apiKey: 'dummy-key'
  });
  assert.ok(gemini instanceof GeminiProvider);
  assert.equal(gemini.getModel(), 'gemini-3.8-flash');

  const anthropic = createLLMProvider({
    cwd: process.cwd(),
    autoApprove: true,
    model: 'claude-3-5-sonnet-20241022',
    ollamaHost: 'http://127.0.0.1:11434',
    provider: 'anthropic',
    apiKey: 'dummy-key'
  });
  assert.ok(anthropic instanceof AnthropicProvider);
  assert.equal(anthropic.getModel(), 'claude-3-5-sonnet-20241022');

  const groq = createLLMProvider({
    cwd: process.cwd(),
    autoApprove: true,
    ollamaHost: 'http://127.0.0.1:11434',
    provider: 'groq',
    apiKey: 'gsk-dummy-key'
  });
  assert.ok(groq instanceof OpenAICompatibleProvider);
  assert.equal(groq.getModel(), 'qwen/qwen3.8-27b');

  const openrouter = createLLMProvider({
    cwd: process.cwd(),
    autoApprove: true,
    model: 'anthropic/claude-3.5-sonnet',
    ollamaHost: 'http://127.0.0.1:11434',
    provider: 'openrouter',
    apiKey: 'dummy-key'
  });
  assert.ok(openrouter instanceof OpenAICompatibleProvider);

  const ollama = createLLMProvider({
    cwd: process.cwd(),
    autoApprove: true,
    model: 'qwen2.5-coder:7b',
    ollamaHost: 'http://127.0.0.1:11434',
    provider: 'ollama'
  });
  assert.ok(ollama instanceof OllamaProvider);
});
