import { AgentContext } from '../types.js';
import { ILLMProvider } from './types.js';
import { OllamaProvider } from './ollama.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';

export function createLLMProvider(context: AgentContext): ILLMProvider {
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

