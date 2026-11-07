import { AgentContext, ProviderType } from '../types.js';
import { ILLMProvider } from './types.js';
import { OllamaProvider } from './ollama.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import { LlamaCppTurboQuantProvider } from './llama-cpp.js';
import { GeminiProvider } from './gemini.js';
import { AnthropicProvider } from './anthropic.js';
import { LlamaCppRuntime } from '../runtime/manager.js';
import { DEFAULT_QWEN_MODEL_ALIAS } from '../runtime/profiles.js';
import { identifyProviderFromApiKey, loadOpenCodeConfig } from '../utils/config.js';

let sharedLlamaRuntime: LlamaCppRuntime | null = null;

export const SUPPORTED_PROVIDERS: { name: ProviderType; defaultModel: string; type: 'cloud' | 'local' }[] = [
  { name: 'gemini', defaultModel: 'gemini-3.6-flash', type: 'cloud' },
  { name: 'anthropic', defaultModel: 'claude-3-5-sonnet-20241022', type: 'cloud' },
  { name: 'apinex', defaultModel: 'free/deepseek-v4.1-flash', type: 'cloud' },
  { name: 'openai', defaultModel: 'gpt-4o', type: 'cloud' },
  { name: 'openrouter', defaultModel: 'anthropic/claude-3.5-sonnet', type: 'cloud' },
  { name: 'groq', defaultModel: 'qwen/qwen3.8-27b', type: 'cloud' },
  { name: 'nim', defaultModel: 'meta/llama-3.3-70b-instruct', type: 'cloud' },
  { name: 'llamacpp', defaultModel: DEFAULT_QWEN_MODEL_ALIAS, type: 'local' },
  { name: 'ollama', defaultModel: 'qwen2.5-coder:7b', type: 'local' }
];

export function getDefaultModelForProvider(provider: ProviderType): string {
  const match = SUPPORTED_PROVIDERS.find(p => p.name === provider);
  return match ? match.defaultModel : 'qwen2.5-coder:7b';
}

export function getDefaultContextForProvider(provider: ProviderType): number {
  switch (provider) {
    case 'gemini':
      return 1048576;
    case 'anthropic':
    case 'apinex':
      return 200000;
    case 'groq':
    case 'nim':
    case 'nvidia':
      return 131072;
    case 'openai':
    case 'openrouter':
      return 128000;
    case 'llamacpp':
      return 262144;
    case 'ollama':
    default:
      return 8192;
  }
}

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
    provider === 'apinex' ||
    provider === 'openai' ||
    provider === 'openrouter' ||
    provider === 'groq' ||
    provider === 'nim' ||
    provider === 'nvidia'
  );
}

export function resolveProvider(context?: Partial<AgentContext>): ProviderType {
  if (context?.provider) {
    return context.provider as ProviderType;
  }

  // 1. Auto-detect based on API key prefix if provided
  if (context?.apiKey) {
    const fromKey = identifyProviderFromApiKey(context.apiKey);
    if (fromKey) {
      return fromKey;
    }
  }

  // 2. Auto-detect based on model name prefix
  const model = context?.model?.toLowerCase() || '';
  if (
    model.startsWith('apinex/') ||
    model.startsWith('free/') ||
    context?.apiBase?.includes('apinex') ||
    model === 'claude-sonnet-5.5' ||
    model === 'gpt-6.1-sol' ||
    model === 'deepseek-v4.1-flash' ||
    model === 'kimi-k2.8'
  ) {
    return 'apinex';
  }
  if (model.startsWith('gemini')) {
    return 'gemini';
  }
  if (model.startsWith('claude')) {
    return 'anthropic';
  }
  if (
    model.startsWith('nvidia/') ||
    model.startsWith('nim/') ||
    model.includes('nemotron')
  ) {
    return 'nim';
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
  if (process.env.APINEX_API_KEY || process.env.APINEX_KEY) {
    return 'apinex';
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return 'anthropic';
  }
  if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) {
    return 'gemini';
  }
  if (process.env.NVIDIA_API_KEY || process.env.NVAPI_KEY) {
    return 'nim';
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
  let provider = context.provider || resolveProvider(context);

  if ((provider as string) === 'llama.cpp') {
    provider = 'llamacpp';
  }

  // Check if provider/model matches custom external configuration (e.g. from opencode.json)
  const openCodeConfigs = loadOpenCodeConfig();
  let rawModel = context.model || getDefaultModelForProvider(provider) || '';
  if (provider === 'apinex') {
    const lower = rawModel.toLowerCase();
    if (lower === 'gemini' || lower === 'gemini-flash' || lower === 'gemini-3.8-flash') {
      rawModel = 'free/gemini-3.8-flash';
    } else if (lower === 'deepseek' || lower === 'deepseek-flash' || lower === 'deepseek-v4.1-flash') {
      rawModel = 'free/deepseek-v4.1-flash';
    }
  }
  const [modelPrefix, modelSuffix] = rawModel.includes('/') ? rawModel.split('/', 2) : ['', rawModel];

  let matchedExternal = undefined;
  if (provider !== 'llamacpp') {
    const isModelPrefixProvider = Boolean(
      modelPrefix &&
      modelPrefix !== 'free' &&
      openCodeConfigs.some(c => c.providerName === modelPrefix || c.providerName.replace('.', '') === modelPrefix.replace('.', ''))
    );

    matchedExternal = openCodeConfigs.find(c => {
      const modelMatches = c.modelId === rawModel || (Boolean(modelSuffix) && c.modelId === modelSuffix);
      if (!modelMatches) return false;
      if (context.provider) {
        return c.providerName === context.provider || c.providerName.replace('.', '') === context.provider.replace('.', '');
      }
      if (isModelPrefixProvider) {
        return c.providerName === modelPrefix || c.providerName.replace('.', '') === modelPrefix.replace('.', '');
      }
      return true;
    }) || openCodeConfigs.find(c =>
      (c.providerName === context.provider || c.providerName.replace('.', '') === (context.provider || '').replace('.', '')) &&
      c.providerName !== 'llama.cpp' &&
      Boolean(c.baseURL)
    );
  }

  if (matchedExternal && matchedExternal.baseURL) {
    const model = matchedExternal.modelId;
    const apiBase = context.apiBase || matchedExternal.baseURL;
    const apiKey = context.apiKey || matchedExternal.apiKey || 'not-needed';
    const numCtx = context.numCtx || matchedExternal.contextLimit || getDefaultContextForProvider(provider) || 65536;
    return new OpenAICompatibleProvider(model, apiBase, apiKey, numCtx);
  }

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

  if (provider === 'apinex') {
    let rawModel = context.model || 'free/deepseek-v4.1-flash';
    if (rawModel.startsWith('apinex/')) {
      rawModel = rawModel.replace(/^apinex\//, '');
    }
    const lower = rawModel.toLowerCase();
    if (lower === 'gemini' || lower === 'gemini-flash' || lower === 'gemini-3.8-flash') {
      rawModel = 'free/gemini-3.8-flash';
    } else if (lower === 'deepseek' || lower === 'deepseek-flash' || lower === 'deepseek-v4.1-flash') {
      rawModel = 'free/deepseek-v4.1-flash';
    }
    const model = rawModel;
    const validExplicitKey = context.apiKey && !context.apiKey.startsWith('AIza') && !context.apiKey.startsWith('gsk_')
      ? context.apiKey
      : undefined;
    const apiKey = validExplicitKey || process.env.APINEX_API_KEY || process.env.APINEX_KEY || '';
    const validExplicitBase = context.apiBase && context.apiBase.includes('apinex')
      ? context.apiBase
      : (process.env.APINEX_BASE_URL || 'https://api.apinex.bond/v1');
    const numCtx = context.numCtx || 200000;
    return new OpenAICompatibleProvider(model, validExplicitBase, apiKey, numCtx, {
      'User-Agent': 'Locode/0.1.0'
    });
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

  if (provider === 'nim' || provider === 'nvidia') {
    const model = context.model || 'meta/llama-3.3-70b-instruct';
    const validExplicitKey = context.apiKey && !context.apiKey.startsWith('AIza') && !context.apiKey.startsWith('sk-ant-') && !context.apiKey.startsWith('gsk_')
      ? context.apiKey
      : undefined;
    const apiKey = validExplicitKey || process.env.NVIDIA_API_KEY || process.env.NVAPI_KEY || 'not-needed';
    const validExplicitBase = context.apiBase &&
      !context.apiBase.includes('anthropic.com') &&
      !context.apiBase.includes('googleapis.com') &&
      !context.apiBase.includes('groq.com') &&
      !context.apiBase.includes('openrouter.ai')
      ? context.apiBase
      : 'https://integrate.api.nvidia.com/v1';
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

  if (provider === 'llamacpp' || (provider as string) === 'llama.cpp') {
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
