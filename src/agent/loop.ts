import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import { theme } from '../ui/theme.js';
import { AgentContext, ChatMessage } from '../types.js';
import { allTools, toolRegistry, registerDynamicTool, unregisterDynamicTools } from '../tools/index.js';
import { redactSecrets, redactSecretsFromMessages } from '../utils/secret-redactor.js';
import { ILLMProvider } from '../providers/types.js';
import { createLLMProvider, isCloudProvider, resolveProvider } from '../providers/factory.js';
import { ContextEngine } from './context.js';
import { TerminalRenderer } from '../ui/renderer.js';
import { buildSystemPrompt } from './prompt.js';
import { CheckpointManager } from '../git/checkpoint.js';
import { resolveFileMentions } from './mentions.js';
import { MCPManager } from '../mcp/manager.js';
import { CodeVerifier } from './verifier.js';
import { ArchitectEngine } from './architect.js';
import { SessionMemory } from './memory.js';
import { extractToolCalls } from '../utils/tool-parser.js';
import {
  StagnationDetector,
  StagnationDiagnosis,
  StagnationThresholds,
  DEFAULT_STAGNATION_THRESHOLDS,
  CLOUD_STAGNATION_THRESHOLDS
} from './stagnation.js';
import { ToolDispatcher } from '../engine/tool-dispatcher.js';
import { PermissionEngine } from '../engine/permission-engine.js';
import { RecoveryController } from '../engine/recovery-controller.js';
import { ExecutionState, DurableToolResult } from '../engine/types.js';
import { HarnessExecutionProfile, resolveExecutionProfile } from '../runtime/profiles.js';

export interface SessionStats {
  turns: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  totalDurationMs: number;
  modelCalls: number;
  toolCalls: number;
  successfulToolCalls: number;
  failedToolCalls: number;
  emptyGenerations: number;
  recoveries: number;
  retries: number;
  progressLoopsDetected: number;
  verificationRuns: number;
  tokensSavedByCompression: number;
  tokensAvoidedByDeduplication: number;
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

export interface ProgressTracker {
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

export interface CycleInfo {
  detected: boolean;
  period: number;
  repetitions: number;
  summary: string;
}

/**
 * Detects if recent tool execution signatures form a repeating periodic cycle.
 * Traps period 1 (identical call), period 2 (A-B-A-B ping-pong), period 3, and period 4.
 */
export function detectToolExecutionCycle(signatures: string[]): CycleInfo {
  return RecoveryController.detectToolCycle(signatures);
}

export class AgentLoop {
  private messages: ChatMessage[] = [];
  private provider: ILLMProvider;
  private renderer: TerminalRenderer;
  private contextEngine: ContextEngine;
  private context: AgentContext;
  private checkpointManager: CheckpointManager;
  private mcpManager: MCPManager;
  private stats: SessionStats = {
    turns: 0,
    totalTokens: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalDurationMs: 0,
    modelCalls: 0,
    toolCalls: 0,
    successfulToolCalls: 0,
    failedToolCalls: 0,
    emptyGenerations: 0,
    recoveries: 0,
    retries: 0,
    progressLoopsDetected: 0,
    verificationRuns: 0,
    tokensSavedByCompression: 0,
    tokensAvoidedByDeduplication: 0
  };

  private sessionMemory: SessionMemory;
  private stagnationDetector: StagnationDetector;
  private state: ExecutionState = 'idle';
  private executionProfile: HarnessExecutionProfile;
  private toolDispatcher: ToolDispatcher;
  private recoveryController: RecoveryController;
  private permissionEngine: PermissionEngine;

  constructor(context: AgentContext, renderer: TerminalRenderer, customProvider?: ILLMProvider) {
    this.context = context;
    if (!this.context.provider) {
      this.context.provider = resolveProvider(context);
    }
    this.renderer = renderer;
    this.provider = customProvider || createLLMProvider(context);
    this.contextEngine = new ContextEngine(context.numCtx || 8192, context.cwd);
    this.context.contextEngine = this.contextEngine;
    this.checkpointManager = new CheckpointManager(context.cwd);
    this.mcpManager = new MCPManager(context.cwd, { trusted: context.trustProjectMcp ?? false });
    this.sessionMemory = new SessionMemory(context.cwd);

    const isCloud = isCloudProvider(this.context.provider);
    const defaultThresholds = isCloud ? CLOUD_STAGNATION_THRESHOLDS : DEFAULT_STAGNATION_THRESHOLDS;
    this.stagnationDetector = new StagnationDetector({ ...defaultThresholds, ...context.stagnationThresholds });

    this.executionProfile = resolveExecutionProfile(isCloud);
    this.permissionEngine = new PermissionEngine({
      autoApprove: this.context.autoApprove
    });
    this.toolDispatcher = new ToolDispatcher(this.permissionEngine, {
      confirmApproval: async (toolName, args, reason) => {
        try {
          return await confirm({
            message: `approve ${theme.accent(toolName)}?${reason ? ` (${reason})` : ''}`,
            default: true
          });
        } catch {
          return false;
        }
      },
      onProgress: (prog) => {
        const sec = Math.floor(prog.elapsedMs / 1000);
        if (sec >= 1) {
          const hint = prog.lastOutput ? ` · ${prog.lastOutput.slice(0, 45)}` : '';
          this.renderer.startSpinner(`Executing... (${sec}s${hint})`);
        }
      }
    });
    this.recoveryController = new RecoveryController(
      this.stagnationDetector,
      isCloud ? 10 : 5
    );
  }

  getState(): ExecutionState {
    return this.state;
  }

  getExecutionProfile(): HarnessExecutionProfile {
    return this.executionProfile;
  }

  setExecutionProfile(profile: Partial<HarnessExecutionProfile>) {
    this.executionProfile = {
      ...this.executionProfile,
      ...profile,
      privacyPolicy: {
        ...this.executionProfile.privacyPolicy,
        ...profile.privacyPolicy
      },
      costPolicy: {
        ...this.executionProfile.costPolicy,
        ...profile.costPolicy
      }
    };
  }

  getToolDispatcher(): ToolDispatcher {
    return this.toolDispatcher;
  }

  getPermissionEngine(): PermissionEngine {
    return this.permissionEngine;
  }

  getRecoveryController(): RecoveryController {
    return this.recoveryController;
  }

  async init() {
    this.state = 'initializing';
    const isCloud = isCloudProvider(this.context.provider);
    const allowFullRepo = this.executionProfile.privacyPolicy.allowFullRepoContext;
    this.messages = [{
      role: 'system',
      content: await buildSystemPrompt(this.context.cwd, isCloud, allowFullRepo)
    }];

    // Restore previous session memory if available
    const prevSession = await this.sessionMemory.loadSession();
    if (prevSession && prevSession.messages.length > 0) {
      // Rehydrate durable decisions and task state
      if (prevSession.lastDecisions && prevSession.lastDecisions.length > 0) {
        for (const dec of prevSession.lastDecisions) {
          this.contextEngine.addDecision(dec);
        }
      }

      // Rehydrate previous non-system messages into context
      this.messages.push(...prevSession.messages);

      const turnCount = prevSession.messages.filter(m => m.role === 'user').length;
      const fileCount = prevSession.recentFiles?.length || 0;
      this.renderer.printSuccess(
        `Restored session memory: ${turnCount} previous turns reloaded (${fileCount} relevant files tracked)`
      );
    }

    // Connect MCP servers if configured
    const mcpTools = await this.mcpManager.init();
    for (const tool of mcpTools) {
      registerDynamicTool(tool);
    }

    if (mcpTools.length > 0) {
      const servers = this.mcpManager.getActiveServers().join(', ');
      this.renderer.printSuccess(`Connected to MCP servers [${servers}] with ${mcpTools.length} tools`);
    }
  }

  getMCPManager(): MCPManager {
    return this.mcpManager;
  }

  getContextEngine(): ContextEngine {
    return this.contextEngine;
  }

  async close() {
    const unregisterToolNames = await this.mcpManager.closeAll();
    unregisterDynamicTools(unregisterToolNames);
  }

  setContext(context: Partial<AgentContext>) {
    this.context = { ...this.context, ...context };
    if (context.autoApprove !== undefined) {
      this.permissionEngine.setPolicy({ autoApprove: context.autoApprove });
    }
    if (context.model) {
      this.provider.setModel(context.model);
    }
    if (context.numCtx) {
      if (this.provider.setNumCtx) {
        this.provider.setNumCtx(context.numCtx);
      }
      this.contextEngine.setMaxTokens(context.numCtx);
    }
    if (context.stagnationThresholds) {
      this.stagnationDetector = new StagnationDetector(context.stagnationThresholds);
    } else if (context.provider) {
      const isCloud = isCloudProvider(context.provider);
      const defaultThresholds = isCloud ? CLOUD_STAGNATION_THRESHOLDS : DEFAULT_STAGNATION_THRESHOLDS;
      this.stagnationDetector = new StagnationDetector(defaultThresholds);
      this.executionProfile = resolveExecutionProfile(isCloud);
    }
    this.context.contextEngine = this.contextEngine;
  }

  setProvider(provider: ILLMProvider, providerType?: import('../types.js').ProviderType) {
    this.provider = provider;
    if (providerType) {
      this.context.provider = providerType;
      if (this.context.apiKey && !isCloudProvider(providerType)) {
        this.context.apiKey = undefined;
      }
      const isCloud = isCloudProvider(providerType);
      const defaultThresholds = isCloud ? CLOUD_STAGNATION_THRESHOLDS : DEFAULT_STAGNATION_THRESHOLDS;
      this.stagnationDetector = new StagnationDetector(defaultThresholds);
      this.recoveryController = new RecoveryController(this.stagnationDetector, isCloud ? 10 : 5);
      this.executionProfile = resolveExecutionProfile(isCloud);
    }
  }

  getStagnationDetector(): StagnationDetector {
    return this.stagnationDetector;
  }

  getProvider(): ILLMProvider {
    return this.provider;
  }

  getContext(): AgentContext {
    return this.context;
  }

  getStats(): SessionStats {
    const engineStats = this.contextEngine.getStats();
    return {
      ...this.stats,
      tokensSavedByCompression: engineStats.tokensSavedByCompression,
      tokensAvoidedByDeduplication: engineStats.tokensAvoidedByDeduplication
    };
  }

  async clearHistory() {
    const isCloud = isCloudProvider(this.context.provider);
    const allowFullRepo = this.executionProfile.privacyPolicy.allowFullRepoContext;
    this.messages = [{
      role: 'system',
      content: await buildSystemPrompt(this.context.cwd, isCloud, allowFullRepo)
    }];
    await this.sessionMemory.clearSession();
  }

  getSessionMemory(): SessionMemory {
    return this.sessionMemory;
  }

  getMessages(): ChatMessage[] {
    return this.messages;
  }

  async undo(): Promise<{ success: boolean; message: string }> {
    return await this.checkpointManager.undo();
  }

  /**
   * Enforces cloud privacy and secret-redaction policies at every outgoing request boundary.
   */
  private prepareMessagesForProvider(messages: ChatMessage[]): ChatMessage[] {
    if (this.executionProfile.privacyPolicy.redactSecrets || isCloudProvider(this.context.provider)) {
      return redactSecretsFromMessages(messages);
    }
    return messages;
  }

  /**
   * Generates a clean Conventional Commit message based on git diff
   */
  async generateCommitMessage(diffText: string): Promise<string> {
    const prompt = `Based on the following git diff, generate a concise Conventional Commit message (e.g. "feat: add user auth" or "fix(parser): handle empty strings"). Output ONLY the commit message without any quotes or explanations.\n\nGit diff:\n${diffText.slice(0, 4000)}`;

    try {
      const res = await this.provider.chat(this.prepareMessagesForProvider([
        { role: 'user', content: prompt }
      ]), []);
      return res.content.trim().replace(/^["']|["']$/g, '');
    } catch {
      return 'chore: update project files';
    }
  }

  /**
   * Normalizes raw LLM generation results into structured outcomes,
   * cleanly distinguishing text responses, tool calls, empty responses, and provider errors.
   */
  private normalizeResponse(response: any, rawError?: any): NormalizedGeneration {
    if (rawError) {
      const cause = rawError.cause ? ` (${rawError.cause.code || rawError.cause.message || rawError.cause})` : '';
      const msg = (rawError.message || String(rawError)) + cause;
      const isRetryable = /timeout|econnreset|econnrefused|fetch failed|network|socket|503|502|429/i.test(msg);
      return {
        type: isRetryable ? 'PROVIDER_ERROR_RETRYABLE' : 'PROVIDER_ERROR_FATAL',
        rawContent: '',
        cleanedText: '',
        errorMessage: msg
      };
    }

    const content = response.content || '';
    let toolCalls = response.tool_calls;

    // Standardize tool calls if present
    let formattedToolCalls: Array<{ id?: string; type?: string; function: { name: string; arguments: Record<string, any> } }> | undefined;
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
            name: tc.function?.name || '',
            arguments: args || {}
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

    // If completely empty or whitespace only
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

  async run(userInput: string) {
    if (this.messages.length === 0) {
      await this.init();
    }

    // 1. Create a git checkpoint prior to making any modifications
    await this.checkpointManager.createCheckpoint();

    // 2. Resolve any @file references in user prompt
    const { processedPrompt, injectedFiles } = await resolveFileMentions(userInput, this.context.cwd);
    if (injectedFiles.length > 0) {
      this.renderer.printMentionedFiles(injectedFiles);
    }

    this.contextEngine.setObjective(userInput);

    this.messages.push({
      role: 'user',
      content: processedPrompt
    });

    // Adaptive execution budget:
    // Decouple read/inspection actions from active mutations so the model never exhausts its budget
    // while researching code. Strictly bounded by ABSOLUTE_MAX_STEPS to prevent infinite loops.
    const isCloud = isCloudProvider(this.context.provider);
    let safetyCeiling = isCloud ? 100 : 45;
    const ABSOLUTE_MAX_STEPS = isCloud ? 250 : 60;
    let stepCount = 0;
    let readStepCount = 0;
    let hasModifiedCode = false;
    let repairAttempts = 0;
    const maxRepairAttempts = 3;

    const progress: ProgressTracker = {
      recentToolSignatures: [],
      recentFailureSignatures: [],
      filesModified: new Set<string>(),
      fileReadTurns: new Map<string, number>(),
      fileEditCounts: new Map<string, number>(),
      fileContentHashes: new Map<string, string[]>(),
      fastLintFailuresPerFile: new Map<string, number>(),
      consecutiveCycleDetections: 0,
      consecutiveToolFailures: 0,
      successfulToolCount: 0,
      failedToolCount: 0,
      consecutiveNoProgressCount: 0,
      consecutiveEmptyResponses: 0,
      actionNudgeGiven: false
    };

    const isPassiveTool = (name: string) =>
      name === 'view_file' ||
      name === 'search_code' ||
      name === 'batch_read_files' ||
      name === 'list_dir' ||
      name === 'find_by_name' ||
      name === 'grep_search' ||
      name === 'file_search';
    const taskRequestsModification = /\b(add|fix|edit|modify|update|change|create|implement|style|improve|refactor|remove|delete|write|build|setup|redesign)\b/i.test(userInput);

    while (stepCount < safetyCeiling) {
      stepCount++;

      // Run working synthesis ONLY when code has already been modified, approaching true context boundary
      let synthesizedFindings: string | undefined;
      const currentMsgTokens = this.contextEngine.estimateMessagesTokens(this.messages);
      const toolTokens = this.contextEngine.estimateToolsTokens(allTools);
      const maxTokens = this.contextEngine.getMaxTokens();
      const hasSynthesisHeadroom = currentMsgTokens + toolTokens < maxTokens - 1500;

      if (
        hasModifiedCode &&
        stepCount >= 15 &&
        this.contextEngine.shouldCompact(this.messages, toolTokens) &&
        this.messages.length > 8 &&
        hasSynthesisHeadroom &&
        progress.consecutiveNoProgressCount === 0 &&
        stepCount % 10 === 0
      ) {
        this.renderer.startSpinner('Saving working state before memory fold...');
        try {
          const synthesisPrompt: ChatMessage = {
            role: 'user',
            content: '[DIRECTIVE] Working state fold. State in 1 sentence what code modification you will apply next. Then immediately apply it with edit_file or write_file.'
          };
          const preFoldTurn = [...this.messages, synthesisPrompt];
          const digest = await this.provider.chat(this.prepareMessagesForProvider(preFoldTurn), [], undefined, { toolChoice: 'none' });
          if (digest.content && digest.content.trim()) {
            synthesizedFindings = digest.content.trim();
          }
        } catch {
          // Graceful fallback
        } finally {
          this.renderer.stopSpinner();
        }
      }

      // Compact context respecting prefix stability
      const compactionRunsBefore = this.contextEngine.getStats().compactionRuns;
      const compacted = this.contextEngine.compactMessages(this.messages, synthesizedFindings);
      if (compacted !== this.messages) {
        this.messages = compacted;
      }
      // If compaction folded earlier file views out of context, the model legitimately has to re-read them.
      // Don't count those re-reads as "obsession"/inspection streaks, otherwise the action gate withdraws
      // view_file (leaving only edit tools) and the model can never recover the contents it just lost.
      if (this.contextEngine.getStats().compactionRuns > compactionRunsBefore) {
        progress.fileReadTurns.clear();
        progress.singleFileObsession = false;
        progress.obsessedFilePath = '';
        readStepCount = 0;
        progress.recentToolSignatures = [];
      }

      // AUTONOMOUS ACTION GATE & POST-VERIFICATION TOOL RESTRICTION:
      // 1. If code was modified and verification has already PASSED with 0 errors,
      //    strictly withdraw passive inspection tools (view_file, search_code, list_dir, etc.)
      //    so the model has no choice but to provide its final response!
      // 2. If the model is obsessively reading the same file repeatedly (2+ reads),
      //    or has reached a high exploration ceiling (8+ reads) without making edits,
      //    temporarily withdraw passive reads and shell commands so only edit_file/write_file can count as progress.
      const lastVerifPassed = hasModifiedCode && this.contextEngine.getTaskState().lastVerification?.status === 'passed';
      const shouldForceMutationTools = !isCloud && taskRequestsModification && !lastVerifPassed && (Boolean(progress.singleFileObsession) || readStepCount >= 8);

      let activeTools = allTools;
      if (lastVerifPassed) {
        // A passed verification belongs to the current file contents. Expose no tools:
        // post-verification edits or shell commands would invalidate the result.
        activeTools = [];
      } else if (shouldForceMutationTools) {
        activeTools = allTools.filter(t => t.name === 'edit_file' || t.name === 'write_file');
      }

      this.renderer.startSpinner(`thinking (${this.context.model})...`);

      let rawResponse: any;
      let rawError: any;
      let streamedTokens = 0;
      const chatOpts: import('../providers/types.js').ChatOptions = {};
      if (this.context.maxOutputTokens) {
        chatOpts.maxTokens = this.context.maxOutputTokens;
      }
      if (lastVerifPassed) chatOpts.toolChoice = 'none';
      if (progress.consecutiveCycleDetections > 0 || this.stagnationDetector.getRecoveryAttempts() > 0) {
        chatOpts.temperature = 0.35;
        chatOpts.repeatPenalty = 1.18;
        chatOpts.frequencyPenalty = 0.25;
        chatOpts.presencePenalty = 0.15;
      }

      try {
        rawResponse = await this.provider.chat(
          this.prepareMessagesForProvider(compacted),
          activeTools,
          (token) => {
            streamedTokens++;
            if (streamedTokens === 1) {
              this.renderer.startSpinner(`generating (${this.context.model})...`);
            } else if (streamedTokens % 15 === 0) {
              this.renderer.startSpinner(`generating (${this.context.model} · ${streamedTokens} tokens)...`);
            }
          },
          chatOpts
        );
      } catch (err: any) {
        rawError = err;
      } finally {
        // Guarantee spinner is ALWAYS stopped upon completion of model invocation
        this.renderer.stopSpinner();
      }

      this.stats.modelCalls++;

      // Normalize generation outcome
      const outcome = this.normalizeResponse(rawResponse, rawError);

      // Accumulate usage telemetry
      if (outcome.usage) {
        this.stats.turns++;
        this.stats.totalTokens += outcome.usage.totalTokens;
        this.stats.promptTokens += outcome.usage.promptTokens;
        this.stats.completionTokens += outcome.usage.completionTokens;
        this.stats.totalDurationMs += outcome.usage.durationMs;
      }

      // STATE MACHINE ROUTING

      // Outcome A: Provider Error
      if (outcome.type === 'PROVIDER_ERROR_RETRYABLE' || outcome.type === 'PROVIDER_ERROR_FATAL') {
        if (outcome.type === 'PROVIDER_ERROR_RETRYABLE' && progress.consecutiveNoProgressCount < 3) {
          progress.consecutiveNoProgressCount++;
          this.stats.retries++;
          const backoffMs = Math.min(6000, 1500 * Math.pow(2, progress.consecutiveNoProgressCount - 1));
          this.renderer.printWarning(`Model connection interrupted (${outcome.errorMessage}). Retrying in ${(backoffMs / 1000).toFixed(1)}s (${progress.consecutiveNoProgressCount}/3)...`);
          await new Promise(r => setTimeout(r, backoffMs));
          continue;
        } else {
          this.renderer.printError(`Model request failed: ${outcome.errorMessage}`);
          break;
        }
      }

      // Outcome B: Empty / Quiet Generation Recovery (Authoritative RecoveryController)
      if (outcome.type === 'EMPTY_RESPONSE') {
        this.stats.emptyGenerations++;
        const lastToolMsg = [...this.messages].reverse().find(m => m.role === 'tool');
        const lastOutcomeText = typeof lastToolMsg?.content === 'string' ? lastToolMsg.content : undefined;
        const action = this.recoveryController.handleEmptyResponse(userInput, lastOutcomeText);

        if (action.type === 'warn') {
          this.stats.recoveries++;
          this.renderer.printWarning(
            action.message || 'Model generated an empty response without tool calls. Issuing bounded continuation directive...'
          );
          this.messages.push({
            role: 'user',
            content: action.directive || `[CONTINUATION INSTRUCTION]\nPlease proceed with the next tool call.`
          });
          continue;
        } else {
          this.renderer.printError(action.message || 'Model returned empty responses repeatedly without progressing. Terminating turn cleanly.');
          break;
        }
      }

      // Reset empty response / transient-error counters on productive generation
      this.recoveryController.resetEmptyResponseCount();
      progress.consecutiveEmptyResponses = 0;
      progress.consecutiveNoProgressCount = 0;

      // Print assistant textual thoughts if available
      if (outcome.cleanedText) {
        this.renderer.printAssistantMessage(outcome.cleanedText);
      }

      // Outcome C: Text Only (No Tool Calls Requested)
      if (outcome.type === 'TEXT_FINAL' || !outcome.toolCalls || outcome.toolCalls.length === 0) {
        // Anti-Procrastination Nudge: If user requested code modification on a local model, but model only returned text without edits
        if (!isCloud && !hasModifiedCode && readStepCount >= 1 && !progress.actionNudgeGiven) {
          const isModificationRequest = /\b(add|fix|edit|modify|update|change|create|implement|style|improve|refactor|remove|delete|write|build|setup|redesign)\b/i.test(userInput);
          if (isModificationRequest) {
            progress.actionNudgeGiven = true;
            this.renderer.printWarning('Model described modifications without invoking edit tools. Nudging to apply changes...');
            this.messages.push({
              role: 'assistant',
              content: outcome.rawContent || ''
            });
            this.messages.push({
              role: 'user',
              content: `[ACTION DIRECTIVE] Do not just describe the plan or findings. Please execute 'edit_file' or 'write_file' now to apply these concrete changes to the codebase.`
            });
            continue;
          }
        }

        // Autonomous Verification & Self-Repair Gate
        if (hasModifiedCode && repairAttempts < maxRepairAttempts) {
          this.renderer.startSpinner('Running automated verification & health check...');
          this.stats.verificationRuns++;
          const vResult = await CodeVerifier.run(this.context.cwd);
          this.renderer.stopSpinner();

          this.contextEngine.recordVerificationResult(vResult.passed, vResult.command || 'verify', vResult.errorOutput, vResult.status);

          // Track verification signal in StagnationDetector
          const currentWs = await StagnationDetector.computeWorkspaceFingerprint(this.context.cwd);
          this.stagnationDetector.recordStep({
            turn: stepCount,
            toolCallId: `verify-${stepCount}-${repairAttempts}`,
            normalizedTool: 'verify',
            normalizedArgs: { command: vResult.command || 'verify' },
            resultFingerprint: StagnationDetector.fingerprintResult(vResult.errorOutput || (vResult.passed ? 'PASSED' : 'FAILED'), !vResult.passed),
            workspaceFingerprint: currentWs,
            isError: vResult.status === 'failed',
            testOutcome: {
              passed: vResult.status === 'passed',
              errorSignature: StagnationDetector.extractErrorSignature(vResult.errorOutput || ''),
              command: vResult.command || 'verify'
            }
          });

          if (vResult.status === 'failed') {
            repairAttempts++;

            // Check if verification failures have stagnated with unchanged error signatures
            const stagDiag = this.stagnationDetector.diagnose();
            if (stagDiag.stagnated) {
              const recAttempts = this.stagnationDetector.incrementRecoveryAttempts();
              this.stats.progressLoopsDetected++;
              this.stats.recoveries++;

              if (recAttempts > this.stagnationDetector.getThresholds().maxRecoveryAttempts) {
                this.renderer.printWarning(
                  `Terminating: test failure stagnation limit exceeded (${recAttempts} recovery attempts). Halting cleanly with evidence.`
                );
                this.messages.push({
                  role: 'assistant',
                  content: `[VERIFICATION STAGNATION TERMINATION]\n${stagDiag.summary}\nEvidence:\n${stagDiag.evidence.join('\n')}\nUnresolved blocker: ${vResult.errorOutput?.slice(0, 500)}`
                });
                break;
              }

              const recoveryDirective = this.stagnationDetector.buildRecoveryDirective(userInput, stagDiag);
              this.renderer.printWarning(`Test failure stagnation detected: ${stagDiag.summary}. Issuing bounded recovery directive (${recAttempts}/${this.stagnationDetector.getThresholds().maxRecoveryAttempts})...`);
              this.messages.push({
                role: 'assistant',
                content: outcome.rawContent || ''
              });
              this.messages.push({
                role: 'user',
                content: recoveryDirective
              });
              continue;
            }

            let architectPlan = '';
            // If verification failed twice or mode is architect, escalate to Architect for root-cause diagnosis
            if (repairAttempts >= 2 || this.context.mode === 'architect') {
              const archModel = this.context.architectModel || this.context.model;
              this.renderer.printWarning(`escalating to architect mode (${archModel}) for diagnosis...`);
              this.renderer.startSpinner('analyzing cross-file contracts...');
              architectPlan = await ArchitectEngine.diagnose(
                vResult.errorOutput || '',
                vResult.command || '',
                this.messages,
                this.context,
                this.provider
              );
              this.renderer.stopSpinner();
              console.log(`\n  ${theme.strong('architect directive:')}\n  ${theme.muted(architectPlan)}\n`);
            } else {
              this.renderer.printWarning(
                `self-repair [attempt ${repairAttempts}/${maxRepairAttempts}]: \`${vResult.command}\` failed. feeding error trace to model...`
              );
            }

            this.messages.push({
              role: 'assistant',
              content: outcome.rawContent || ''
            });

            const errorPrompt = architectPlan
              ? `[AUTONOMOUS VERIFICATION FAILED - ARCHITECT ESCALATION]
Command executed: \`${vResult.command}\`
Compiler / Test failure:
\`\`\`
${vResult.errorOutput}
\`\`\`

🏛️ Senior Architect Directive:
${architectPlan}

Follow the Senior Architect's diagnosis above. Use 'edit_file' to apply the surgical fix to the affected files. Do not deviate from the plan.`
              : `[AUTONOMOUS VERIFICATION FAILED]
Command executed: \`${vResult.command}\`

Error output:
\`\`\`
${vResult.errorOutput}
\`\`\`

The modifications introduced compilation, syntax, or test errors. Analyze the stack trace above, locate the offending file and line, and use 'edit_file' to repair the error. Do not complete the task until the error is resolved.`;

            this.messages.push({
              role: 'user',
              content: errorPrompt
            });
            continue; // Continue loop to repair
          } else if (vResult.status === 'passed' && vResult.command) {
            this.renderer.printSuccess(`Verification passed: \`${vResult.command}\` exited with 0 errors.`);
          } else if (vResult.status === 'inconclusive' && vResult.command) {
            this.renderer.printWarning(`Verification inconclusive for \`${vResult.command}\`: ${vResult.reason || 'Execution timed out'}`);
          }
        }

        // Clean completion
        this.messages.push({
          role: 'assistant',
          content: outcome.rawContent || ''
        });
        const estTokens = this.contextEngine.estimateMessagesTokens(this.messages);
        const maxTokens = this.contextEngine.getMaxTokens();
        this.renderer.printTelemetry(outcome.usage, {
          usedTokens: estTokens,
          maxTokens: maxTokens
        });

        // Save session memory for instant recall next time
        await this.sessionMemory.saveSession({
          model: this.context.model,
          messages: this.messages,
          lastDecisions: this.contextEngine.getTaskState().decisions,
          recentFiles: this.contextEngine.getTaskState().relevantFiles,
          summary: outcome.rawContent
        });
        break;
      }

      // Outcome D: Tool Calls
      const toolCalls = outcome.toolCalls;

      // Add assistant's action to message history
      this.messages.push({
        role: 'assistant',
        content: outcome.cleanedText || '',
        tool_calls: toolCalls
      });

      // Progress Guard 1: Authoritative cycle and stagnation evaluation via RecoveryController
      const recoveryAction = this.recoveryController.evaluateToolCalls(toolCalls, userInput);

      if (recoveryAction.type === 'halt') {
        this.stats.progressLoopsDetected++;
        this.renderer.printWarning(
          recoveryAction.message || 'Model entered persistent stagnation. Halting execution cleanly.'
        );
        this.messages.push({
          role: 'assistant',
          content: recoveryAction.directive || `[STAGNATION TERMINATION REPORT]\nReason: Model entered persistent stagnation.`
        });
        break;
      } else if (recoveryAction.type === 'block_repetition') {
        this.stats.progressLoopsDetected++;
        this.stats.recoveries++;
        this.renderer.printWarning(
          recoveryAction.message || 'Repeated execution cycle detected. Blocking repeated tool actions and enforcing alternative action.'
        );
        for (const call of toolCalls) {
          this.messages.push({
            role: 'tool',
            name: call.function.name,
            tool_call_id: call.id,
            content: recoveryAction.directive || '[EXECUTION BLOCKED - CYCLE DETECTED] This tool call was BLOCKED.'
          });
        }
        continue;
      } else if (recoveryAction.type === 'warn') {
        this.stats.progressLoopsDetected++;
        this.stats.recoveries++;
        this.renderer.printWarning(
          recoveryAction.message || 'Detected repetitive tool execution loop. Intervening with recovery directive...'
        );
        for (const call of toolCalls) {
          this.messages.push({
            role: 'tool',
            name: call.function.name,
            tool_call_id: call.id,
            content: recoveryAction.directive || '[PROGRESS GUARD WARNING] Please avoid repeating this tool action.'
          });
        }
        continue;
      }

      // Progress Guard 2: Trap obsessive single-file read loops & accelerate to action gate (local quantized models only)
      if (!isCloud) {
        for (const call of toolCalls) {
          if (call.function.name === 'view_file' && call.function.arguments?.path) {
            const p = String(call.function.arguments.path);
            const currentReads = (progress.fileReadTurns.get(p) || 0) + 1;
            progress.fileReadTurns.set(p, currentReads);
            if (currentReads >= 2 && !hasModifiedCode) {
              progress.singleFileObsession = true;
              progress.obsessedFilePath = p;
              break;
            }
          }
        }

        if (progress.singleFileObsession) {
          readStepCount = Math.max(readStepCount, 2);
        }
      }

      // Execute each tool call sequentially
      let shouldTerminateTurn = false;
      for (const call of toolCalls) {
        this.stats.toolCalls++;
        const toolName = call.function.name;
        const toolArgs = call.function.arguments || {};

        // POST-VERIFICATION COMPLETION GATE (inspired by Cline & Ralph-Loop):
        // If code has been modified and verification (e.g. py_compile, tsc, npm test) has already PASSED with 0 errors,
        // do not let local models wander into redundant passive inspections or speculative checks. Force turn finalization.
        const lastVerif = this.contextEngine.getTaskState().lastVerification;
        if (!isCloud && hasModifiedCode && lastVerif && lastVerif.status === 'passed') {
          this.stats.failedToolCalls++;
          const completeDirective = `[GOAL VERIFIED AND COMPLETE]
Your codebase modifications have already been verified cleanly (${lastVerif.summary}).
All further tool execution is disabled to preserve the verified file state.
You must now deliver your final summary and conclusion to the user to conclude the task.`;
          this.renderer.printSuccess(`All changes verified cleanly (${lastVerif.summary}). Blocking further tool execution to finalize turn.`);
          this.messages.push({
            role: 'tool',
            name: toolName,
            tool_call_id: call.id,
            content: completeDirective
          });
          continue;
        }

        // RUNTIME ACTION GATE: re-evaluate before EACH tool in a batch. One model response
        // can contain many calls, so a turn-level tool list cannot enforce the limit by itself.
        // Once the inspection streak is exhausted, block all non-edit tools, including shell commands.
        const verificationStillCurrent = hasModifiedCode && this.contextEngine.getTaskState().lastVerification?.status === 'passed';
        const forceActionNow = !isCloud && taskRequestsModification && !verificationStillCurrent && (Boolean(progress.singleFileObsession) || readStepCount >= 8);
        if (forceActionNow && toolName !== 'edit_file' && toolName !== 'write_file') {
          this.stats.failedToolCalls++;
          const targetFile = toolArgs.path || (toolArgs.paths && toolArgs.paths[0]) || progress.obsessedFilePath || '';
          const targetHint = targetFile ? ` on \"${targetFile}\"` : '';
          const directive = `[EXECUTION BLOCKED - ACTION REQUIRED] Inspection has repeated without a real file change (${readStepCount} inspections). Tool \"${toolName}\" is blocked now.
You MUST invoke 'edit_file' or 'write_file' to make a meaningful change${targetHint}. A shell command or no-op write does not count as progress. If no change is justified, explain the blocker instead of continuing tool calls.`;
          this.renderer.printWarning(`Blocked \"${toolName}\" — requiring a meaningful file edit or final answer.`);
          this.messages.push({
            role: 'tool',
            name: toolName,
            tool_call_id: call.id,
            content: directive
          });
          continue;
        }

        const tool = toolRegistry.get(toolName);
        if (!tool) {
          this.stats.failedToolCalls++;
          const errMsg = `Tool "${toolName}" is not registered. Available tools: ${Array.from(toolRegistry.keys()).join(', ')}`;
          this.renderer.printError(errMsg);
          this.messages.push({
            role: 'tool',
            name: toolName,
            tool_call_id: call.id,
            content: errMsg
          });
          continue;
        }

        this.renderer.printToolCall(toolName, toolArgs);

        // Previews for file edits
        if (toolName === 'edit_file' && toolArgs.path && toolArgs.target_content && toolArgs.replacement_content) {
          try {
            const targetPath = path.resolve(this.context.cwd, toolArgs.path);
            const currentContent = await fs.readFile(targetPath, 'utf8');
            const target = toolArgs.target_content;
            const replacement = toolArgs.replacement_content;
            const previewNew = currentContent.replace(target, replacement);
            this.renderer.printDiff(toolArgs.path, currentContent, previewNew);
          } catch {}
        } else if (toolName === 'write_file' && toolArgs.path) {
          try {
            const targetPath = path.resolve(this.context.cwd, toolArgs.path);
            let currentContent = '';
            try {
              currentContent = await fs.readFile(targetPath, 'utf8');
              this.renderer.printDiff(toolArgs.path, currentContent, toolArgs.content);
            } catch {
              console.log(`${theme.branch}New file: ${theme.path(toolArgs.path)}`);
            }
          } catch {}
        }

        // Checkpoint record pre-edit file if mutation tool
        const isFileMutationTool = (toolName === 'edit_file' || toolName === 'write_file') && Boolean(toolArgs.path);
        if (isFileMutationTool && toolArgs.path) {
          await this.checkpointManager.recordPreEditFile(toolArgs.path);
        }

        this.renderer.startSpinner(`Executing ${toolName}...`);

        const durableResult = await this.toolDispatcher.dispatch(
          tool,
          toolArgs,
          this.context,
          call.id,
          { autoApprove: this.context.autoApprove }
        );

        this.renderer.stopSpinner();

        if (durableResult.status === 'validation_failed') {
          this.stats.failedToolCalls++;
          progress.failedToolCount++;
          progress.consecutiveToolFailures++;
          this.renderer.printError(durableResult.output);
          this.messages.push({
            role: 'tool',
            name: toolName,
            tool_call_id: call.id,
            content: durableResult.output
          });
          continue;
        }

        if (durableResult.status === 'permission_denied') {
          this.stats.failedToolCalls++;
          this.renderer.printError(durableResult.output);
          this.messages.push({
            role: 'tool',
            name: toolName,
            tool_call_id: call.id,
            content: durableResult.output
          });
          continue;
        }

        this.renderer.printToolResult(toolName, durableResult.output, durableResult.isError);

        let executionResult: { result: string; isError?: boolean } = {
          result: durableResult.output,
          isError: durableResult.isError
        };

        const fileContentChanged = Boolean(durableResult.fileChanges?.changed);
        if (fileContentChanged && toolArgs.path && durableResult.fileChanges?.contentBefore) {
          const beforeHash = crypto.createHash('md5').update(durableResult.fileChanges.contentBefore).digest('hex');
          const knownHashes = progress.fileContentHashes.get(toolArgs.path) || [];
          if (!knownHashes.includes(beforeHash)) knownHashes.push(beforeHash);
          if (knownHashes.length > 5) knownHashes.shift();
          progress.fileContentHashes.set(toolArgs.path, knownHashes);
        }
        // Only repository-inspection calls consume this budget. Shell commands are neither
        // source edits nor inspections, and must not disable the action gate.
        if (isPassiveTool(toolName)) readStepCount++;
        if (fileContentChanged) readStepCount = 0;

        const isCommandExitDiagnostic = toolName === 'run_command' && !executionResult.result.startsWith('Failed to execute command:');
        if (executionResult.isError) {
          this.stats.failedToolCalls++;
          progress.failedToolCount++;
          // Non-zero command exit codes (e.g. failing tests/lints) are diagnostic feedback, not tool execution crashes
          if (!isCommandExitDiagnostic) {
            progress.consecutiveToolFailures++;
          } else {
            progress.consecutiveToolFailures = 0;
          }

          if (toolName === 'edit_file' || toolName === 'write_file') {
            progress.singleFileObsession = false;
            if (toolArgs.path) progress.fileReadTurns.delete(toolArgs.path);
          }

          if (progress.consecutiveToolFailures >= (isCloud ? 10 : 5)) {
            this.renderer.printError(
              `Execution halted: ${progress.consecutiveToolFailures} consecutive tool execution errors encountered. Aborting turn to prevent token waste.`
            );
            shouldTerminateTurn = true;
            this.messages.push({
              role: 'tool',
              name: toolName,
              tool_call_id: call.id,
              content: executionResult.result
            });
            // Ensure any remaining calls in this batch also receive a tool result
            const currentIdx = toolCalls.indexOf(call);
            for (let j = currentIdx + 1; j < toolCalls.length; j++) {
              const skipped = toolCalls[j];
              this.messages.push({
                role: 'tool',
                name: skipped.function.name,
                tool_call_id: skipped.id,
                content: '[CANCELLED] Tool execution aborted due to preceding consecutive failures.'
              });
            }
            break;
          } else if (progress.consecutiveToolFailures >= 3) {
            executionResult.result += `\n\n[CIRCUIT BREAKER WARNING] ${progress.consecutiveToolFailures} consecutive tool actions have failed. Stop guessing tool arguments. Re-read the target file with 'view_file' or check directory paths before proceeding.`;
          }
        } else {
          this.stats.successfulToolCalls++;
          progress.successfulToolCount++;
          progress.consecutiveToolFailures = 0;

          if ((toolName === 'edit_file' || toolName === 'write_file') && toolArgs.path) {
            const editCount = (progress.fileEditCounts.get(toolArgs.path) || 0) + 1;
            progress.fileEditCounts.set(toolArgs.path, editCount);

            if (fileContentChanged) {
              hasModifiedCode = true;
              progress.filesModified.add(toolArgs.path);
              progress.singleFileObsession = false;
              progress.obsessedFilePath = '';
              progress.consecutiveCycleDetections = 0;
              this.stagnationDetector.resetRecoveryAttempts();
              this.recoveryController.resetRepetitionOnRealChange();
              // Reset repetition history only after a real source change, not a no-op write.
              progress.recentToolSignatures = [];
            } else {
              executionResult.result += `\n\n[NO-OP EDIT DETECTED] The operation succeeded but left \"${toolArgs.path}\" unchanged. This is not progress. Do not repeat the same edit/write; inspect the exact target or explain the blocker.`;
            }

            // Detect reversion to a previously observed content state via authoritative RecoveryController
            let isOscillation = false;
            try {
              const targetFullPath = path.resolve(this.context.cwd, toolArgs.path);
              const currentContent = await fs.readFile(targetFullPath, 'utf8');
              const oscResult = this.recoveryController.recordFileHash(toolArgs.path, currentContent);
              if (fileContentChanged && oscResult.isOscillation) isOscillation = true;
            } catch {}

            if (isOscillation) {
              this.renderer.printWarning(`Detected edit oscillation on "${toolArgs.path}" (file reverted to earlier state).`);
              executionResult.result += `\n\n[OSCILLATION WARNING] Your modification reverted "${toolArgs.path}" to an earlier state from this turn. You are thrashing between alternate versions. Run tests or inspect compiler output before editing this file again.`;
            }

            const maxEditChurn = isCloud ? 20 : 6;
            if (editCount > maxEditChurn) {
              this.renderer.printWarning(`High edit churn on "${toolArgs.path}" (${editCount} edits in single turn).`);
              executionResult.result += `\n\n[CHURN LIMIT REACHED] "${toolArgs.path}" has been modified ${editCount} times in this turn. Further blind edits are restricted. Please verify the code or finish the task.`;
            }

            // Bounded dynamic leash extension:
            // Extend only for productive, non-thrashing edits, capped strictly at ABSOLUTE_MAX_STEPS
            if (fileContentChanged && (isCloud || editCount <= 4) && safetyCeiling < ABSOLUTE_MAX_STEPS) {
              safetyCeiling = Math.min(stepCount + 15, ABSOLUTE_MAX_STEPS);
            }

            // Layer 3: Automated Linter / Compiler Self-Healing Loop with failure cap
            try {
              const lintResult = await CodeVerifier.runFastLint(this.context.cwd, toolArgs.path);
              if (!lintResult.passed && lintResult.errorOutput) {
                const fastLintFails = (progress.fastLintFailuresPerFile.get(toolArgs.path) || 0) + 1;
                progress.fastLintFailuresPerFile.set(toolArgs.path, fastLintFails);

                if (isCloud || fastLintFails <= 2) {
                  console.log(`${theme.branch}${theme.alert} ${theme.warning(`Auto-lint diagnostic: syntax/type issue in ${toolArgs.path} (\`${lintResult.command}\`)`)}`);
                  executionResult.result += `\n\n[AUTOMATED LINTER / TYPECHECK FEEDBACK]:\nYour modification to "${toolArgs.path}" introduced compiler/type diagnostics (\`${lintResult.command}\`):\n\`\`\`\n${lintResult.errorOutput}\n\`\`\`\nPlease inspect the diagnostic above and invoke 'edit_file' to resolve it on your next step.`;
                } else {
                  console.log(`${theme.branch}${theme.alert} ${theme.warning(`Auto-lint diagnostic limit reached for ${toolArgs.path} (${fastLintFails} failures)`)}`);
                  executionResult.result += `\n\n[AUTOMATED LINTER CEILING REACHED]:\nRepeated attempts (${fastLintFails}) to auto-heal compiler diagnostics in "${toolArgs.path}" have failed:\n\`\`\`\n${lintResult.errorOutput}\n\`\`\`\nDo not attempt further blind edits to this file. Explain the error or formulate an alternative approach.`;
                }
              } else {
                progress.fastLintFailuresPerFile.set(toolArgs.path, 0);
              }
            } catch {}
          }
        }

        let toolOutput = executionResult.result || '';

        // Record progress signal in StagnationDetector
        try {
          const wsFp = await StagnationDetector.computeWorkspaceFingerprint(this.context.cwd);
          const isErr = Boolean(executionResult.isError);
          const testOutcome = toolName === 'run_command'
            ? {
                passed: !isErr,
                errorSignature: StagnationDetector.extractErrorSignature(toolOutput),
                command: toolArgs.command || toolArgs.cmd
              }
            : undefined;

          this.stagnationDetector.recordStep({
            turn: stepCount,
            toolCallId: call.id || `tc-${stepCount}-${this.stats.toolCalls}`,
            normalizedTool: toolName,
            normalizedArgs: StagnationDetector.normalizeArguments(toolArgs),
            resultFingerprint: StagnationDetector.fingerprintResult(toolOutput, isErr),
            workspaceFingerprint: wsFp,
            isError: isErr,
            testOutcome,
            telemetry: {
              promptTokens: outcome.usage?.promptTokens,
              completionTokens: outcome.usage?.completionTokens,
              totalTokens: outcome.usage?.totalTokens,
              stopReason: outcome.stopReason
            }
          });

          // If run_command executed a verification or test command, sync state with ContextEngine
          if (toolName === 'run_command' && toolArgs.command) {
            const cmd = String(toolArgs.command).trim();
            const isVerifCmd = /^(python\s+-m\s+py_compile|pytest|npm\s+test|npx\s+tsc|tsc|cargo\s+test|go\s+test)/i.test(cmd);
            if (isVerifCmd) {
              this.contextEngine.recordVerificationResult(!isErr, cmd, isErr ? toolOutput : undefined, isErr ? 'failed' : 'passed');
              if (!isErr && !toolOutput.trim()) {
                // Ensure empty clean output explicitly confirms success so local models do not guess or re-verify
                toolOutput = `[Command \`${cmd}\` exited cleanly with status code 0 and 0 errors. Verification passed. Please formulate your final response to complete the task.]`;
              }
            }
          }
        } catch {}

        // Ingest-time safety ceiling: on 262k/large contexts, allow up to 40,000 characters (~10,000 tokens)
        // so full multi-file views and stack traces are ingested intact without premature truncation.
        const MAX_TOOL_INGEST_CHARS = this.context.numCtx && this.context.numCtx >= 65536 ? 40000 : 4000;
        if (toolOutput.length > MAX_TOOL_INGEST_CHARS) {
          toolOutput = this.contextEngine.compactToolOutput(toolOutput, MAX_TOOL_INGEST_CHARS);
        }

        this.messages.push({
          role: 'tool',
          name: toolName,
          tool_call_id: call.id,
          content: toolOutput
        });
      }

      if (shouldTerminateTurn) {
        break;
      }
    }

    const lastMessage = this.messages[this.messages.length - 1];
    const endedWithFinalAssistantText = lastMessage?.role === 'assistant' && !lastMessage.tool_calls;
    if (stepCount >= safetyCeiling && !endedWithFinalAssistantText) {
      const stopReport = `[EXECUTION STOPPED: STEP CEILING] Locode reached its ${safetyCeiling}-step safety ceiling without producing a normal completion. Further tool execution was halted to prevent a runaway loop. Review the latest tool results and unresolved task state before retrying.`;
      this.renderer.printWarning(`Safety ceiling reached (${safetyCeiling} steps) to prevent runaway execution.`);
      this.renderer.printAssistantMessage(stopReport);
      this.messages.push({ role: 'assistant', content: stopReport });
    }
  }
}
