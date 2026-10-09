import { ChatMessage, ToolDefinition } from '../types.js';
import { ILLMProvider, ChatProviderResponse } from './types.js';

export class OpenAICompatibleProvider implements ILLMProvider {
  private model: string;
  private apiBase: string;
  private apiKey: string;

  constructor(
    model: string = 'local-model',
    apiBase: string = 'http://localhost:1234/v1',
    apiKey: string = 'not-needed'
  ) {
    this.model = model;
    this.apiBase = apiBase.replace(/\/+$/, '');
    this.apiKey = apiKey;
  }

  setModel(model: string) {
    this.model = model;
  }

  getModel(): string {
    return this.model;
  }

  async isHealthy(): Promise<boolean> {
    try {
      const res = await fetch(`${this.apiBase}/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` }
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async getAvailableModels(): Promise<string[]> {
    try {
      const res = await fetch(`${this.apiBase}/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` }
      });
      if (!res.ok) return [];
      const data: any = await res.json();
      return (data.data || []).map((m: any) => m.id);
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

    const response = await fetch(`${this.apiBase}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: this.model,
        messages: formattedMessages,
        tools: formattedTools.length > 0 ? formattedTools : undefined,
        tool_choice: options?.toolChoice,
        temperature: 0.1,
        max_tokens: 4096
      })
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
    const toolCalls = message.tool_calls;

    const promptTokens = data.usage?.prompt_tokens || 0;
    const completionTokens = data.usage?.completion_tokens || 0;
    const totalTokens = data.usage?.total_tokens || promptTokens + completionTokens;
    const tps = completionTokens > 0 && durationMs > 0
      ? (completionTokens / (durationMs / 1000))
      : 0;

    return {
      content,
      tool_calls: toolCalls,
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
