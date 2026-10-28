import { ChatMessage, ToolDefinition } from '../types.js';
import { ILLMProvider, ChatProviderResponse, ChatOptions, ModelCapabilities } from './types.js';
import { redactSecrets, redactSecretsFromMessages } from '../utils/secret-redactor.js';

export class OpenAICompatibleProvider implements ILLMProvider {
  private model: string;
  private apiBase: string;
  private apiKey: string;
  private numCtx: number;
  private extraHeaders: Record<string, string>;

  constructor(
    model: string = 'local-model',
    apiBase: string = 'http://localhost:1234/v1',
    apiKey: string = 'not-needed',
    numCtx: number = 128000,
    extraHeaders: Record<string, string> = {}
  ) {
    this.model = model;
    this.apiBase = apiBase.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.numCtx = numCtx;
    this.extraHeaders = extraHeaders;
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

  getModelLimits(): { maxOutputTokens?: number } {
    return { maxOutputTokens: 8192 };
  }

  getCapabilities(): ModelCapabilities {
    const isLocal = this.isLocal();
    return {
      supportsToolCalling: true,
      supportsStreaming: true,
      supportsStructuredOutput: !isLocal,
      supportsThinking: this.model.includes('r1') || this.model.includes('o1') || this.model.includes('o3') || this.model.includes('thinking'),
      supportsUsageReporting: true,
      maxContextTokens: this.numCtx,
      maxOutputTokens: isLocal ? 4096 : 8192,
      defaultOutputTokens: isLocal ? 4096 : 8192
    };
  }

  private isLocal(): boolean {
    return this.apiBase.includes('localhost') || this.apiBase.includes('127.0.0.1') || this.apiBase.includes('0.0.0.0');
  }

  async isHealthy(): Promise<boolean> {
    try {
      const headers: Record<string, string> = { ...this.extraHeaders };
      if (this.apiKey && this.apiKey !== 'not-needed') {
        headers['Authorization'] = `Bearer ${this.apiKey}`;
      }
      const res = await fetch(`${this.apiBase}/models`, {
        headers,
        signal: AbortSignal.timeout(4000)
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async getAvailableModels(): Promise<string[]> {
    try {
      const headers: Record<string, string> = { ...this.extraHeaders };
      if (this.apiKey && this.apiKey !== 'not-needed') {
        headers['Authorization'] = `Bearer ${this.apiKey}`;
      }
      const res = await fetch(`${this.apiBase}/models`, {
        headers,
        signal: AbortSignal.timeout(4000)
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
    options?: ChatOptions
  ): Promise<ChatProviderResponse> {
    const formattedTools = tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters
      }
    }));

    const sanitizedInputMessages = redactSecretsFromMessages(messages);
    const formattedMessages = sanitizedInputMessages.map(m => {
      const msg: any = { role: m.role, content: m.content };
      if (m.tool_calls) msg.tool_calls = m.tool_calls;
      if (m.name) msg.name = m.name;
      if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
      return msg;
    });

    const startTime = Date.now();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.extraHeaders
    };

    if (this.apiKey && this.apiKey !== 'not-needed') {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    // Auto-detect OpenRouter and inject required client attribution headers
    if (this.apiBase.includes('openrouter.ai')) {
      if (!headers['HTTP-Referer']) headers['HTTP-Referer'] = 'https://github.com/locode/locode';
      if (!headers['X-Title']) headers['X-Title'] = 'Locode';
    }

    const payload: any = {
      model: this.model,
      messages: formattedMessages,
      tools: formattedTools.length > 0 ? formattedTools : undefined,
      tool_choice: options?.toolChoice,
      temperature: options?.temperature ?? 0.2,
      max_tokens: options?.maxTokens || (this.isLocal() ? 4096 : 8192)
    };

    const requestTimeout = options?.timeoutMs || 120000;
    const fetchSignal = options?.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(requestTimeout)])
      : AbortSignal.timeout(requestTimeout);

    // 1. Streaming execution
    if (onToken) {
      payload.stream = true;
      payload.stream_options = { include_usage: true };

      const response = await fetch(`${this.apiBase}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: fetchSignal
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`OpenAI API error (${response.status}): ${errText}`);
      }

      if (response.body) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let fullContent = '';
        const toolAccumulator: Map<number, { id?: string; name: string; arguments: string }> = new Map();
        let stopReason: string | undefined;
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
            if (!trimmed.startsWith('data:')) continue;
            if (trimmed === 'data: [DONE]') continue;

            const jsonStr = trimmed.slice(5).trim();
            if (!jsonStr) continue;

            try {
              const json = JSON.parse(jsonStr);

              if (json.usage) {
                usageTokens.prompt = json.usage.prompt_tokens || usageTokens.prompt;
                usageTokens.completion = json.usage.completion_tokens || usageTokens.completion;
                usageTokens.total = json.usage.total_tokens || usageTokens.total;
              }

              const choice = json.choices?.[0];
              if (!choice) continue;

              if (choice.finish_reason) {
                stopReason = choice.finish_reason;
              }

              const delta = choice.delta;
              if (delta?.content) {
                fullContent += delta.content;
                onToken(delta.content);
              }

              if (delta?.tool_calls) {
                for (const tc of delta.tool_calls) {
                  const idx = tc.index ?? 0;
                  const existing = toolAccumulator.get(idx) || { id: tc.id, name: '', arguments: '' };
                  if (tc.id) existing.id = tc.id;
                  if (tc.function?.name) existing.name += tc.function.name;
                  if (tc.function?.arguments) existing.arguments += tc.function.arguments;
                  toolAccumulator.set(idx, existing);
                }
              }
            } catch {
              // Ignore partial chunk parse error
            }
          }
        }

        const durationMs = Date.now() - startTime;
        const promptTokens = usageTokens.prompt;
        const completionTokens = usageTokens.completion;
        const totalTokens = usageTokens.total || promptTokens + completionTokens;
        const tps = completionTokens > 0 && durationMs > 0
          ? completionTokens / (durationMs / 1000)
          : 0;

        const toolCalls: Array<{ id?: string; type: string; function: { name: string; arguments: any } }> = [];
        for (const [, item] of toolAccumulator) {
          let parsedArgs = {};
          try {
            parsedArgs = JSON.parse(item.arguments);
          } catch {
            parsedArgs = {};
          }
          toolCalls.push({
            id: item.id,
            type: 'function',
            function: {
              name: item.name,
              arguments: parsedArgs
            }
          });
        }

        return {
          content: fullContent,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
          stopReason,
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

    // 2. Non-streaming execution
    const response = await fetch(`${this.apiBase}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: fetchSignal
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`OpenAI API error (${response.status}): ${errText}`);
    }

    const data: any = await response.json();
    const durationMs = Date.now() - startTime;

    const choice = data.choices?.[0];
    const message = choice?.message || {};
    const content = message.content || '';
    const rawToolCalls = message.tool_calls;
    const stopReason = choice?.finish_reason;

    let parsedToolCalls: any = undefined;
    if (Array.isArray(rawToolCalls)) {
      parsedToolCalls = rawToolCalls.map((tc: any) => {
        let args = tc.function?.arguments;
        if (typeof args === 'string') {
          try {
            args = JSON.parse(args);
          } catch {
            args = {};
          }
        }
        return {
          id: tc.id,
          type: 'function',
          function: {
            name: tc.function?.name || '',
            arguments: args || {}
          }
        };
      });
    }

    const promptTokens = data.usage?.prompt_tokens || 0;
    const completionTokens = data.usage?.completion_tokens || 0;
    const totalTokens = data.usage?.total_tokens || promptTokens + completionTokens;
    const tps = completionTokens > 0 && durationMs > 0
      ? completionTokens / (durationMs / 1000)
      : 0;

    return {
      content,
      tool_calls: parsedToolCalls,
      stopReason,
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
