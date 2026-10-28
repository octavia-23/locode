import { ChatMessage, ToolDefinition } from '../types.js';

export interface ChatProviderResponse {
  content: string;
  tool_calls?: Array<{
    id?: string;
    type?: string;
    function: {
      name: string;
      arguments: Record<string, any>;
    };
    thoughtSignature?: string;
    thought_signature?: string;
  }>;
  stopReason?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    durationMs: number;
    tokensPerSecond: number;
  };
}

export interface ChatOptions {
  toolChoice?: 'auto' | 'none' | 'required';
  maxTokens?: number;
  repeatPenalty?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  temperature?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  thinking?: { type?: string; budget_tokens?: number } | boolean;
}

export interface ModelCapabilities {
  supportsToolCalling: boolean;
  supportsStreaming: boolean;
  supportsStructuredOutput: boolean;
  supportsThinking: boolean;
  supportsUsageReporting: boolean;
  maxContextTokens: number;
  maxOutputTokens: number;
  defaultOutputTokens: number;
  costPerMillionInputTokens?: number;
  costPerMillionOutputTokens?: number;
}

export type StreamChunkType =
  | 'text_delta'
  | 'tool_call_delta'
  | 'thought_delta'
  | 'usage'
  | 'done'
  | 'error';

export interface ModelStreamChunk {
  type: StreamChunkType;
  text?: string;
  toolCall?: {
    index: number;
    id?: string;
    name?: string;
    argumentsDelta?: string;
  };
  thought?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  stopReason?: string;
  error?: Error;
}

export interface NormalizedModelRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  options?: ChatOptions;
}

export interface ILLMProvider {
  getModel(): string;
  setModel(model: string): void;
  isHealthy(): Promise<boolean>;
  getAvailableModels(): Promise<string[]>;
  chat(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    onToken?: (token: string) => void,
    options?: ChatOptions
  ): Promise<ChatProviderResponse>;
  getCapabilities?(): ModelCapabilities;
  streamChat?(
    request: NormalizedModelRequest
  ): AsyncIterable<ModelStreamChunk>;
  getNumCtx?(): number;
  setNumCtx?(numCtx: number): void;
  getModelLimits?(): { maxOutputTokens?: number };
}

export function getDefaultCapabilities(model: string = '', numCtx?: number): ModelCapabilities {
  const m = model.toLowerCase();
  const isCloud = m.startsWith('gemini') || m.startsWith('claude') || m.startsWith('gpt-') || m.startsWith('o1') || m.startsWith('o3') || m.includes('groq');

  let maxContext = numCtx || (isCloud ? 128000 : 32768);
  let maxOutput = 8192;

  if (m.startsWith('gemini')) {
    maxContext = numCtx || 1048576;
    maxOutput = 8192;
  } else if (m.startsWith('claude')) {
    maxContext = numCtx || 200000;
    maxOutput = 8192;
  } else if (m.includes('35b') || m.includes('a3b')) {
    maxContext = numCtx || 262144;
    maxOutput = 4096;
  }

  return {
    supportsToolCalling: true,
    supportsStreaming: true,
    supportsStructuredOutput: isCloud,
    supportsThinking: m.includes('o1') || m.includes('o3') || m.includes('r1') || m.includes('thinking') || m.includes('3.8'),
    supportsUsageReporting: true,
    maxContextTokens: maxContext,
    maxOutputTokens: maxOutput,
    defaultOutputTokens: isCloud ? 8192 : 4096
  };
}

export function getModelCapabilities(provider: ILLMProvider): ModelCapabilities {
  if (typeof provider.getCapabilities === 'function') {
    return provider.getCapabilities();
  }
  const ctx = typeof provider.getNumCtx === 'function' ? provider.getNumCtx() : undefined;
  return getDefaultCapabilities(provider.getModel(), ctx);
}
