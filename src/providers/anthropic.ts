import { ChatMessage, ToolDefinition } from '../types.js';
import { ILLMProvider, ChatProviderResponse, ChatOptions, ModelCapabilities } from './types.js';
import { redactSecrets } from '../utils/secret-redactor.js';

export class AnthropicProvider implements ILLMProvider {
  private model: string;
  private apiKey: string;
  private apiBase: string;
  private numCtx: number;

  constructor(
    model: string = 'claude-3-5-sonnet-20241022',
    apiKey?: string,
    apiBase: string = 'https://api.anthropic.com',
    numCtx: number = 200000
  ) {
    this.model = model;
    this.apiKey = apiKey || process.env.ANTHROPIC_API_KEY || '';
    this.apiBase = apiBase.replace(/\/+$/, '');
    this.numCtx = numCtx;
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
  }

  getModelLimits(): { maxOutputTokens?: number } {
    return { maxOutputTokens: 8192 };
  }

  getCapabilities(): ModelCapabilities {
    return {
      supportsToolCalling: true,
      supportsStreaming: true,
      supportsStructuredOutput: true,
      supportsThinking: this.model.includes('sonnet') || this.model.includes('opus') || this.model.includes('3-7'),
      supportsUsageReporting: true,
      maxContextTokens: this.numCtx,
      maxOutputTokens: 8192,
      defaultOutputTokens: 8192
    };
  }

  async isHealthy(): Promise<boolean> {
    return Boolean(this.apiKey && this.apiKey.length > 5);
  }

  async getAvailableModels(): Promise<string[]> {
    return [
      'claude-3-5-sonnet-20241022',
      'claude-3-5-haiku-20241022',
      'claude-3-opus-20240229'
    ];
  }

  async chat(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    onToken?: (token: string) => void,
    options?: ChatOptions
  ): Promise<ChatProviderResponse> {
    if (!this.apiKey) {
      throw new Error(
        'Anthropic API key is required. Set ANTHROPIC_API_KEY in your environment, or pass --api-key.'
      );
    }

    const startTime = Date.now();

    // 1. Separate system prompt and build alternating messages
    const systemParts: string[] = [];
    const anthropicMessages: any[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        if (msg.content) systemParts.push(redactSecrets(msg.content));
        continue;
      }

      if (msg.role === 'user') {
        const userContent = redactSecrets(msg.content || '');
        const prev = anthropicMessages[anthropicMessages.length - 1];
        if (prev && prev.role === 'user') {
          // Merge consecutive user turns
          if (typeof prev.content === 'string') {
            prev.content = `${prev.content}\n\n${userContent}`;
          } else if (Array.isArray(prev.content)) {
            prev.content.push({ type: 'text', text: userContent });
          }
        } else {
          anthropicMessages.push({
            role: 'user',
            content: userContent
          });
        }
      } else if (msg.role === 'assistant') {
        const contentParts: any[] = [];
        if (msg.content) {
          contentParts.push({ type: 'text', text: redactSecrets(msg.content) });
        }
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          for (let i = 0; i < msg.tool_calls.length; i++) {
            const tc = msg.tool_calls[i];
            let inputArgs = tc.function.arguments;
            if (typeof inputArgs === 'string') {
              try {
                inputArgs = JSON.parse(inputArgs);
              } catch {
                inputArgs = {};
              }
            }
            const toolId = tc.id || `call_${i}_${Date.now()}`;
            tc.id = toolId;
            contentParts.push({
              type: 'tool_use',
              id: toolId,
              name: tc.function.name,
              input: inputArgs || {}
            });
          }
        }

        if (contentParts.length === 0) {
          contentParts.push({ type: 'text', text: '' });
        }

        const prev = anthropicMessages[anthropicMessages.length - 1];
        if (prev && prev.role === 'assistant') {
          if (Array.isArray(prev.content)) {
            prev.content.push(...contentParts);
          } else {
            prev.content = [{ type: 'text', text: prev.content }, ...contentParts];
          }
        } else {
          anthropicMessages.push({
            role: 'assistant',
            content: contentParts
          });
        }
      } else if (msg.role === 'tool') {
        const toolResultBlock = {
          type: 'tool_result',
          tool_use_id: msg.tool_call_id || 'unknown',
          content: redactSecrets(msg.content || '')
        };

        const prev = anthropicMessages[anthropicMessages.length - 1];
        if (prev && prev.role === 'user') {
          if (Array.isArray(prev.content)) {
            prev.content.push(toolResultBlock);
          } else {
            prev.content = [
              { type: 'text', text: String(prev.content) },
              toolResultBlock
            ];
          }
        } else {
          anthropicMessages.push({
            role: 'user',
            content: [toolResultBlock]
          });
        }
      }
    }

    // 2. Format tool definitions
    const formattedTools = tools.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: {
        type: 'object',
        properties: t.parameters.properties || {},
        required: t.parameters.required || []
      }
    }));

    let toolChoice: any = undefined;
    if (formattedTools.length > 0) {
      if (options?.toolChoice === 'required') {
        toolChoice = { type: 'any' };
      } else if (options?.toolChoice === 'auto') {
        toolChoice = { type: 'auto' };
      }
      // If 'none', we omit tools entirely from request
    }

    const payload: any = {
      model: this.model,
      messages: anthropicMessages,
      max_tokens: options?.maxTokens || 8192,
      temperature: options?.temperature ?? 0.2
    };

    if (systemParts.length > 0) {
      payload.system = [
        {
          type: 'text',
          text: systemParts.join('\n\n'),
          cache_control: { type: 'ephemeral' }
        }
      ];
    }

    if (options?.toolChoice !== 'none' && formattedTools.length > 0) {
      (formattedTools[formattedTools.length - 1] as any).cache_control = { type: 'ephemeral' };
      payload.tools = formattedTools;
      if (toolChoice) payload.tool_choice = toolChoice;
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'prompt-caching-2024-07-31'
    };

    const requestTimeout = options?.timeoutMs || 120000;
    const fetchSignal = options?.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(requestTimeout)])
      : AbortSignal.timeout(requestTimeout);

    // 3. Streaming execution
    if (onToken) {
      payload.stream = true;
      const response = await fetch(`${this.apiBase}/v1/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: fetchSignal
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Anthropic API error (${response.status}): ${errorText}`);
      }

      if (response.body) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let fullContent = '';
        const toolAccumulator: Map<number, { id: string; name: string; json: string }> = new Map();
        let stopReason: string | undefined;
        let promptTokens = 0;
        let completionTokens = 0;

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

            const jsonStr = trimmed.slice(5).trim();
            if (!jsonStr) continue;

            try {
              const event = JSON.parse(jsonStr);

              if (event.type === 'message_start' && event.message?.usage) {
                promptTokens =
                  (event.message.usage.input_tokens || 0) +
                  (event.message.usage.cache_read_input_tokens || 0) +
                  (event.message.usage.cache_creation_input_tokens || 0);
              } else if (event.type === 'content_block_start') {
                const block = event.content_block;
                if (block?.type === 'tool_use') {
                  toolAccumulator.set(event.index, {
                    id: block.id,
                    name: block.name,
                    json: ''
                  });
                }
              } else if (event.type === 'content_block_delta') {
                const delta = event.delta;
                if (delta?.type === 'text_delta') {
                  fullContent += delta.text;
                  onToken(delta.text);
                } else if (delta?.type === 'input_json_delta') {
                  const entry = toolAccumulator.get(event.index);
                  if (entry) {
                    entry.json += delta.partial_json;
                  }
                }
              } else if (event.type === 'message_delta') {
                if (event.delta?.stop_reason) {
                  stopReason = event.delta.stop_reason;
                }
                if (event.usage?.output_tokens) {
                  completionTokens = event.usage.output_tokens;
                }
              }
            } catch {
              // Ignore partial parse error
            }
          }
        }

        const durationMs = Date.now() - startTime;
        const totalTokens = promptTokens + completionTokens;
        const tps = completionTokens > 0 && durationMs > 0
          ? completionTokens / (durationMs / 1000)
          : 0;

        const toolCalls: Array<{ id?: string; type: string; function: { name: string; arguments: any } }> = [];
        for (const [, item] of toolAccumulator) {
          let parsedArgs: any = {};
          try {
            parsedArgs = JSON.parse(item.json);
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

    // 4. Non-streaming execution
    const response = await fetch(`${this.apiBase}/v1/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: fetchSignal
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Anthropic API error (${response.status}): ${errorText}`);
    }

    const data: any = await response.json();
    const durationMs = Date.now() - startTime;

    let fullContent = '';
    const toolCalls: Array<{ id?: string; type: string; function: { name: string; arguments: any } }> = [];

    for (const block of data.content || []) {
      if (block.type === 'text') {
        fullContent += block.text;
        if (onToken) onToken(block.text);
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: block.input || {}
          }
        });
      }
    }

    const promptTokens =
      (data.usage?.input_tokens || 0) +
      (data.usage?.cache_read_input_tokens || 0) +
      (data.usage?.cache_creation_input_tokens || 0);
    const completionTokens = data.usage?.output_tokens || 0;
    const totalTokens = promptTokens + completionTokens;
    const tps = completionTokens > 0 && durationMs > 0
      ? completionTokens / (durationMs / 1000)
      : 0;

    return {
      content: fullContent,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      stopReason: data.stop_reason,
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
