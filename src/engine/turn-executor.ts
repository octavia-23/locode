import { ToolDefinition, AgentContext, ChatMessage } from '../types.js';
import { toolRegistry } from '../tools/index.js';
import { ToolDispatcher } from './tool-dispatcher.js';
import { DurableToolResult } from './types.js';
import { extractToolCalls } from '../utils/tool-parser.js';

export const READ_ONLY_TOOLS = new Set([
  'view_file',
  'dir_list',
  'dir_tree',
  'file_info',
  'search',
  'web_search',
  'web_fetch',
  'fetch_web',
  'search_web',
  'list_dir',
  'search_code',
  'batch_read_files',
  'find_by_name',
  'grep_search',
  'file_search'
]);

export function isReadOnlyTool(toolName: string): boolean {
  return READ_ONLY_TOOLS.has(toolName.toLowerCase().trim());
}

export interface ExecutedToolItem {
  callId: string;
  toolName: string;
  arguments: Record<string, any>;
  output: string;
  isError: boolean;
  durableResult?: DurableToolResult;
}

export interface ToolBatchExecutionResult {
  results: ExecutedToolItem[];
  executedInParallel: boolean;
  totalDurationMs: number;
}

export type GenerationOutcomeType =
  | 'TOOL_CALLS'
  | 'TEXT_FINAL'
  | 'EMPTY_RESPONSE'
  | 'MALFORMED_TOOL_CALL'
  | 'PROVIDER_ERROR_RETRYABLE'
  | 'PROVIDER_ERROR_FATAL';

export interface NormalizedGeneration {
  type: GenerationOutcomeType;
  rawContent: string;
  cleanedText: string;
  toolCalls?: Array<{
    id?: string;
    type?: string;
    function: {
      name: string;
      arguments: Record<string, any>;
    };
  }>;
  errorMessage?: string;
  stopReason?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    durationMs: number;
    tokensPerSecond: number;
  };
}

export class TurnExecutor {
  /**
   * Normalizes raw response or error from provider into structured outcome.
   */
  static normalizeResponse(response: any, error?: any): NormalizedGeneration {
    if (error) {
      const msg = error.message || String(error);
      const isRetryable =
        /ECONNRESET|ETIMEDOUT|ENOTFOUND|rate\s*limit|429|500|502|503|504|timeout|socket\s*hang\s*up/i.test(msg);
      return {
        type: isRetryable ? 'PROVIDER_ERROR_RETRYABLE' : 'PROVIDER_ERROR_FATAL',
        rawContent: '',
        cleanedText: '',
        errorMessage: msg
      };
    }

    if (!response) {
      return {
        type: 'EMPTY_RESPONSE',
        rawContent: '',
        cleanedText: ''
      };
    }

    const content = response.content || '';
    let toolCalls = response.tool_calls;

    // Standardize tool calls if present
    let formattedToolCalls: Array<{
      id?: string;
      type?: string;
      function: { name: string; arguments: Record<string, any> };
      thoughtSignature?: string;
      thought_signature?: string;
    }> | undefined;

    if (toolCalls && Array.isArray(toolCalls) && toolCalls.length > 0) {
      formattedToolCalls = toolCalls.map((tc: any, idx: number) => {
        let args = tc.function?.arguments;
        if (typeof args === 'string') {
          try {
            args = JSON.parse(args);
          } catch {
            args = {};
          }
        }
        return {
          id: tc.id || `call_${Date.now()}_${idx}`,
          type: 'function',
          function: {
            name: tc.function?.name || tc.name || '',
            arguments: args || tc.arguments || {}
          },
          ...(tc.thoughtSignature ? { thoughtSignature: tc.thoughtSignature } : {}),
          ...(tc.thought_signature ? { thought_signature: tc.thought_signature } : {})
        };
      });
    }

    // Clean text and check for fallback tool call extraction
    let cleanedText = content.trim();

    if (!formattedToolCalls || formattedToolCalls.length === 0) {
      // Qwen 35B A3B / MoE Tool Call Rescue:
      // Rescue tool calls that were serialized as XML, Python calls, or JSON into message content
      const extracted = extractToolCalls(content);
      if (extracted.hasToolCalls) {
        formattedToolCalls = extracted.toolCalls;
        cleanedText = extracted.cleanedText;
      }
    } else {
      // Native tool calls present: strip any leaked XML / JSON tags from cleanedText
      cleanedText = cleanedText
        .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
        .replace(/<(?:function|call)[=:\s]+[\s\S]*?<\/(?:function|call)>/gi, '')
        .replace(/```(?:tool_call|json)?\s*\{\s*"name"\s*:\s*"[^"]+".*?\}\s*```/gis, '')
        .trim();
    }

    if (formattedToolCalls && formattedToolCalls.length > 0) {
      return {
        type: 'TOOL_CALLS',
        rawContent: content,
        cleanedText,
        toolCalls: formattedToolCalls,
        stopReason: response.stopReason,
        usage: response.usage
      };
    }

    if (!cleanedText && !content.trim()) {
      return {
        type: 'EMPTY_RESPONSE',
        rawContent: '',
        cleanedText: '',
        stopReason: response.stopReason,
        usage: response.usage
      };
    }

    return {
      type: 'TEXT_FINAL',
      rawContent: content,
      cleanedText,
      stopReason: response.stopReason,
      usage: response.usage
    };
  }

  /**
   * Executes a batch of tool calls with safe concurrency:
   * - If all tools are read-only and parallel tools are enabled, executes concurrently via Promise.all.
   * - Otherwise, executes sequentially in declaration order.
   * Preserves deterministic output ordering in results.
   */
  static async executeToolBatch(
    toolCalls: Array<{ id?: string; function: { name: string; arguments: Record<string, any> } }>,
    dispatcher: ToolDispatcher,
    context: AgentContext,
    options: {
      allowParallelTools?: boolean;
      autoApprove?: boolean;
      allowNetwork?: boolean;
      signal?: AbortSignal;
      onBeforeExecute?: (toolName: string, callId: string) => void;
      onAfterExecute?: (result: ExecutedToolItem) => void;
    }
  ): Promise<ToolBatchExecutionResult> {
    const startTime = Date.now();
    const canRunParallel =
      Boolean(options.allowParallelTools) &&
      toolCalls.length > 1 &&
      toolCalls.every(c => isReadOnlyTool(c.function.name));

    if (canRunParallel) {
      // Execute concurrently, keeping track of original indices to preserve deterministic ordering
      const promises = toolCalls.map(async (call, index) => {
        const callId = call.id || `call_${Date.now()}_${index}`;
        if (options.onBeforeExecute) {
          options.onBeforeExecute(call.function.name, callId);
        }

        const tool = toolRegistry.get(call.function.name);
        if (!tool) {
          const item: ExecutedToolItem = {
            callId,
            toolName: call.function.name,
            arguments: call.function.arguments || {},
            output: `Tool "${call.function.name}" is not registered.`,
            isError: true
          };
          if (options.onAfterExecute) options.onAfterExecute(item);
          return { item, index };
        }

        const durableResult = await dispatcher.dispatch(
          tool,
          call.function.arguments || {},
          context,
          callId,
          {
            autoApprove: options.autoApprove ?? context.autoApprove,
            allowNetwork: options.allowNetwork,
            signal: options.signal
          }
        );

        const item: ExecutedToolItem = {
          callId,
          toolName: call.function.name,
          arguments: call.function.arguments || {},
          output: durableResult.output,
          isError: durableResult.isError,
          durableResult
        };

        if (options.onAfterExecute) options.onAfterExecute(item);
        return { item, index };
      });

      const settled = await Promise.all(promises);
      settled.sort((a, b) => a.index - b.index);
      return {
        results: settled.map(s => s.item),
        executedInParallel: true,
        totalDurationMs: Date.now() - startTime
      };
    }

    // Sequential execution
    const results: ExecutedToolItem[] = [];
    for (let i = 0; i < toolCalls.length; i++) {
      const call = toolCalls[i];
      const callId = call.id || `call_${Date.now()}_${i}`;

      if (options.signal?.aborted) {
        results.push({
          callId,
          toolName: call.function.name,
          arguments: call.function.arguments || {},
          output: 'Execution was cancelled.',
          isError: true
        });
        break;
      }

      if (options.onBeforeExecute) {
        options.onBeforeExecute(call.function.name, callId);
      }

      const tool = toolRegistry.get(call.function.name);
      if (!tool) {
        const item: ExecutedToolItem = {
          callId,
          toolName: call.function.name,
          arguments: call.function.arguments || {},
          output: `Tool "${call.function.name}" is not registered.`,
          isError: true
        };
        results.push(item);
        if (options.onAfterExecute) options.onAfterExecute(item);
        continue;
      }

      const durableResult = await dispatcher.dispatch(
        tool,
        call.function.arguments || {},
        context,
        callId,
        {
          autoApprove: options.autoApprove ?? context.autoApprove,
          allowNetwork: options.allowNetwork,
          signal: options.signal
        }
      );

      const item: ExecutedToolItem = {
        callId,
        toolName: call.function.name,
        arguments: call.function.arguments || {},
        output: durableResult.output,
        isError: durableResult.isError,
        durableResult
      };

      results.push(item);
      if (options.onAfterExecute) options.onAfterExecute(item);
    }

    return {
      results,
      executedInParallel: false,
      totalDurationMs: Date.now() - startTime
    };
  }
}
