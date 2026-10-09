import ollama, { Message as OllamaMessage } from 'ollama';
import { ChatMessage, ToolDefinition } from '../types.js';
import { ILLMProvider, ChatProviderResponse } from './types.js';

export class OllamaProvider implements ILLMProvider {
  private model: string;
  private host: string;
  private numCtx: number;

  constructor(model: string = 'qwen2.5-coder:7b', host: string = 'http://127.0.0.1:11434', numCtx: number = 8192) {
    this.model = model;
    this.host = host;
    this.numCtx = numCtx;
  }

  setModel(model: string) {
    this.model = model;
  }

  getModel(): string {
    return this.model;
  }

  getNumCtx(): number {
    return this.numCtx;
  }

  setNumCtx(numCtx: number): void {
    this.numCtx = numCtx;
  }


  async isHealthy(): Promise<boolean> {
    try {
      await ollama.list();
      return true;
    } catch {
      return false;
    }
  }

  async getAvailableModels(): Promise<string[]> {
    try {
      const res = await ollama.list();
      return res.models.map(m => m.name);
    } catch {
      return [];
    }
  }

  async chat(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    onToken?: (token: string) => void,
    options?: import('./types.js').ChatOptions
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
        const stream = await ollama.chat({
          model: this.model,
          messages: ollamaMessages,
          tools: formattedTools,
          stream: true,
          options: {
            num_ctx: this.numCtx,
            temperature: 0.1,
            num_predict: 4096
          }
        });

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

        const parsedCalls = accumulatedToolCalls.length > 0
          ? accumulatedToolCalls
          : this.parseFallbackToolCalls(fullContent);

        return {
          content: fullContent,
          tool_calls: parsedCalls.length > 0 ? parsedCalls : undefined,
          usage: {
            promptTokens,
            completionTokens,
            totalTokens: promptTokens + completionTokens,
            durationMs,
            tokensPerSecond: Math.round(tps * 10) / 10
          }
        };
      } catch (err: any) {
        return this.chatNonStreaming(ollamaMessages, formattedTools, startTime);
      }
    }

    return this.chatNonStreaming(ollamaMessages, formattedTools, startTime);
  }

  private async chatNonStreaming(messages: OllamaMessage[], tools: any[], startTime: number): Promise<ChatProviderResponse> {
    const response = await ollama.chat({
      model: this.model,
      messages: messages,
      tools: tools,
      stream: false,
      options: {
        num_ctx: this.numCtx,
        temperature: 0.1,
        num_predict: 4096
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
    const toolCalls = (response.message.tool_calls && response.message.tool_calls.length > 0)
      ? response.message.tool_calls
      : this.parseFallbackToolCalls(content);

    return {
      content,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
        durationMs,
        tokensPerSecond: Math.round(tps * 10) / 10
      }
    };
  }

  /**
   * Fallback parser for Qwen 2.5 Coder in case it outputs tool calls directly in text
   */
  private parseFallbackToolCalls(text: string): any[] {
    const toolCalls: any[] = [];

    // Pattern 1: <tool_call>\n{...}\n</tool_call>
    const xmlRegex = /<tool_call>([\s\S]*?)<\/tool_call>/g;
    let match: RegExpExecArray | null;
    while ((match = xmlRegex.exec(text)) !== null) {
      try {
        const parsed = JSON.parse(match[1].trim());
        if (parsed.name) {
          toolCalls.push({
            function: {
              name: parsed.name,
              arguments: parsed.arguments || {}
            }
          });
        }
      } catch {}
    }

    if (toolCalls.length > 0) return toolCalls;

    // Pattern 2: ```json {"name": "...", "arguments": ...} ```
    const codeBlockRegex = /```(?:json)?\s*(\{\s*"name"\s*:\s*"[^"]+".*?\})\s*```/gs;
    while ((match = codeBlockRegex.exec(text)) !== null) {
      try {
        const parsed = JSON.parse(match[1]);
        if (parsed.name) {
          toolCalls.push({
            function: {
              name: parsed.name,
              arguments: parsed.arguments || {}
            }
          });
        }
      } catch {}
    }

    if (toolCalls.length > 0) return toolCalls;

    // Pattern 3: Entire text is a JSON object with name & arguments
    try {
      const parsed = JSON.parse(text.trim());
      if (parsed.name && typeof parsed.name === 'string') {
        toolCalls.push({
          function: {
            name: parsed.name,
            arguments: parsed.arguments || {}
          }
        });
        return toolCalls;
      }
    } catch {}

    // Pattern 4: Embedded JSON object with name & arguments
    const jsonMatcher = /\{\s*"name"\s*:\s*"([a-zA-Z0-9_-]+)"\s*,\s*"arguments"\s*:\s*(\{[\s\S]*?\})\s*\}/g;
    while ((match = jsonMatcher.exec(text)) !== null) {
      try {
        const name = match[1];
        const args = JSON.parse(match[2]);
        toolCalls.push({
          function: {
            name,
            arguments: args
          }
        });
      } catch {}
    }

    return toolCalls;
  }
}
