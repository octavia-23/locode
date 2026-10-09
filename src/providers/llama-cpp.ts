import { Agent, setGlobalDispatcher } from 'undici';
import { ChatMessage, ToolDefinition } from '../types.js';
import { ILLMProvider, ChatProviderResponse } from './types.js';
import { LlamaCppRuntime } from '../runtime/manager.js';
import { LlamaRuntimeConfig } from '../runtime/profiles.js';
import { extractToolCalls } from '../utils/tool-parser.js';

// Ensure unlimited headers/body timeout globally for massive context windows
try {
  setGlobalDispatcher(
    new Agent({
      headersTimeout: 0,
      bodyTimeout: 0,
      connectTimeout: 60000,
      keepAliveTimeout: 300000,
      keepAliveMaxTimeout: 600000
    })
  );
} catch {}

export class LlamaCppTurboQuantProvider implements ILLMProvider {
  private model: string;
  private apiBase: string;
  private runtime: LlamaCppRuntime;
  private numCtx: number;

  constructor(runtime: LlamaCppRuntime, modelAlias: string = 'locode-qwen35b-a3b', numCtx: number = 262144) {
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

    // 1. Streaming support if onToken is provided (primary path in agent loop)
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
            temperature: 0.2,
            top_p: 0.85,
            min_p: 0.05,
            presence_penalty: 0.0,
            frequency_penalty: 0.0,
            repeat_penalty: 1.0,
            max_tokens: 4096,
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

          let firstTokenTime: number = 0;
          let serverReportedTps: number = 0;

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
                if (json.timings?.predicted_per_second) {
                  serverReportedTps = json.timings.predicted_per_second;
                }

                const delta = json.choices?.[0]?.delta;
                if (delta?.content) {
                  if (!firstTokenTime) {
                    firstTokenTime = Date.now();
                  }
                  fullContent += delta.content;
                  if (onToken) onToken(delta.content);
                }

                if (delta?.tool_calls) {
                  if (!firstTokenTime) {
                    firstTokenTime = Date.now();
                  }
                  for (const tc of delta.tool_calls) {
                    const idx = tc.index ?? 0;
                    const existing = toolCallsAccumulator.get(idx) || { id: tc.id, name: '', arguments: '' };
                    if (tc.id) existing.id = tc.id;
                    if (tc.function?.name) existing.name += tc.function.name;
                    if (tc.function?.arguments) {
                      existing.arguments += tc.function.arguments;
                    }
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
          let finalToolCalls = parsedToolCalls;
          let cleanedContent = fullContent;
          if (finalToolCalls.length === 0) {
            const extracted = extractToolCalls(fullContent);
            if (extracted.hasToolCalls) {
              finalToolCalls = extracted.toolCalls;
              cleanedContent = extracted.cleanedText;
            }
          } else if (/<(?:tool_call|function|call)/i.test(cleanedContent)) {
            // Strip any leaked tool tags from content
            cleanedContent = cleanedContent
              .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
              .replace(/<(?:function|call)[=:\s]+[\s\S]*?<\/(?:function|call)>/gi, '')
              .trim();
          }

          const generationMs = firstTokenTime > 0 ? (Date.now() - firstTokenTime) : durationMs;
          const tps = serverReportedTps > 0
            ? serverReportedTps
            : (usageTokens.completion > 0 && generationMs > 0
                ? usageTokens.completion / (generationMs / 1000)
                : 0);

          return {
            content: cleanedContent,
            tool_calls: finalToolCalls.length > 0 ? finalToolCalls : undefined,
            usage: {
              promptTokens: usageTokens.prompt,
              completionTokens: usageTokens.completion,
              totalTokens: usageTokens.total || usageTokens.prompt + usageTokens.completion,
              durationMs,
              tokensPerSecond: Math.round(tps * 10) / 10
            }
          };
        } else if (!streamResponse.ok) {
          const errText = await streamResponse.text();
          throw new Error(`llama-server API error (${streamResponse.status}): ${errText}`);
        }
      } catch (err: any) {
        if (err.message && err.message.includes('llama-server API error')) {
          throw err;
        }
        // Fall back to non-streaming if streaming fails
      }
    }

    // 2. Non-streaming fallback call
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages: formattedMessages,
        tools: formattedTools.length > 0 ? formattedTools : undefined,
        tool_choice: options?.toolChoice,
        temperature: 0.2,
        top_p: 0.85,
        min_p: 0.05,
        presence_penalty: 0.0,
        frequency_penalty: 0.0,
        repeat_penalty: 1.0,
        max_tokens: 4096
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
    let cleanedContent = content;

    if (toolCalls && Array.isArray(toolCalls) && toolCalls.length > 0) {
      toolCalls = toolCalls.map((tc: any) => ({
        ...tc,
        function: {
          ...tc.function,
          arguments: typeof tc.function.arguments === 'string'
            ? (() => { try { return JSON.parse(tc.function.arguments); } catch { return {}; } })()
            : tc.function.arguments
        }
      }));
      if (/<(?:tool_call|function|call)/i.test(cleanedContent)) {
        cleanedContent = cleanedContent
          .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
          .replace(/<(?:function|call)[=:\s]+[\s\S]*?<\/(?:function|call)>/gi, '')
          .trim();
      }
    } else {
      const extracted = extractToolCalls(content);
      if (extracted.hasToolCalls) {
        toolCalls = extracted.toolCalls;
        cleanedContent = extracted.cleanedText;
      }
    }

    const promptTokens = data.usage?.prompt_tokens || 0;
    const completionTokens = data.usage?.completion_tokens || 0;
    const totalTokens = data.usage?.total_tokens || promptTokens + completionTokens;
    const serverReportedTps = data.timings?.predicted_per_second || 0;
    const tps = serverReportedTps > 0
      ? serverReportedTps
      : (completionTokens > 0 && durationMs > 0 ? completionTokens / (durationMs / 1000) : 0);

    return {
      content: cleanedContent,
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
}
