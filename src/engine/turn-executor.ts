import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { ToolDefinition, AgentContext, ChatMessage } from '../types.js';
import { toolRegistry } from '../tools/index.js';
import { ToolDispatcher } from './tool-dispatcher.js';
import { DurableToolResult } from './types.js';
import { extractToolCalls } from '../utils/tool-parser.js';
import { PermissionEngine } from './permission-engine.js';
import { ExecutionJournal } from '../journal/journal.js';
import { TerminalRenderer } from '../ui/renderer.js';
import { CheckpointManager } from '../git/checkpoint.js';
import { StagnationDetector } from '../agent/stagnation.js';
import { RecoveryController } from './recovery-controller.js';
import { CodeVerifier } from '../agent/verifier.js';
import { ContextEngine } from '../agent/context.js';
import { theme } from '../ui/theme.js';
import { HarnessExecutionProfile } from '../runtime/profiles.js';

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

export interface TurnBatchProgressTracker {
  recentToolSignatures: string[];
  recentFailureSignatures: string[];
  filesModified: Set<string>;
  fileReadTurns: Map<string, number>;
  fileEditCounts: Map<string, number>;
  fileContentHashes: Map<string, string[]>;
  fastLintFailuresPerFile: Map<string, number>;
  consecutiveCycleDetections: number;
  consecutiveToolFailures: number;
  successfulToolCount: number;
  failedToolCount: number;
  consecutiveNoProgressCount: number;
  consecutiveEmptyResponses: number;
  actionNudgeGiven?: boolean;
  singleFileObsession?: boolean;
  obsessedFilePath?: string;
}

export interface TurnBatchExecutionOptions {
  profile?: HarnessExecutionProfile;
  progress?: TurnBatchProgressTracker;
  stepCount?: number;
  userInput?: string;
  hasModifiedCode?: boolean;
  readStepCount?: number;
  safetyCeiling?: number;
  signal?: AbortSignal;
  usage?: NormalizedGeneration['usage'];
  stopReason?: string;
  allowParallelTools?: boolean;
  autoApprove?: boolean;
  allowNetwork?: boolean;
  dispatcher?: ToolDispatcher;
  renderer?: TerminalRenderer;
  checkpointManager?: CheckpointManager;
  stagnationDetector?: StagnationDetector;
  recoveryController?: RecoveryController;
  contextEngine?: ContextEngine;
  onPreEdit?: (filePath: string) => Promise<void>;
  onFastLint?: (filePath: string) => Promise<{ passed: boolean; command?: string; errorOutput?: string }>;
  onOscillationCheck?: (filePath: string, content: string) => Promise<boolean>;
}

export interface TurnBatchExecutionOutcome {
  toolMessages: ChatMessage[];
  results: ExecutedToolItem[];
  shouldTerminateTurn: boolean;
  hasModifiedCode: boolean;
  readStepCount: number;
  safetyCeiling: number;
  successfulToolCalls: number;
  failedToolCalls: number;
  toolCallsCount: number;
  executedInParallel: boolean;
}

export class TurnExecutor {
  private dispatcher?: ToolDispatcher;
  private permissionEngine?: PermissionEngine;
  private journal?: ExecutionJournal;
  private renderer?: TerminalRenderer;
  private checkpointManager?: CheckpointManager;

  constructor(
    dispatcher?: ToolDispatcher | {
      dispatcher?: ToolDispatcher;
      permissionEngine?: PermissionEngine;
      journal?: ExecutionJournal;
      renderer?: TerminalRenderer;
      checkpointManager?: CheckpointManager;
    },
    permissionEngine?: PermissionEngine,
    journal?: ExecutionJournal,
    renderer?: TerminalRenderer,
    checkpointManager?: CheckpointManager
  ) {
    if (dispatcher && typeof dispatcher === 'object' && !('dispatch' in dispatcher)) {
      this.dispatcher = dispatcher.dispatcher;
      this.permissionEngine = dispatcher.permissionEngine;
      this.journal = dispatcher.journal;
      this.renderer = dispatcher.renderer;
      this.checkpointManager = dispatcher.checkpointManager;
    } else {
      this.dispatcher = dispatcher as ToolDispatcher | undefined;
      this.permissionEngine = permissionEngine;
      this.journal = journal;
      this.renderer = renderer;
      this.checkpointManager = checkpointManager;
    }
  }

  setDispatcher(dispatcher: ToolDispatcher) {
    this.dispatcher = dispatcher;
  }

  setPermissionEngine(pe: PermissionEngine) {
    this.permissionEngine = pe;
  }

  setJournal(journal: ExecutionJournal) {
    this.journal = journal;
  }

  setRenderer(renderer: TerminalRenderer) {
    this.renderer = renderer;
  }

  setCheckpointManager(cm: CheckpointManager) {
    this.checkpointManager = cm;
  }
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

  /**
   * Executes a turn batch of tool calls with safe concurrency, action gating,
   * mutation verification, and execution journal recording.
   */
  async executeTurnBatch(
    toolCalls: Array<{ id?: string; type?: string; function: { name: string; arguments: Record<string, any> } }>,
    context: AgentContext,
    options: TurnBatchExecutionOptions = {}
  ): Promise<TurnBatchExecutionOutcome> {
    const toolMessages: ChatMessage[] = [];
    const results: ExecutedToolItem[] = [];
    let hasModifiedCode = Boolean(options.hasModifiedCode);
    let readStepCount = options.readStepCount || 0;
    let safetyCeiling = options.safetyCeiling || 120;
    let successfulToolCalls = 0;
    let failedToolCalls = 0;
    let toolCallsCount = 0;
    let shouldTerminateTurn = false;

    const isCloud = options.profile?.name === 'cloud-frontier' || false;
    const ABSOLUTE_MAX_STEPS = isCloud ? 250 : 120;
    const progress = options.progress;
    const dispatcher = options.dispatcher || this.dispatcher;
    const renderer = options.renderer || this.renderer;
    const checkpointManager = options.checkpointManager || this.checkpointManager;
    const stagnationDetector = options.stagnationDetector;
    const recoveryController = options.recoveryController;
    const contextEngine = options.contextEngine;
    const effectiveSignal = options.signal;
    const stepCount = options.stepCount || 1;
    const userInput = options.userInput || '';

    if (!dispatcher) {
      throw new Error('ToolDispatcher is required for TurnExecutor.executeTurnBatch');
    }

    const isPassiveTool = (name: string) =>
      name === 'view_file' ||
      name === 'search_code' ||
      name === 'batch_read_files' ||
      name === 'list_dir' ||
      name === 'find_by_name' ||
      name === 'grep_search' ||
      name === 'file_search';

    const taskRequestsModification = /\b(add|fix|edit|modify|update|change|create|implement|style|improve|refactor|remove|delete|write|build|setup|redesign)\b/i.test(userInput);

    // Progress Guard: Track obsessive single-file read loops & accelerate to action gate
    if (options.profile?.forceMutationAfterReads && progress) {
      for (const call of toolCalls) {
        if (call.function.name === 'view_file' && call.function.arguments?.path) {
          const p = String(call.function.arguments.path);
          const currentReads = (progress.fileReadTurns.get(p) || 0) + 1;
          progress.fileReadTurns.set(p, currentReads);
          const obsessionThresh = Math.min(2, options.profile.maxExplorationReads);
          if (currentReads >= obsessionThresh && !hasModifiedCode) {
            progress.singleFileObsession = true;
            progress.obsessedFilePath = p;
            break;
          }
        }
      }

      if (progress.singleFileObsession) {
        readStepCount = Math.max(readStepCount, Math.min(2, options.profile.maxExplorationReads));
      }
    }

    // Safe Concurrency & Parallel Tool Execution:
    // When allowParallelTools is true and all tools are read-only, execute concurrently.
    const allowParallel = options.allowParallelTools ?? options.profile?.allowParallelTools ?? false;
    const canRunParallel =
      allowParallel &&
      toolCalls.length > 1 &&
      toolCalls.every(c => isReadOnlyTool(c.function.name));

    if (canRunParallel) {
      if (renderer) {
        renderer.startSpinner(`Executing ${toolCalls.length} read operations in parallel...`);
      }
      const batchRes = await TurnExecutor.executeToolBatch(
        toolCalls,
        dispatcher,
        context,
        {
          allowParallelTools: true,
          autoApprove: options.autoApprove ?? context.autoApprove,
          allowNetwork: options.allowNetwork ?? options.profile?.privacyPolicy.allowWebAccess,
          signal: effectiveSignal
        }
      );
      if (renderer) {
        renderer.stopSpinner();
      }

      for (const res of batchRes.results) {
        toolCallsCount++;
        readStepCount++;
        if (renderer) {
          renderer.printToolResult(res.toolName, res.output, res.isError);
        }
        toolMessages.push({
          role: 'tool',
          name: res.toolName,
          tool_call_id: res.callId,
          content: res.output
        });
        if (progress) {
          progress.recentToolSignatures.push(`${res.toolName}:${JSON.stringify(res.arguments || {})}`);
        }
      }

      return {
        toolMessages,
        results: batchRes.results,
        shouldTerminateTurn: false,
        hasModifiedCode,
        readStepCount,
        safetyCeiling,
        successfulToolCalls: batchRes.results.filter(r => !r.isError).length,
        failedToolCalls: batchRes.results.filter(r => r.isError).length,
        toolCallsCount,
        executedInParallel: true
      };
    }

    // Sequential execution
    for (let i = 0; i < toolCalls.length; i++) {
      const call = toolCalls[i];
      toolCallsCount++;
      const callId = call.id || `call_${Date.now()}_${i}`;
      const toolName = call.function.name;
      const toolArgs = call.function.arguments || {};

      if (effectiveSignal?.aborted) {
        toolMessages.push({
          role: 'tool',
          name: toolName,
          tool_call_id: callId,
          content: 'Execution was cancelled.'
        });
        results.push({
          callId,
          toolName,
          arguments: toolArgs,
          output: 'Execution was cancelled.',
          isError: true
        });
        break;
      }

      // POST-VERIFICATION COMPLETION GATE
      const lastVerif = contextEngine?.getTaskState().lastVerification;
      if (!isCloud && hasModifiedCode && lastVerif && lastVerif.status === 'passed') {
        failedToolCalls++;
        if (progress) progress.failedToolCount++;
        const completeDirective = `[GOAL VERIFIED AND COMPLETE]
Your codebase modifications have already been verified cleanly (${lastVerif.summary}).
All further tool execution is disabled to preserve the verified file state.
You must now deliver your final summary and conclusion to the user to conclude the task.`;
        if (renderer) {
          renderer.printSuccess(`All changes verified cleanly (${lastVerif.summary}). Blocking further tool execution to finalize turn.`);
        }
        toolMessages.push({
          role: 'tool',
          name: toolName,
          tool_call_id: call.id,
          content: completeDirective
        });
        results.push({
          callId,
          toolName,
          arguments: toolArgs,
          output: completeDirective,
          isError: true
        });
        continue;
      }

      // RUNTIME ACTION GATE
      const verificationStillCurrent = hasModifiedCode && contextEngine?.getTaskState().lastVerification?.status === 'passed';
      const forceActionNow =
        Boolean(options.profile?.forceMutationAfterReads) &&
        taskRequestsModification &&
        !verificationStillCurrent &&
        (Boolean(progress?.singleFileObsession) || readStepCount >= (options.profile?.maxExplorationReads || 8));

      if (forceActionNow && toolName !== 'edit_file' && toolName !== 'write_file') {
        failedToolCalls++;
        if (progress) progress.failedToolCount++;
        const targetFile = toolArgs.path || (toolArgs.paths && toolArgs.paths[0]) || progress?.obsessedFilePath || '';
        const targetHint = targetFile ? ` on "${targetFile}"` : '';
        const directive = `[EXECUTION BLOCKED - ACTION REQUIRED] Inspection has repeated without a real file change (${readStepCount} inspections). Tool "${toolName}" is blocked now.
You MUST invoke 'edit_file' or 'write_file' to make a meaningful change${targetHint}. A shell command or no-op write does not count as progress. If no change is justified, explain the blocker instead of continuing tool calls.`;
        if (renderer) {
          renderer.printWarning(`Blocked "${toolName}" — requiring a meaningful file edit or final answer.`);
        }
        toolMessages.push({
          role: 'tool',
          name: toolName,
          tool_call_id: call.id,
          content: directive
        });
        results.push({
          callId,
          toolName,
          arguments: toolArgs,
          output: directive,
          isError: true
        });
        continue;
      }

      const tool = toolRegistry.get(toolName);
      if (!tool) {
        failedToolCalls++;
        if (progress) progress.failedToolCount++;
        const errMsg = `Tool "${toolName}" is not registered. Available tools: ${Array.from(toolRegistry.keys()).join(', ')}`;
        if (renderer) renderer.printError(errMsg);
        toolMessages.push({
          role: 'tool',
          name: toolName,
          tool_call_id: call.id,
          content: errMsg
        });
        results.push({
          callId,
          toolName,
          arguments: toolArgs,
          output: errMsg,
          isError: true
        });
        continue;
      }

      if (renderer) {
        renderer.printToolCall(toolName, toolArgs);
      }

      // Previews for file edits
      if (renderer) {
        if (toolName === 'edit_file' && toolArgs.path && toolArgs.target_content && toolArgs.replacement_content) {
          try {
            const targetPath = path.resolve(context.cwd, toolArgs.path);
            const currentContent = await fs.readFile(targetPath, 'utf8');
            const target = toolArgs.target_content;
            const replacement = toolArgs.replacement_content;
            const previewNew = currentContent.replace(target, replacement);
            renderer.printDiff(toolArgs.path, currentContent, previewNew);
          } catch {}
        } else if (toolName === 'write_file' && toolArgs.path) {
          try {
            const targetPath = path.resolve(context.cwd, toolArgs.path);
            let currentContent = '';
            try {
              currentContent = await fs.readFile(targetPath, 'utf8');
              renderer.printDiff(toolArgs.path, currentContent, toolArgs.content);
            } catch {
              console.log(`${theme.branch}New file: ${theme.path(toolArgs.path)}`);
            }
          } catch {}
        }
      }

      // Checkpoint record pre-edit file if mutation tool
      if (checkpointManager) {
        const isFileMutationTool =
          toolName === 'edit_file' ||
          toolName === 'write_file' ||
          toolName === 'multi_edit_file' ||
          toolName === 'delete_file' ||
          toolName === 'move_file';

        if (toolName === 'multi_edit_file') {
          const paths: string[] = [
            ...(toolArgs.path ? [toolArgs.path] : []),
            ...(Array.isArray(toolArgs.files) ? toolArgs.files.map((f: any) => f?.path) : []),
            ...(Array.isArray(toolArgs.edits) ? toolArgs.edits.map((e: any) => e?.path) : [])
          ].filter(p => typeof p === 'string');
          for (const p of new Set(paths)) {
            await checkpointManager.recordPreEditFile(p);
            if (options.onPreEdit) await options.onPreEdit(p);
          }
        } else if (toolName === 'move_file') {
          const src = toolArgs.sourcePath || toolArgs.source || toolArgs.path;
          const dst = toolArgs.targetPath || toolArgs.target || toolArgs.destination;
          if (src) {
            await checkpointManager.recordPreEditFile(src);
            if (options.onPreEdit) await options.onPreEdit(src);
          }
          if (dst) {
            await checkpointManager.recordPreEditFile(dst);
            if (options.onPreEdit) await options.onPreEdit(dst);
          }
        } else if (isFileMutationTool && toolArgs.path) {
          await checkpointManager.recordPreEditFile(toolArgs.path);
          if (options.onPreEdit) await options.onPreEdit(toolArgs.path);
        }
      }

      if (renderer) {
        renderer.startSpinner(`Executing ${toolName}...`);
      }

      const durableResult = await dispatcher.dispatch(
        tool,
        toolArgs,
        context,
        call.id,
        {
          autoApprove: options.autoApprove ?? context.autoApprove,
          allowNetwork: options.allowNetwork ?? options.profile?.privacyPolicy.allowWebAccess,
          signal: effectiveSignal
        }
      );

      if (renderer) {
        renderer.stopSpinner();
      }

      if (durableResult.status === 'validation_failed') {
        failedToolCalls++;
        if (progress) {
          progress.failedToolCount++;
          progress.consecutiveToolFailures++;
        }
        if (renderer) renderer.printError(durableResult.output);
        toolMessages.push({
          role: 'tool',
          name: toolName,
          tool_call_id: call.id,
          content: durableResult.output
        });
        results.push({
          callId,
          toolName,
          arguments: toolArgs,
          output: durableResult.output,
          isError: true,
          durableResult
        });
        continue;
      }

      if (durableResult.status === 'permission_denied') {
        failedToolCalls++;
        if (progress) progress.failedToolCount++;
        if (renderer) renderer.printError(durableResult.output);
        toolMessages.push({
          role: 'tool',
          name: toolName,
          tool_call_id: call.id,
          content: durableResult.output
        });
        results.push({
          callId,
          toolName,
          arguments: toolArgs,
          output: durableResult.output,
          isError: true,
          durableResult
        });
        continue;
      }

      if (renderer) {
        renderer.printToolResult(toolName, durableResult.output, durableResult.isError);
      }

      let executionResult: { result: string; isError?: boolean } = {
        result: durableResult.output,
        isError: durableResult.isError
      };

      const fileContentChanged = Boolean(durableResult.fileChanges?.changed);
      if (fileContentChanged && toolArgs.path && durableResult.fileChanges?.contentBefore && progress) {
        const beforeHash = crypto.createHash('md5').update(durableResult.fileChanges.contentBefore).digest('hex');
        const knownHashes = progress.fileContentHashes.get(toolArgs.path) || [];
        if (!knownHashes.includes(beforeHash)) knownHashes.push(beforeHash);
        if (knownHashes.length > 5) knownHashes.shift();
        progress.fileContentHashes.set(toolArgs.path, knownHashes);
      }

      if (isPassiveTool(toolName)) readStepCount++;
      if (fileContentChanged) readStepCount = 0;

      const isCommandExitDiagnostic = toolName === 'run_command' && !executionResult.result.startsWith('Failed to execute command:');
      if (executionResult.isError) {
        failedToolCalls++;
        if (progress) {
          progress.failedToolCount++;
          if (!isCommandExitDiagnostic) {
            progress.consecutiveToolFailures++;
          } else {
            progress.consecutiveToolFailures = 0;
          }

          if (toolName === 'edit_file' || toolName === 'write_file' || toolName === 'multi_edit_file') {
            progress.singleFileObsession = false;
            if (toolArgs.path) progress.fileReadTurns.delete(toolArgs.path);
          }

          if (progress.consecutiveToolFailures >= (isCloud ? 10 : 5)) {
            if (renderer) {
              renderer.printError(
                `Execution halted: ${progress.consecutiveToolFailures} consecutive tool execution errors encountered. Aborting turn to prevent token waste.`
              );
            }
            shouldTerminateTurn = true;
            toolMessages.push({
              role: 'tool',
              name: toolName,
              tool_call_id: call.id,
              content: executionResult.result
            });
            results.push({
              callId,
              toolName,
              arguments: toolArgs,
              output: executionResult.result,
              isError: true,
              durableResult
            });
            // Ensure any remaining calls in this batch also receive a tool result
            for (let j = i + 1; j < toolCalls.length; j++) {
              const skipped = toolCalls[j];
              toolMessages.push({
                role: 'tool',
                name: skipped.function.name,
                tool_call_id: skipped.id,
                content: '[CANCELLED] Tool execution aborted due to preceding consecutive failures.'
              });
              results.push({
                callId: skipped.id || `call_${Date.now()}_${j}`,
                toolName: skipped.function.name,
                arguments: skipped.function.arguments || {},
                output: '[CANCELLED] Tool execution aborted due to preceding consecutive failures.',
                isError: true
              });
            }
            break;
          } else if (progress.consecutiveToolFailures >= 3) {
            executionResult.result += `\n\n[CIRCUIT BREAKER WARNING] ${progress.consecutiveToolFailures} consecutive tool actions have failed. Stop guessing tool arguments. Re-read the target file with 'view_file' or check directory paths before proceeding.`;
          }
        }
      } else {
        successfulToolCalls++;
        if (progress) {
          progress.successfulToolCount++;
          progress.consecutiveToolFailures = 0;
        }

        if (toolName === 'multi_edit_file') {
          const paths: string[] = [
            ...(toolArgs.path ? [toolArgs.path] : []),
            ...(Array.isArray(toolArgs.files) ? toolArgs.files.map((f: any) => f?.path) : []),
            ...(Array.isArray(toolArgs.edits) ? toolArgs.edits.map((e: any) => e?.path) : [])
          ].filter(p => typeof p === 'string');
          for (const p of new Set(paths)) {
            const editCount = (progress?.fileEditCounts.get(p) || 0) + 1;
            if (progress) {
              progress.fileEditCounts.set(p, editCount);
              progress.filesModified.add(p);
            }
            hasModifiedCode = true;

            try {
              const lintResult = options.onFastLint
                ? await options.onFastLint(p)
                : await CodeVerifier.runFastLint(context.cwd, p);
              if (!lintResult.passed && lintResult.errorOutput) {
                executionResult.result += `\n\n[AUTOMATED LINTER / TYPECHECK FEEDBACK]:\nYour modification to "${p}" introduced compiler/type diagnostics (\`${lintResult.command}\`):\n\`\`\`\n${lintResult.errorOutput}\n\`\`\`\nPlease inspect the diagnostic above and resolve it on your next step.`;
              }
            } catch {}
          }
          if (progress) {
            progress.singleFileObsession = false;
            progress.obsessedFilePath = '';
            progress.consecutiveCycleDetections = 0;
            progress.recentToolSignatures = [];
          }
          if (stagnationDetector) stagnationDetector.resetRecoveryAttempts();
          if (recoveryController) recoveryController.resetRepetitionOnRealChange();
        } else if ((toolName === 'edit_file' || toolName === 'write_file') && toolArgs.path) {
          const editCount = (progress?.fileEditCounts.get(toolArgs.path) || 0) + 1;
          if (progress) {
            progress.fileEditCounts.set(toolArgs.path, editCount);
          }

          if (fileContentChanged) {
            hasModifiedCode = true;
            if (progress) {
              progress.filesModified.add(toolArgs.path);
              progress.singleFileObsession = false;
              progress.obsessedFilePath = '';
              progress.consecutiveCycleDetections = 0;
              progress.recentToolSignatures = [];
            }
            if (stagnationDetector) stagnationDetector.resetRecoveryAttempts();
            if (recoveryController) recoveryController.resetRepetitionOnRealChange();

            let isOscillation = false;
            try {
              if (options.onOscillationCheck) {
                const targetFullPath = path.resolve(context.cwd, toolArgs.path);
                const currentContent = await fs.readFile(targetFullPath, 'utf8');
                isOscillation = await options.onOscillationCheck(toolArgs.path, currentContent);
              } else if (recoveryController) {
                const targetFullPath = path.resolve(context.cwd, toolArgs.path);
                const currentContent = await fs.readFile(targetFullPath, 'utf8');
                const oscResult = recoveryController.recordFileHash(toolArgs.path, currentContent);
                if (fileContentChanged && oscResult.isOscillation) isOscillation = true;
              }
            } catch {}

            if (isOscillation) {
              if (renderer) {
                renderer.printWarning(`Detected edit oscillation on "${toolArgs.path}" (file reverted to earlier state).`);
              }
              executionResult.result += `\n\n[OSCILLATION WARNING] Your modification reverted "${toolArgs.path}" to an earlier state from this turn. You are thrashing between alternate versions. Run tests or inspect compiler output before editing this file again.`;
            }

            const maxEditChurn = isCloud ? 20 : 6;
            if (editCount > maxEditChurn) {
              if (renderer) {
                renderer.printWarning(`High edit churn on "${toolArgs.path}" (${editCount} edits in single turn).`);
              }
              executionResult.result += `\n\n[CHURN LIMIT REACHED] "${toolArgs.path}" has been modified ${editCount} times in this turn. Further blind edits are restricted. Please verify the code or finish the task.`;
            }

            if (fileContentChanged && (isCloud || editCount <= 4) && safetyCeiling < ABSOLUTE_MAX_STEPS) {
              safetyCeiling = Math.min(stepCount + 15, ABSOLUTE_MAX_STEPS, (options.profile?.safetyCeiling || 30) * 2);
            }

            try {
              const lintResult = options.onFastLint
                ? await options.onFastLint(toolArgs.path)
                : await CodeVerifier.runFastLint(context.cwd, toolArgs.path);
              if (!lintResult.passed && lintResult.errorOutput) {
                const fastLintFails = (progress?.fastLintFailuresPerFile.get(toolArgs.path) || 0) + 1;
                if (progress) {
                  progress.fastLintFailuresPerFile.set(toolArgs.path, fastLintFails);
                }

                if (isCloud || fastLintFails <= 2) {
                  console.log(`${theme.branch}${theme.alert} ${theme.warning(`Auto-lint diagnostic: syntax/type issue in ${toolArgs.path} (\`${lintResult.command}\`)`)}`);
                  executionResult.result += `\n\n[AUTOMATED LINTER / TYPECHECK FEEDBACK]:\nYour modification to "${toolArgs.path}" introduced compiler/type diagnostics (\`${lintResult.command}\`):\n\`\`\`\n${lintResult.errorOutput}\n\`\`\`\nPlease inspect the diagnostic above and invoke 'edit_file' to resolve it on your next step.`;
                } else {
                  console.log(`${theme.branch}${theme.alert} ${theme.warning(`Auto-lint diagnostic limit reached for ${toolArgs.path} (${fastLintFails} failures)`)}`);
                  executionResult.result += `\n\n[AUTOMATED LINTER CEILING REACHED]:\nRepeated attempts (${fastLintFails}) to auto-heal compiler diagnostics in "${toolArgs.path}" have failed:\n\`\`\`\n${lintResult.errorOutput}\n\`\`\`\nDo not attempt further blind edits to this file. Explain the error or formulate an alternative approach.`;
                }
              } else if (progress) {
                progress.fastLintFailuresPerFile.set(toolArgs.path, 0);
              }
            } catch {}
          } else {
            executionResult.result += `\n\n[NO-OP EDIT DETECTED] The operation succeeded but left "${toolArgs.path}" unchanged. This is not progress. Do not repeat the same edit/write; inspect the exact target or explain the blocker.`;
          }
        }
      }

      let toolOutput = executionResult.result || '';

      if (stagnationDetector) {
        try {
          const wsFp = await StagnationDetector.computeWorkspaceFingerprint(context.cwd);
          const isErr = Boolean(executionResult.isError);
          const testOutcome = toolName === 'run_command'
            ? {
                passed: !isErr,
                errorSignature: StagnationDetector.extractErrorSignature(toolOutput),
                command: toolArgs.command || toolArgs.cmd
              }
            : undefined;

          stagnationDetector.recordStep({
            turn: stepCount,
            toolCallId: call.id || `tc-${stepCount}-${toolCallsCount}`,
            normalizedTool: toolName,
            normalizedArgs: StagnationDetector.normalizeArguments(toolArgs),
            resultFingerprint: StagnationDetector.fingerprintResult(toolOutput, isErr),
            workspaceFingerprint: wsFp,
            isError: isErr,
            testOutcome,
            telemetry: {
              promptTokens: options.usage?.promptTokens,
              completionTokens: options.usage?.completionTokens,
              totalTokens: options.usage?.totalTokens,
              stopReason: options.stopReason
            }
          });

          if (toolName === 'run_command' && toolArgs.command) {
            const cmd = String(toolArgs.command).trim();
            const isVerifCmd = /^(python\s+-m\s+py_compile|pytest|npm\s+test|npx\s+tsc|tsc|cargo\s+test|go\s+test)/i.test(cmd);
            if (isVerifCmd) {
              if (contextEngine) {
                contextEngine.recordVerificationResult(!isErr, cmd, isErr ? toolOutput : undefined, isErr ? 'failed' : 'passed');
              }
              if (this.journal) {
                await this.journal.recordEvent('verification_completed', {
                  command: cmd,
                  category: 'test',
                  status: isErr ? 'failed' : 'passed',
                  passed: !isErr,
                  summary: isErr ? (toolOutput ? toolOutput.slice(0, 500) : 'Command failed') : `Command \`${cmd}\` passed with 0 errors.`
                }).catch(() => {});
              }
              if (!isErr && !toolOutput.trim()) {
                toolOutput = `[Command \`${cmd}\` exited cleanly with status code 0 and 0 errors. Verification passed. Please formulate your final response to complete the task.]`;
              }
            }
          }
        } catch {}
      }

      const MAX_TOOL_INGEST_CHARS = context.numCtx && context.numCtx >= 65536 ? 40000 : 4000;
      if (toolOutput.length > MAX_TOOL_INGEST_CHARS && contextEngine) {
        toolOutput = contextEngine.compactToolOutput(toolOutput, MAX_TOOL_INGEST_CHARS);
      }

      toolMessages.push({
        role: 'tool',
        name: toolName,
        tool_call_id: call.id,
        content: toolOutput
      });

      results.push({
        callId,
        toolName,
        arguments: toolArgs,
        output: toolOutput,
        isError: Boolean(executionResult.isError),
        durableResult
      });
    }

    return {
      toolMessages,
      results,
      shouldTerminateTurn,
      hasModifiedCode,
      readStepCount,
      safetyCeiling,
      successfulToolCalls,
      failedToolCalls,
      toolCallsCount,
      executedInParallel: false
    };
  }
}
