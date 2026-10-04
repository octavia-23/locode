import { ChatMessage, ToolDefinition } from '../types.js';

export interface ChatProviderResponse {
  content: string;
  tool_calls?: Array<{
    function: {
      name: string;
      arguments: Record<string, any>;
    };
  }>;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    durationMs: number;
    tokensPerSecond: number;
  };
}

export interface ILLMProvider {
  getModel(): string;
  setModel(model: string): void;
  isHealthy(): Promise<boolean>;
  getAvailableModels(): Promise<string[]>;
  chat(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    onToken?: (token: string) => void
  ): Promise<ChatProviderResponse>;
  getNumCtx?(): number;
  setNumCtx?(numCtx: number): void;
}


