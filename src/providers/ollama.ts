import { Ollama, Message as OllamaMessage } from 'ollama';
import { ChatMessage, ToolDefinition } from '../types.js';
import { ILLMProvider, ChatProviderResponse, ModelCapabilities, ChatOptions } from './types.js';
import { extractToolCalls } from '../utils/tool-parser.js';

export class OllamaProvider implements ILLMProvider {
  private model: string;
  private host: string;
  private numCtx: number;
  private client: Ollama;

  constructor(
    model: string = 'qwen2.5-coder:7b',
    host: string = 'http://127.0.0.1:11434',
    numCtx: number = 8192
  ) {
    this.model = model;
    this.host = host;
    this.numCtx = numCtx;
    this.client = new Ollama({ host: this.host });
  }

  setModel(model: string) {
    this.model = model;
  }

  getModel(): string {
    return this.model;
  }

  getHost(): string {
    return this.host;
  }

  setHost(host: string) {
    this.host = host;
    this.client = new Ollama({ host: this.host });
  }

  getNumCtx(): number {
    return this.numCtx;
  }

  setNumCtx(numCtx: number): void {
    this.numCtx = numCtx;
  }

  getCapabilities(): ModelCapabilities {
    return {
      supportsToolCalling: true,
      supportsStreaming: true,
      supportsStructuredOutput: false,
      supportsThinking: this.model.includes('r1') || this.model.includes('thinking'),
      supportsUsageReporting: true,
      maxContextTokens: this.numCtx,
      maxOutputTokens: 4096,
      defaultOutputTokens: 4096
    };
  }

  async isHealthy(): Promise<boolean> {
    try {
      await this.client.list();
      return true;
    } catch {
      return false;
    }
  }

  async getAvailableModels(): Promise<string[]> {
    try {
      const res = await this.client.list();
      return res.models.map(m => m.name);
    } catch {
      return [];
    }
  }

  async chat(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    onToken?: (token: string) => void,
    options?: ChatOptions
  ): Promise<ChatProviderResponse> {
    const formattedTools = tools.map(t => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters
      }
    }));

    const ollamaMessages: OllamaMessage[] = messages.map(m => {
      const msg: any = {
        role: m.role,
        content: m.content
      };
      if (m.tool_calls) {
        msg.tool_calls = m.tool_calls.map(tc => ({
          function: {
            name: tc.function.name,
            arguments: typeof tc.function.arguments === 'string'
              ? JSON.parse(tc.function.arguments)
              : tc.function.arguments
          }
        }));
      }
      return msg as OllamaMessage;
    });

    const startTime = Date.now();

    // If streaming callback provided
    if (onToken) {
      try {
        const stream = await this.client.chat({
          model: this.model,
          messages: ollamaMessages,
          tools: formattedTools.length > 0 ? formattedTools : undefined,
          stream: true,
          options: {
            num_ctx: this.numCtx,
            temperature: options?.temperature ?? 0.1,
            repeat_penalty: options?.repeatPenalty ?? 1.1,
            num_predict: options?.maxTokens || 4096
          }
        });

        // Wire up cancellation signal if provided
        if (options?.signal) {
          if (options.signal.aborted) {
            stream.abort();
            throw new Error('Operation was aborted by caller');
          }
          options.signal.addEventListener('abort', () => {
            stream.abort();
          }, { once: true });
        }

        let fullContent = '';
        const accumulatedToolCalls: any[] = [];
        let promptTokens = 0;
        let completionTokens = 0;
        let evalDurationNs = 0;

        for await (const chunk of stream) {
          if (chunk.message.content) {
            fullContent += chunk.message.content;
            onToken(chunk.message.content);
          }
          if (chunk.message.tool_calls && chunk.message.tool_calls.length > 0) {
            accumulatedToolCalls.push(...chunk.message.tool_calls);
          }
          if (chunk.prompt_eval_count) promptTokens = chunk.prompt_eval_count;
          if (chunk.eval_count) completionTokens = chunk.eval_count;
          if (chunk.eval_duration) evalDurationNs = chunk.eval_duration;
        }

        const durationMs = Date.now() - startTime;
        const tps = evalDurationNs > 0
          ? completionTokens / (evalDurationNs / 1e9)
          : (completionTokens / (durationMs / 1000) || 0);

        let parsedCalls = accumulatedToolCalls;
        let cleanedContent = fullContent;
        if (parsedCalls.length === 0) {
          const extracted = extractToolCalls(fullContent);
          if (extracted.hasToolCalls) {
            parsedCalls = extracted.toolCalls;
            cleanedContent = extracted.cleanedText;
          }
        }

        return {
          content: cleanedContent,
          tool_calls: parsedCalls.length > 0 ? parsedCalls : undefined,
          stopReason: 'stop',
          usage: {
            promptTokens,
            completionTokens,
            totalTokens: promptTokens + completionTokens,
            durationMs,
            tokensPerSecond: Math.round(tps * 10) / 10
          }
        };
      } catch (err: any) {
        if (options?.signal?.aborted || err.message?.includes('abort')) {
          throw err;
        }
        // If streaming failed early before receiving tokens, attempt non-streaming fallback
        return this.chatNonStreaming(ollamaMessages, formattedTools, startTime, options);
      }
    }

    return this.chatNonStreaming(ollamaMessages, formattedTools, startTime, options);
  }

  private async chatNonStreaming(
    messages: OllamaMessage[],
    tools: any[],
    startTime: number,
    options?: ChatOptions
  ): Promise<ChatProviderResponse> {
    const response = await this.client.chat({
      model: this.model,
      messages: messages,
      tools: tools.length > 0 ? tools : undefined,
      stream: false,
      options: {
        num_ctx: this.numCtx,
        temperature: options?.temperature ?? 0.1,
        repeat_penalty: options?.repeatPenalty ?? 1.1,
        num_predict: options?.maxTokens || 4096
      }
    });

    const durationMs = Date.now() - startTime;
    const promptTokens = response.prompt_eval_count || 0;
    const completionTokens = response.eval_count || 0;
    const evalDuration = response.eval_duration || 0;
    const tps = evalDuration > 0
      ? completionTokens / (evalDuration / 1e9)
      : (completionTokens / (durationMs / 1000) || 0);

    const content = response.message.content || '';
    let toolCalls = (response.message.tool_calls && response.message.tool_calls.length > 0)
      ? response.message.tool_calls
      : undefined;
    let cleanedContent = content;

    if (!toolCalls || toolCalls.length === 0) {
      const extracted = extractToolCalls(content);
      if (extracted.hasToolCalls) {
        toolCalls = extracted.toolCalls;
        cleanedContent = extracted.cleanedText;
      }
    }

    return {
      content: cleanedContent,
      tool_calls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
      stopReason: (response as any).done_reason || 'stop',
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
        durationMs,
        tokensPerSecond: Math.round(tps * 10) / 10
      }
    };
  }
}
