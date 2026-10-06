import { ChatMessage, ToolDefinition } from '../types.js';
import { ILLMProvider, ChatProviderResponse } from './types.js';
import { LlamaCppRuntime } from '../runtime/manager.js';
import { LlamaRuntimeConfig } from '../runtime/profiles.js';

export class LlamaCppTurboQuantProvider implements ILLMProvider {
  private model: string;
  private apiBase: string;
  private runtime: LlamaCppRuntime;
  private numCtx: number;

  constructor(runtime: LlamaCppRuntime, modelAlias: string = 'locode-qwen35b-a3b', numCtx: number = 32768) {
    this.runtime = runtime;
    this.model = modelAlias;
    this.apiBase = runtime.getApiBase();
    this.numCtx = numCtx;
  }

  getRuntime(): LlamaCppRuntime {
    return this.runtime;
  }

  setModel(model: string): void {
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
    this.runtime.setConfig({ contextSize: numCtx });
  }

  async isHealthy(): Promise<boolean> {
    try {
      const res = await fetch(`${this.runtime.getApiBase()}/models`, {
        signal: AbortSignal.timeout(2000)
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async getAvailableModels(): Promise<string[]> {
    try {
      const res = await fetch(`${this.runtime.getApiBase()}/models`, {
        signal: AbortSignal.timeout(2000)
      });
      if (!res.ok) return [this.model];
      const data: any = await res.json();
      const ids = (data.data || []).map((m: any) => m.id);
      return ids.length > 0 ? ids : [this.model];
    } catch {
      return [this.model];
    }
  }

  async chat(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    onToken?: (token: string) => void,
    options?: import('./types.js').ChatOptions
  ): Promise<ChatProviderResponse> {
    const formattedTools = tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters
      }
    }));

    const formattedMessages = messages.map(m => {
      const msg: any = { role: m.role, content: m.content };
      if (m.tool_calls) msg.tool_calls = m.tool_calls;
      if (m.name) msg.name = m.name;
      if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
      return msg;
    });

    const startTime = Date.now();
    const endpoint = `${this.runtime.getApiBase()}/chat/completions`;

    // 1. Streaming support if onToken is provided
    if (onToken) {
      try {
        const streamResponse = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: this.model,
            messages: formattedMessages,
            tools: formattedTools.length > 0 ? formattedTools : undefined,
            tool_choice: options?.toolChoice,
            temperature: 0.1,
            stream: true,
            stream_options: { include_usage: true }
          })
        });

        if (streamResponse.ok && streamResponse.body) {
          const reader = streamResponse.body.getReader();
          const decoder = new TextDecoder();
          let fullContent = '';
          const toolCallsAccumulator: Map<number, { id?: string; name: string; arguments: string }> = new Map();
          let usageTokens = { prompt: 0, completion: 0, total: 0 };

          let buffer = '';
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || !trimmed.startsWith('data:')) continue;
              if (trimmed === 'data: [DONE]') continue;

              try {
                const json = JSON.parse(trimmed.slice(5).trim());
                const delta = json.choices?.[0]?.delta;
                if (delta?.content) {
                  fullContent += delta.content;
                  onToken(delta.content);
                }

                if (delta?.tool_calls) {
                  for (const tc of delta.tool_calls) {
                    const idx = tc.index ?? 0;
                    const existing = toolCallsAccumulator.get(idx) || { id: tc.id, name: '', arguments: '' };
                    if (tc.id) existing.id = tc.id;
                    if (tc.function?.name) existing.name += tc.function.name;
                    if (tc.function?.arguments) existing.arguments += tc.function.arguments;
                    toolCallsAccumulator.set(idx, existing);
                  }
                }

                if (json.usage) {
                  usageTokens = {
                    prompt: json.usage.prompt_tokens || 0,
                    completion: json.usage.completion_tokens || 0,
                    total: json.usage.total_tokens || 0
                  };
                }
              } catch {}
            }
          }

          const durationMs = Date.now() - startTime;
          const parsedToolCalls = Array.from(toolCallsAccumulator.values()).map(tc => {
            let parsedArgs: Record<string, any> = {};
            try {
              parsedArgs = JSON.parse(tc.arguments);
            } catch {
              parsedArgs = {};
            }
            return {
              id: tc.id,
              type: 'function',
              function: {
                name: tc.name,
                arguments: parsedArgs
              }
            };
          });

          // Fallback parsing if model returned tool calls inside markdown or tags
          const finalToolCalls = parsedToolCalls.length > 0
            ? parsedToolCalls
            : this.parseFallbackToolCalls(fullContent);

          const tps = usageTokens.completion > 0 && durationMs > 0
            ? usageTokens.completion / (durationMs / 1000)
            : 0;

          return {
            content: fullContent,
            tool_calls: finalToolCalls.length > 0 ? finalToolCalls : undefined,
            usage: {
              promptTokens: usageTokens.prompt,
              completionTokens: usageTokens.completion,
              totalTokens: usageTokens.total || usageTokens.prompt + usageTokens.completion,
              durationMs,
              tokensPerSecond: Math.round(tps * 10) / 10
            }
          };
        }
      } catch {
        // Fall back to non-streaming if streaming fails
      }
    }

    // 2. Non-streaming call
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages: formattedMessages,
        tools: formattedTools.length > 0 ? formattedTools : undefined,
        tool_choice: options?.toolChoice,
        temperature: 0.1
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`llama-server API error (${response.status}): ${errText}`);
    }

    const data: any = await response.json();
    const durationMs = Date.now() - startTime;

    const choice = data.choices?.[0];
    const message = choice?.message || {};
    const content = message.content || '';
    let toolCalls = message.tool_calls;

    if (toolCalls && Array.isArray(toolCalls)) {
      toolCalls = toolCalls.map((tc: any) => ({
        ...tc,
        function: {
          ...tc.function,
          arguments: typeof tc.function.arguments === 'string'
            ? (() => { try { return JSON.parse(tc.function.arguments); } catch { return {}; } })()
            : tc.function.arguments
        }
      }));
    } else {
      const fallback = this.parseFallbackToolCalls(content);
      if (fallback.length > 0) {
        toolCalls = fallback;
      }
    }

    const promptTokens = data.usage?.prompt_tokens || 0;
    const completionTokens = data.usage?.completion_tokens || 0;
    const totalTokens = data.usage?.total_tokens || promptTokens + completionTokens;
    const tps = completionTokens > 0 && durationMs > 0
      ? completionTokens / (durationMs / 1000)
      : 0;

    return {
      content,
      tool_calls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens,
        durationMs,
        tokensPerSecond: Math.round(tps * 10) / 10
      }
    };
  }

  private parseFallbackToolCalls(content: string): Array<{ id?: string; type?: string; function: { name: string; arguments: any } }> {
    if (!content) return [];
    const calls: Array<{ id?: string; type?: string; function: { name: string; arguments: any } }> = [];

    // Pattern 1: <tool_call>\n{...}\n</tool_call>
    const xmlRegex = /<tool_call>([\s\S]*?)<\/tool_call>/gi;
    let match: RegExpExecArray | null;
    while ((match = xmlRegex.exec(content)) !== null) {
      try {
        const parsed = JSON.parse(match[1].trim());
        if (parsed.name) {
          calls.push({
            id: `call_${Date.now()}_${calls.length}`,
            type: 'function',
            function: {
              name: parsed.name,
              arguments: parsed.arguments || {}
            }
          });
        }
      } catch {}
    }

    if (calls.length > 0) return calls;

    // Pattern 2: ```json {"name": "...", "arguments": ...} ```
    const codeBlockRegex = /```(?:json)?\s*(\{\s*"name"\s*:\s*"[^"]+".*?\})\s*```/gis;
    while ((match = codeBlockRegex.exec(content)) !== null) {
      try {
        const parsed = JSON.parse(match[1]);
        if (parsed.name) {
          calls.push({
            id: `call_${Date.now()}_${calls.length}`,
            type: 'function',
            function: {
              name: parsed.name,
              arguments: parsed.arguments || {}
            }
          });
        }
      } catch {}
    }

    if (calls.length > 0) return calls;

    // Pattern 3: Entire text is a JSON object with name & arguments
    try {
      const parsed = JSON.parse(content.trim());
      if (parsed.name && typeof parsed.name === 'string') {
        calls.push({
          id: `call_${Date.now()}_0`,
          type: 'function',
          function: {
            name: parsed.name,
            arguments: parsed.arguments || {}
          }
        });
        return calls;
      }
    } catch {}

    // Pattern 4: Embedded JSON object with name & arguments
    const jsonMatcher = /\{\s*"name"\s*:\s*"([a-zA-Z0-9_-]+)"\s*,\s*"arguments"\s*:\s*(\{[\s\S]*?\})\s*\}/g;
    while ((match = jsonMatcher.exec(content)) !== null) {
      try {
        const name = match[1];
        const args = JSON.parse(match[2]);
        calls.push({
          id: `call_${Date.now()}_${calls.length}`,
          type: 'function',
          function: {
            name,
            arguments: args
          }
        });
      } catch {}
    }

    return calls;
  }
}
