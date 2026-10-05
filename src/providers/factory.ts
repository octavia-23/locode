import { AgentContext } from '../types.js';
import { ILLMProvider } from './types.js';
import { OllamaProvider } from './ollama.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import { LlamaCppTurboQuantProvider } from './llama-cpp.js';
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

export function createLLMProvider(context: AgentContext): ILLMProvider {
  if (context.provider === 'llamacpp') {
    const runtime = getSharedLlamaRuntime(context);
    const ctx = context.numCtx || runtime.getConfig().contextSize;
    return new LlamaCppTurboQuantProvider(runtime, context.model, ctx);
  }

  if (context.provider === 'openai' || context.provider === 'lmstudio' || context.provider === 'vllm') {
    return new OpenAICompatibleProvider(
      context.model,
      context.apiBase || 'http://localhost:1234/v1',
      context.apiKey || 'not-needed'
    );
  }

  // Default: Ollama
  return new OllamaProvider(context.model, context.ollamaHost, context.numCtx);
}
