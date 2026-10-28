import { ChatMessage, ToolDefinition } from '../types.js';
import { ILLMProvider, ChatProviderResponse, ChatOptions, ModelCapabilities } from './types.js';
import { redactSecrets, redactValue } from '../utils/secret-redactor.js';

export interface GeminiPart {
  text?: string;
  thoughtSignature?: string;
  thought_signature?: string;
  functionCall?: {
    name: string;
    args: Record<string, any>;
  };
  functionResponse?: {
    name: string;
    response: Record<string, any>;
  };
}

export interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

const GEMINI_FALLBACK_CANDIDATES: Record<string, string[]> = {
  'gemini-3.8-flash': ['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3-flash-preview'],
  'gemini-3.7-flash': ['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3-flash-preview'],
  'gemini-3.6-flash': ['gemini-3.5-flash', 'gemini-3-flash-preview'],
  'gemini-3.5-flash': ['gemini-3.6-flash', 'gemini-3-flash-preview'],
  'gemini-3.1-pro-preview': ['gemini-3.6-flash', 'gemini-3.5-flash']
};

function normalizeGeminiModel(model: string): string {
  const clean = model.replace(/^models\//, '');
  if (clean === 'gemini-2.0-flash' || clean === 'gemini-1.5-flash' || clean === 'gemini-flash') {
    return 'gemini-3.6-flash';
  }
  return clean;
}

export class GeminiProvider implements ILLMProvider {
  private model: string;
  private apiKey: string;
  private apiBase: string;
  private numCtx: number;

  constructor(
    model: string = 'gemini-3.6-flash',
    apiKey?: string,
    apiBase: string = 'https://generativelanguage.googleapis.com',
    numCtx: number = 1048576
  ) {
    this.model = normalizeGeminiModel(model);
    this.apiKey = apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
    this.apiBase = apiBase.replace(/\/+$/, '');
    this.numCtx = numCtx;
  }

  setModel(model: string): void {
    this.model = normalizeGeminiModel(model);
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
      supportsThinking: this.model.includes('3.8') || this.model.includes('thinking'),
      supportsUsageReporting: true,
      maxContextTokens: this.numCtx,
      maxOutputTokens: 8192,
      defaultOutputTokens: 8192
    };
  }

  async isHealthy(): Promise<boolean> {
    if (!this.apiKey) return false;
    try {
      const url = `${this.apiBase}/v1beta/models?key=${this.apiKey}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async getAvailableModels(): Promise<string[]> {
    if (!this.apiKey) return [this.model];
    try {
      const url = `${this.apiBase}/v1beta/models?key=${this.apiKey}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) return [this.model];
      const data: any = await res.json();
      const models = (data.models || [])
        .map((m: any) => m.name.replace(/^models\//, ''))
        .filter((name: string) => name.toLowerCase().includes('gemini'));
      return models.length > 0 ? models : [this.model];
    } catch {
      return [this.model];
    }
  }

  private async executeGeminiRequest(
    requestBody: any,
    stream: boolean,
    callerSignal?: AbortSignal,
    timeoutMs?: number
  ): Promise<{ response: Response; activeModel: string }> {
    const modelsToTry = [
      this.model,
      ...(GEMINI_FALLBACK_CANDIDATES[this.model] || ['gemini-3.6-flash', 'gemini-3.5-flash'])
    ];
    const uniqueModels = [...new Set(modelsToTry)];

    let lastError: Error | null = null;
    const effectiveTimeoutMs = timeoutMs || (stream ? 300000 : 120000);
    const timeoutSignal = AbortSignal.timeout(effectiveTimeoutMs);
    const combinedSignal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;

    for (let i = 0; i < uniqueModels.length; i++) {
      const candidateModel = uniqueModels[i];
      const endpoint = stream
        ? `${this.apiBase}/v1beta/models/${candidateModel}:streamGenerateContent?key=${this.apiKey}&alt=sse`
        : `${this.apiBase}/v1beta/models/${candidateModel}:generateContent?key=${this.apiKey}`;

      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
          signal: combinedSignal
        });

        if (response.status === 503) {
          const errText = await response.text();
          if (i + 1 < uniqueModels.length) {
            console.log(`\n  ! [${candidateModel}] high demand (503). Auto-switching to fallback ${uniqueModels[i + 1]}...`);
            this.model = uniqueModels[i + 1];
            continue;
          } else {
            throw new Error(`Gemini API error (503): ${errText}`);
          }
        }

        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`Gemini API error (${response.status}): ${errText}`);
        }

        this.model = candidateModel;
        return { response, activeModel: candidateModel };
      } catch (err: any) {
        lastError = err;
        if (callerSignal?.aborted || err.name === 'AbortError') {
          throw err;
        }
        if (i + 1 < uniqueModels.length) {
          console.log(`\n  ! [${candidateModel}] connection issue (${err.message}). Trying fallback ${uniqueModels[i + 1]}...`);
          this.model = uniqueModels[i + 1];
          continue;
        }
      }
    }

    throw lastError || new Error('Failed to connect to Gemini API after trying candidate models');
  }

  async chat(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    onToken?: (token: string) => void,
    options?: ChatOptions
  ): Promise<ChatProviderResponse> {
    if (!this.apiKey) {
      throw new Error(
        'Gemini API key is required. Set GEMINI_API_KEY or GOOGLE_API_KEY in your environment, or pass --api-key.'
      );
    }

    const startTime = Date.now();

    // 1. Separate system prompt and build contents
    let systemText = '';
    const systemParts: string[] = [];
    const contents: GeminiContent[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        if (msg.content) systemParts.push(redactSecrets(msg.content));
        continue;
      }

      if (msg.role === 'user') {
        const parts: GeminiPart[] = [{ text: redactSecrets(msg.content || '') }];
        // Merge with previous turn if it was also 'user' to maintain strict alternating invariant
        const lastContent = contents[contents.length - 1];
        if (lastContent && lastContent.role === 'user') {
          lastContent.parts.push(...parts);
        } else {
          contents.push({ role: 'user', parts });
        }
      } else if (msg.role === 'assistant') {
        const parts: GeminiPart[] = [];
        if (msg.content) {
          parts.push({ text: redactSecrets(msg.content) });
        }
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          for (const tc of msg.tool_calls) {
            let args: Record<string, any> = {};
            if (typeof tc.function.arguments === 'string') {
              try {
                args = JSON.parse(tc.function.arguments);
              } catch {
                args = {};
              }
            } else if (typeof tc.function.arguments === 'object' && tc.function.arguments !== null) {
              args = tc.function.arguments;
            }
            const signature = (tc as any).thoughtSignature || (tc as any).thought_signature || 'skip_thought_signature_validator';
            parts.push({
              functionCall: {
                name: tc.function.name,
                args: redactValue(args)
              },
              thoughtSignature: signature
            });
          }
        }
        if (parts.length === 0) {
          parts.push({ text: '' });
        }

        const lastContent = contents[contents.length - 1];
        if (lastContent && lastContent.role === 'model') {
          lastContent.parts.push(...parts);
        } else {
          contents.push({ role: 'model', parts });
        }
      } else if (msg.role === 'tool') {
        // Tool results in Gemini are functionResponse parts on a user turn
        let parsed: any;
        const cleanContent = redactSecrets(msg.content || '');
        try {
          parsed = JSON.parse(cleanContent);
        } catch {
          parsed = { result: cleanContent };
        }
        if (typeof parsed !== 'object' || parsed === null) {
          parsed = { result: parsed };
        }

        const part: GeminiPart = {
          functionResponse: {
            name: msg.name || 'tool',
            response: parsed
          }
        };

        const lastContent = contents[contents.length - 1];
        if (lastContent && lastContent.role === 'user') {
          lastContent.parts.push(part);
        } else {
          contents.push({ role: 'user', parts: [part] });
        }
      }
    }

    if (systemParts.length > 0) {
      systemText = systemParts.join('\n\n');
    }

    // 2. Format tool definitions
    const functionDeclarations = tools.map(t => ({
      name: t.name,
      description: t.description,
      parameters: {
        type: 'OBJECT',
        properties: t.parameters.properties || {},
        required: t.parameters.required || []
      }
    }));

    const requestBody: any = {
      contents,
      generationConfig: {
        temperature: options?.temperature ?? 0.2,
        maxOutputTokens: options?.maxTokens || 8192
      }
    };

    if (systemText) {
      requestBody.systemInstruction = {
        parts: [{ text: systemText }]
      };
    }

    if (functionDeclarations.length > 0) {
      requestBody.tools = [{ functionDeclarations }];
      if (options?.toolChoice === 'none') {
        requestBody.toolConfig = { functionCallingConfig: { mode: 'NONE' } };
      } else if (options?.toolChoice === 'required') {
        requestBody.toolConfig = { functionCallingConfig: { mode: 'ANY' } };
      } else if (options?.toolChoice === 'auto') {
        requestBody.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
      }
    }

    // 3. Execute with resilience & automatic 503 fallback
    if (onToken) {
      const { response } = await this.executeGeminiRequest(requestBody, true, options?.signal, options?.timeoutMs);

      if (response.body) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let fullContent = '';
        const toolCalls: Array<{ id?: string; type: string; function: { name: string; arguments: any } }> = [];
        let stopReason: string | undefined;
        let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

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
              const chunk = JSON.parse(jsonStr);
              if (chunk.usageMetadata) {
                usage.promptTokens = chunk.usageMetadata.promptTokenCount || usage.promptTokens;
                usage.completionTokens = chunk.usageMetadata.candidatesTokenCount || usage.completionTokens;
                usage.totalTokens = chunk.usageMetadata.totalTokenCount || usage.totalTokens;
              }

              const candidate = chunk.candidates?.[0];
              if (candidate?.finishReason) {
                stopReason = candidate.finishReason;
              }

              const parts = candidate?.content?.parts || [];
              for (const p of parts) {
                if (p.text) {
                  fullContent += p.text;
                  onToken(p.text);
                }
                if (p.functionCall) {
                  const signature = p.thoughtSignature || p.thought_signature;
                  toolCalls.push({
                    type: 'function',
                    function: {
                      name: p.functionCall.name,
                      arguments: p.functionCall.args || {}
                    },
                    ...(signature ? { thoughtSignature: signature } : {})
                  } as any);
                }
              }
            } catch {
              // Ignore partial chunk parse error
            }
          }
        }

        const durationMs = Date.now() - startTime;
        const tps = usage.completionTokens > 0 && durationMs > 0
          ? usage.completionTokens / (durationMs / 1000)
          : 0;

        return {
          content: fullContent,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
          stopReason,
          usage: {
            ...usage,
            durationMs,
            tokensPerSecond: Math.round(tps * 10) / 10
          }
        };
      }
    }

    // 4. Non-streaming call with automatic fallback
    const { response } = await this.executeGeminiRequest(requestBody, false, options?.signal, options?.timeoutMs);
    const data: any = await response.json();
    const durationMs = Date.now() - startTime;

    const candidate = data.candidates?.[0];
    const parts = candidate?.content?.parts || [];

    let fullContent = '';
    const toolCalls: Array<{ id?: string; type: string; function: { name: string; arguments: any } }> = [];

    for (const p of parts) {
      if (p.text) {
        fullContent += p.text;
        if (onToken) onToken(p.text);
      }
      if (p.functionCall) {
        const signature = p.thoughtSignature || p.thought_signature;
        toolCalls.push({
          type: 'function',
          function: {
            name: p.functionCall.name,
            arguments: p.functionCall.args || {}
          },
          ...(signature ? { thoughtSignature: signature } : {})
        } as any);
      }
    }

    const promptTokens = data.usageMetadata?.promptTokenCount || 0;
    const completionTokens = data.usageMetadata?.candidatesTokenCount || 0;
    const totalTokens = data.usageMetadata?.totalTokenCount || promptTokens + completionTokens;
    const tps = completionTokens > 0 && durationMs > 0
      ? completionTokens / (durationMs / 1000)
      : 0;

    return {
      content: fullContent,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      stopReason: candidate?.finishReason,
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
