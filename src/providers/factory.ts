import { AgentContext, ProviderType } from '../types.js';
import { ILLMProvider } from './types.js';
import { OllamaProvider } from './ollama.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import { LlamaCppTurboQuantProvider } from './llama-cpp.js';
import { GeminiProvider } from './gemini.js';
import { AnthropicProvider } from './anthropic.js';
import { LlamaCppRuntime } from '../runtime/manager.js';

let sharedLlamaRuntime: LlamaCppRuntime | null = null;

export function getSharedLlamaRuntime(context?: AgentContext): LlamaCppRuntime {
  if (!sharedLlamaRuntime) {
    sharedLlamaRuntime = new LlamaCppRuntime(context?.llamaConfig);
  } else if (context?.llamaConfig) {
    sharedLlamaRuntime.setConfig(context.llamaConfig);
  }
  return sharedLlamaRuntime;
}

export function isCloudProvider(provider?: string): boolean {
  return (
    provider === 'gemini' ||
    provider === 'anthropic' ||
    provider === 'openai' ||
    provider === 'openrouter' ||
    provider === 'groq'
  );
}

export function resolveProvider(context?: Partial<AgentContext>): ProviderType {
  if (context?.provider) {
    return context.provider as ProviderType;
  }

  // Auto-detect based on model name prefix
  const model = context?.model?.toLowerCase() || '';
  if (model.startsWith('gemini')) {
    return 'gemini';
  }
  if (model.startsWith('claude')) {
    return 'anthropic';
  }
  if (
    model.startsWith('gpt-') ||
    model.startsWith('o1') ||
    model.startsWith('o3') ||
    model.startsWith('o4')
  ) {
    return 'openai';
  }
  if (
    model.includes('groq') ||
    model.includes('qwen3.8') ||
    model.includes('qwen-3.8') ||
    model.startsWith('llama-3') ||
    model.startsWith('mixtral') ||
    model.startsWith('gemma2')
  ) {
    if (process.env.GROQ_API_KEY) return 'groq';
  }
  if (model.includes('/') || (process.env.OPENROUTER_API_KEY && !process.env.OPENAI_API_KEY)) {
    return 'openrouter';
  }

  // Auto-detect based on environment variables
  if (process.env.ANTHROPIC_API_KEY) {
    return 'anthropic';
  }
  if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) {
    return 'gemini';
  }
  if (process.env.GROQ_API_KEY) {
    return 'groq';
  }
  if (process.env.OPENROUTER_API_KEY) {
    return 'openrouter';
  }
  if (process.env.OPENAI_API_KEY) {
    return 'openai';
  }

  return 'ollama';
}

export function createLLMProvider(context: AgentContext): ILLMProvider {
  const provider = context.provider || resolveProvider(context);

  if (provider === 'gemini') {
    const model = context.model || 'gemini-3.6-flash';
    // Reject keys from other cloud providers (sk-, gsk_)
    const validExplicitKey = context.apiKey && !context.apiKey.startsWith('sk-') && !context.apiKey.startsWith('gsk_')
      ? context.apiKey
      : undefined;
    const apiKey = validExplicitKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
    // Reject endpoints from other cloud providers
    const validExplicitBase = context.apiBase &&
      !context.apiBase.includes('anthropic.com') &&
      !context.apiBase.includes('openai.com') &&
      !context.apiBase.includes('groq.com') &&
      !context.apiBase.includes('openrouter.ai')
      ? context.apiBase
      : 'https://generativelanguage.googleapis.com';
    const numCtx = context.numCtx || 1048576;
    return new GeminiProvider(model, apiKey, validExplicitBase, numCtx);
  }

  if (provider === 'anthropic') {
    const model = context.model || 'claude-3-5-sonnet-20241022';
    const validExplicitKey = context.apiKey && !context.apiKey.startsWith('AIza') && !context.apiKey.startsWith('gsk_') && !context.apiKey.startsWith('sk-proj-')
      ? context.apiKey
      : undefined;
    const apiKey = validExplicitKey || process.env.ANTHROPIC_API_KEY || '';
    const validExplicitBase = context.apiBase &&
      !context.apiBase.includes('googleapis.com') &&
      !context.apiBase.includes('openai.com') &&
      !context.apiBase.includes('groq.com') &&
      !context.apiBase.includes('openrouter.ai')
      ? context.apiBase
      : 'https://api.anthropic.com';
    const numCtx = context.numCtx || 200000;
    return new AnthropicProvider(model, apiKey, validExplicitBase, numCtx);
  }

  if (provider === 'openrouter') {
    const model = context.model || 'anthropic/claude-3.5-sonnet';
    const validExplicitKey = context.apiKey && !context.apiKey.startsWith('AIza') && !context.apiKey.startsWith('gsk_')
      ? context.apiKey
      : undefined;
    const apiKey = validExplicitKey || process.env.OPENROUTER_API_KEY || '';
    const validExplicitBase = context.apiBase && context.apiBase.includes('openrouter')
      ? context.apiBase
      : 'https://openrouter.ai/api/v1';
    const numCtx = context.numCtx || 128000;
    return new OpenAICompatibleProvider(model, validExplicitBase, apiKey, numCtx, {
      'HTTP-Referer': 'https://github.com/locode/locode',
      'X-Title': 'Locode'
    });
  }

  if (provider === 'groq') {
    let model = context.model || 'qwen/qwen3.8-27b';
    if (model === 'qwen-3.8-27b' || model === 'qwen 3.8 27b' || model === 'qwen3.8-27b') {
      model = 'qwen/qwen3.8-27b';
    }
    const validExplicitKey = context.apiKey && (context.apiKey.startsWith('gsk_') || (!context.apiKey.startsWith('sk-') && !context.apiKey.startsWith('AIza')))
      ? context.apiKey
      : undefined;
    const apiKey = validExplicitKey || process.env.GROQ_API_KEY || '';
    const validExplicitBase = context.apiBase && context.apiBase.includes('groq')
      ? context.apiBase
      : 'https://api.groq.com/openai/v1';
    const numCtx = context.numCtx || 131072;
    return new OpenAICompatibleProvider(model, validExplicitBase, apiKey, numCtx, {
      'User-Agent': 'Locode/0.1.0'
    });
  }

  if (provider === 'openai') {
    const model = context.model || 'gpt-4o';
    const validExplicitKey = context.apiKey && !context.apiKey.startsWith('AIza') && !context.apiKey.startsWith('sk-ant-') && !context.apiKey.startsWith('gsk_')
      ? context.apiKey
      : undefined;
    const apiKey = validExplicitKey || process.env.OPENAI_API_KEY || 'not-needed';
    const validExplicitBase = context.apiBase &&
      !context.apiBase.includes('anthropic.com') &&
      !context.apiBase.includes('googleapis.com') &&
      !context.apiBase.includes('groq.com')
      ? context.apiBase
      : 'https://api.openai.com/v1';
    const numCtx = context.numCtx || 128000;
    return new OpenAICompatibleProvider(model, validExplicitBase, apiKey, numCtx);
  }

  if (provider === 'lmstudio' || provider === 'vllm') {
    const model = context.model || 'local-model';
    const apiBase = context.apiBase || 'http://localhost:1234/v1';
    const apiKey = 'not-needed';
    const numCtx = context.numCtx || 32768;
    return new OpenAICompatibleProvider(model, apiBase, apiKey, numCtx);
  }

  if (provider === 'llamacpp') {
    const runtime = getSharedLlamaRuntime(context);
    const ctx = context.numCtx || runtime.getConfig().contextSize;
    return new LlamaCppTurboQuantProvider(runtime, context.model, ctx);
  }

  // Default: Ollama
  return new OllamaProvider(
    context.model || 'qwen2.5-coder:7b',
    context.ollamaHost || process.env.OLLAMA_HOST || 'http://127.0.0.1:11434',
    context.numCtx
  );
}
