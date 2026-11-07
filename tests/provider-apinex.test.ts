import test from 'node:test';
import assert from 'node:assert/strict';
import {
  identifyProviderFromApiKey,
  getEnvKeyNameForProvider,
  getApiKeyForProvider
} from '../src/utils/config.js';
import {
  isCloudProvider,
  getDefaultModelForProvider,
  getDefaultContextForProvider,
  resolveProvider,
  createLLMProvider,
  SUPPORTED_PROVIDERS
} from '../src/providers/factory.js';
import { getModelPricing } from '../src/runtime/pricing.js';

test('APINex Provider - API key prefix identification', () => {
  assert.equal(identifyProviderFromApiKey('sk-apx-1234567890abcdef'), 'apinex');
  assert.equal(identifyProviderFromApiKey('apx-live-token-xyz'), 'apinex');
});

test('APINex Provider - configuration metadata and defaults', () => {
  assert.equal(getEnvKeyNameForProvider('apinex'), 'APINEX_API_KEY');
  assert.equal(isCloudProvider('apinex'), true);
  assert.equal(getDefaultModelForProvider('apinex'), 'free/deepseek-v4.1-flash');
  assert.equal(getDefaultContextForProvider('apinex'), 200000);

  const supported = SUPPORTED_PROVIDERS.find(p => p.name === 'apinex');
  assert.ok(supported);
  assert.equal(supported.type, 'cloud');
});

test('APINex Provider - environment key resolution', () => {
  const origKey = process.env.APINEX_API_KEY;
  try {
    process.env.APINEX_API_KEY = 'sk-apx-test-env-key';
    assert.equal(getApiKeyForProvider('apinex'), 'sk-apx-test-env-key');
    assert.equal(resolveProvider(), 'apinex');
  } finally {
    if (origKey !== undefined) {
      process.env.APINEX_API_KEY = origKey;
    } else {
      delete process.env.APINEX_API_KEY;
    }
  }
});

test('APINex Provider - resolveProvider auto-detection', () => {
  assert.equal(resolveProvider({ apiKey: 'sk-apx-abcdef123456' }), 'apinex');
  assert.equal(resolveProvider({ model: 'apinex/claude-sonnet-5.5' }), 'apinex');
  assert.equal(resolveProvider({ model: 'claude-sonnet-5.5' }), 'apinex');
  assert.equal(resolveProvider({ model: 'gpt-6.1-sol' }), 'apinex');
  assert.equal(resolveProvider({ model: 'free/deepseek-v4.1-flash' }), 'apinex');
  assert.equal(resolveProvider({ model: 'free/gemini-3.8-flash' }), 'apinex');
  assert.equal(resolveProvider({ apiBase: 'https://api.apinex.bond/v1' }), 'apinex');
});

test('APINex Provider - factory initialization with default base URL', () => {
  const provider = createLLMProvider({
    cwd: process.cwd(),
    provider: 'apinex',
    apiKey: 'sk-apx-sample',
    autoApprove: true,
    ollamaHost: 'http://localhost'
  });

  assert.equal(provider.getModel(), 'free/deepseek-v4.1-flash');
  assert.equal(provider.getNumCtx(), 200000);
});

test('APINex Provider - deepseek model alias', () => {
  const provider = createLLMProvider({
    cwd: process.cwd(),
    provider: 'apinex',
    model: 'deepseek',
    apiKey: 'sk-apx-sample',
    autoApprove: true,
    ollamaHost: 'http://localhost'
  });

  assert.equal(provider.getModel(), 'free/deepseek-v4.1-flash');
});

test('APINex Provider - gemini model alias', () => {
  const provider = createLLMProvider({
    cwd: process.cwd(),
    provider: 'apinex',
    model: 'gemini',
    apiKey: 'sk-apx-sample',
    autoApprove: true,
    ollamaHost: 'http://localhost'
  });

  assert.equal(provider.getModel(), 'free/gemini-3.8-flash');
});

test('APINex Provider - pricing registry integration', () => {
  const sonnetPricing = getModelPricing('claude-sonnet-5.5', 'apinex');
  assert.ok(sonnetPricing);
  assert.equal(sonnetPricing.inputPerMillion, 3.00);

  const solPricing = getModelPricing('gpt-6.1-sol', 'apinex');
  assert.ok(solPricing);
  assert.equal(solPricing.inputPerMillion, 2.50);

  const deepseekPricing = getModelPricing('deepseek-v4.1-flash', 'apinex');
  assert.ok(deepseekPricing);
  assert.equal(deepseekPricing.inputPerMillion, 0.50);

  // Free tier models cost 0.00
  const freeDeepseek = getModelPricing('free/deepseek-v4.1-flash', 'apinex');
  assert.ok(freeDeepseek);
  assert.equal(freeDeepseek.inputPerMillion, 0.0);
  assert.equal(freeDeepseek.outputPerMillion, 0.0);

  const freeGemini = getModelPricing('free/gemini-3.8-flash', 'apinex');
  assert.ok(freeGemini);
  assert.equal(freeGemini.inputPerMillion, 0.0);
  assert.equal(freeGemini.outputPerMillion, 0.0);
});

test('APINex Provider - HTTP 402 Insufficient Balance error formatting', () => {
  const provider: any = createLLMProvider({
    cwd: process.cwd(),
    provider: 'apinex',
    apiKey: 'sk-apx-sample',
    model: 'claude-sonnet-5.5',
    autoApprove: true,
    ollamaHost: 'http://localhost'
  });

  const raw402 = JSON.stringify({
    error: {
      message: 'Insufficient balance. Top up your balance to continue: https://apinex.bond/billing',
      type: 'billing_error',
      param: null,
      code: null
    }
  });

  const formattedErr = provider.formatApiError(402, raw402);
  assert.ok(formattedErr.message.includes('Insufficient APInex balance'));
  assert.ok(formattedErr.message.includes('https://apinex.bond/billing'));
  assert.ok(formattedErr.message.includes('/model free/deepseek-v4.1-flash'));
});
