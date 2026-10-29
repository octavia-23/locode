import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import { theme } from '../ui/theme.js';
import { AgentContext, ChatMessage } from '../types.js';
import { allTools, toolRegistry, registerDynamicTool, unregisterDynamicTools } from '../tools/index.js';
import { redactSecrets, redactSecretsFromMessages } from '../utils/secret-redactor.js';
import { ILLMProvider, getModelCapabilities } from '../providers/types.js';
import { createLLMProvider, isCloudProvider, resolveProvider } from '../providers/factory.js';
import { estimateUsageCost, estimatePreflightCost, reconcileUsageCost } from '../runtime/pricing.js';
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
import { ExecutionJournal } from '../journal/journal.js';
import { JournalRecoveryManager, RecoveryInspectionReport } from '../journal/recovery.js';
import { SessionRunner } from '../engine/session-runner.js';
import { TurnExecutor, isReadOnlyTool, NormalizedGeneration, GenerationOutcomeType, TurnBatchProgressTracker as ProgressTracker } from '../engine/turn-executor.js';
import { RepairCoordinator } from '../engine/repair-coordinator.js';

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

export type { GenerationOutcomeType, NormalizedGeneration, TurnBatchProgressTracker as ProgressTracker } from '../engine/turn-executor.js';

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
  private journal: ExecutionJournal;
  private sessionRunner: SessionRunner;
  private repairCoordinator: RepairCoordinator;
  private turnExecutor: TurnExecutor;
  private pendingPromptRefresh: Promise<void> | null = null;

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
    this.journal = new ExecutionJournal({ cwd: context.cwd });
    this.sessionRunner = new SessionRunner(context.cwd, this.journal, this.sessionMemory);

    const isCloud = isCloudProvider(this.context.provider);
    const defaultThresholds = isCloud ? CLOUD_STAGNATION_THRESHOLDS : DEFAULT_STAGNATION_THRESHOLDS;
    this.stagnationDetector = new StagnationDetector({ ...defaultThresholds, ...context.stagnationThresholds });
    this.repairCoordinator = new RepairCoordinator(context.cwd, this.checkpointManager, this.stagnationDetector);

    this.executionProfile = resolveExecutionProfile(isCloud);
    this.permissionEngine = new PermissionEngine({
      autoApprove: this.context.autoApprove,
      allowNetwork: this.executionProfile.privacyPolicy.allowWebAccess
    });
    this.toolDispatcher = new ToolDispatcher(
      this.permissionEngine,
      {
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
      },
      this.journal
    );
    this.turnExecutor = new TurnExecutor(
      this.toolDispatcher,
      this.permissionEngine,
      this.journal,
      this.renderer,
      this.checkpointManager
    );
    this.recoveryController = new RecoveryController(
      this.stagnationDetector,
      isCloud ? 10 : 5
    );
  }

  getJournal(): ExecutionJournal {
    return this.journal;
  }

  getSessionRunner(): SessionRunner {
    return this.sessionRunner;
  }

  getRepairCoordinator(): RepairCoordinator {
    return this.repairCoordinator;
  }

  getTurnExecutor(): TurnExecutor {
    return this.turnExecutor;
  }

  /**
   * Resumes an interrupted task from the durable execution journal.
   * Performs workspace hash verification and reconciles interrupted tool calls safely.
   */
  async resumeTask(): Promise<RecoveryInspectionReport> {
    const recoveryManager = new JournalRecoveryManager(this.context.cwd, this.journal.getJournalDir());
    const report = await recoveryManager.inspectWorkspaceAndJournal();

    if (report.canSafelyResume) {
      await recoveryManager.applyRecoveryToAgent(this, report);
      this.renderer.printSuccess(
        `[Durable Journal Resume] Restored previous task: "${report.snapshot?.objective || 'unspecified'}"`
      );
      if (report.reconciledTools.length > 0) {
        this.renderer.printWarning(
          `Reconciled ${report.reconciledTools.length} tool calls (${report.reconciledTools.filter(t => t.resolution === 'applied_verified').length} verified edits on disk, 0 duplicated side effects).`
        );
      }
    } else if (report.hasJournal) {
      this.renderer.printWarning(
        `[Durable Journal Warning] Cannot automatically resume task: ${report.reason || 'Uncertain state detected.'}`
      );
      for (const rec of report.reconciledTools.filter(t => t.requiresUserConfirmation)) {
        this.renderer.printWarning(`- ${rec.toolName} (${rec.toolCallId}): ${rec.details}`);
      }
      for (const div of report.divergences) {
        this.renderer.printError(`- ${div}`);
      }
    }

    return report;
  }

  getState(): ExecutionState {
    return this.state;
  }

  getExecutionProfile(): HarnessExecutionProfile {
    return this.executionProfile;
  }

  private async refreshSystemPrompt(): Promise<void> {
    if (this.messages.length > 0 && this.messages[0].role === 'system') {
      const isCloud = isCloudProvider(this.context.provider);
      const allowFullRepo = this.executionProfile.privacyPolicy.allowFullRepoContext;
      try {
        const prompt = await buildSystemPrompt(this.context.cwd, isCloud, allowFullRepo);
        if (this.messages[0]?.role === 'system') {
          this.messages[0].content = prompt;
        }
      } catch {}
    }
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

    // Coherent transition: update permission engine network and approval policies
    this.permissionEngine.setPolicy({
      allowNetwork: this.executionProfile.privacyPolicy.allowWebAccess,
      autoApprove: this.context.autoApprove
    });

    // Synchronize system prompt with updated privacy settings
    this.pendingPromptRefresh = this.refreshSystemPrompt();
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
    await this.journal.init();
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
      this.recoveryController = new RecoveryController(this.stagnationDetector, isCloud ? 10 : 5);
      this.executionProfile = resolveExecutionProfile(isCloud);
      this.permissionEngine.setPolicy({
        allowNetwork: this.executionProfile.privacyPolicy.allowWebAccess,
        autoApprove: this.context.autoApprove
      });
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
      this.permissionEngine.setPolicy({
        allowNetwork: this.executionProfile.privacyPolicy.allowWebAccess,
        autoApprove: this.context.autoApprove
      });
      this.pendingPromptRefresh = this.refreshSystemPrompt();
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
  public normalizeResponse(response: any, rawError?: any): NormalizedGeneration {
    return TurnExecutor.normalizeResponse(response, rawError);
  }

  async step(userInput?: string): Promise<NormalizedGeneration> {
    if (this.pendingPromptRefresh) {
      await this.pendingPromptRefresh;
      this.pendingPromptRefresh = null;
    }

    if (this.messages.length === 0) {
      await this.init();
    }

    if (userInput) {
      const { processedPrompt, injectedFiles } = await resolveFileMentions(userInput, this.context.cwd);
      if (injectedFiles.length > 0) {
        this.renderer.printMentionedFiles(injectedFiles);
      }
      this.contextEngine.setObjective(userInput);
      this.messages.push({
        role: 'user',
        content: processedPrompt
      });
    }

    let activeTools = allTools;
    if (!this.executionProfile.privacyPolicy.allowWebAccess) {
      activeTools = activeTools.filter(t => t.name !== 'fetch_web' && t.name !== 'search_web');
    }

    const outgoingMessages = this.prepareMessagesForProvider(this.messages);
    const chatOpts: import('../providers/types.js').ChatOptions = {
      signal: this.context.signal
    };
    if (this.context.maxOutputTokens) {
      chatOpts.maxTokens = this.context.maxOutputTokens;
    }

    let rawResponse: any;
    let rawError: any;
    try {
      rawResponse = await this.provider.chat(outgoingMessages, activeTools, undefined, chatOpts);
    } catch (err: any) {
      rawError = err;
    }

    const outcome = this.normalizeResponse(rawResponse, rawError);

    if (outcome.toolCalls && outcome.toolCalls.length > 0) {
      this.messages.push({
        role: 'assistant',
        content: outcome.cleanedText || '',
        tool_calls: outcome.toolCalls
      });

      const batchOutcome = await this.turnExecutor.executeTurnBatch(
        outcome.toolCalls,
        this.context,
        {
          profile: this.executionProfile,
          signal: this.context.signal,
          checkpointManager: this.checkpointManager,
          renderer: this.renderer,
          stagnationDetector: this.stagnationDetector,
          recoveryController: this.recoveryController,
          contextEngine: this.contextEngine
        }
      );

      for (const msg of batchOutcome.toolMessages) {
        this.messages.push(msg);
      }
    } else if (outcome.type === 'TEXT_FINAL' || !outcome.toolCalls || outcome.toolCalls.length === 0) {
      this.messages.push({
        role: 'assistant',
        content: outcome.rawContent || ''
      });
    }

    return outcome;
  }

  async run(userInput: string) {
    if (this.pendingPromptRefresh) {
      await this.pendingPromptRefresh;
      this.pendingPromptRefresh = null;
    }

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

    await this.journal.init();
    await this.journal.recordEvent('task_started', {
      objective: userInput,
      model: this.context.model,
      provider: this.context.provider,
      executionProfile: this.executionProfile,
      cwd: this.context.cwd
    });

    this.messages.push({
      role: 'user',
      content: processedPrompt
    });

    // Adaptive execution budget governed by active HarnessExecutionProfile:
    // Strictly bounded by ABSOLUTE_MAX_STEPS to prevent runaway loops.
    const isCloud = isCloudProvider(this.context.provider);
    const ABSOLUTE_MAX_STEPS = isCloud ? 250 : 120;
    let safetyCeiling = Math.min(this.executionProfile.safetyCeiling, ABSOLUTE_MAX_STEPS);
    let stepCount = 0;
    let readStepCount = 0;
    let hasModifiedCode = false;
    let repairAttempts = 0;
    const maxRepairAttempts = 3;
    let turnCost = 0;
    let endedWithFinalAssistantText = false;

    // Whole-task timeout enforcement from active execution profile
    const profileTimeoutMs = this.executionProfile.timeoutMs;
    const taskAbortController = new AbortController();
    let taskTimeoutTimer: NodeJS.Timeout | undefined;
    if (profileTimeoutMs > 0) {
      taskTimeoutTimer = setTimeout(() => {
        taskAbortController.abort(new Error(`Task timeout: Exceeded execution profile timeout of ${profileTimeoutMs}ms`));
      }, profileTimeoutMs);
    }

    const effectiveSignal = this.context.signal
      ? AbortSignal.any([this.context.signal, taskAbortController.signal])
      : taskAbortController.signal;

    try {

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

    const taskRequestsModification = /\b(add|fix|edit|modify|update|change|create|implement|style|improve|refactor|remove|delete|write|build|setup|redesign)\b/i.test(userInput);

    while (stepCount < safetyCeiling) {
      if (effectiveSignal.aborted) {
        this.renderer.printWarning('Execution cancelled or timed out.');
        break;
      }
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
      const shouldForceMutationTools = this.executionProfile.forceMutationAfterReads &&
        taskRequestsModification &&
        !lastVerifPassed &&
        (Boolean(progress.singleFileObsession) || readStepCount >= this.executionProfile.maxExplorationReads);

      let activeTools = allTools;
      if (!this.executionProfile.privacyPolicy.allowWebAccess) {
        activeTools = activeTools.filter(t => t.name !== 'fetch_web' && t.name !== 'search_web');
      }
      if (lastVerifPassed) {
        // A passed verification belongs to the current file contents. Expose no tools:
        // post-verification edits or shell commands would invalidate the result.
        activeTools = [];
      } else if (shouldForceMutationTools) {
        activeTools = activeTools.filter(t => t.name === 'edit_file' || t.name === 'write_file');
      }

      this.renderer.startSpinner(`thinking (${this.context.model})...`);

      let rawResponse: any;
      let rawError: any;
      let streamedTokens = 0;
      const modelCaps = getModelCapabilities(this.provider);
      const chatOpts: import('../providers/types.js').ChatOptions = {
        signal: effectiveSignal,
        timeoutMs: Math.min(profileTimeoutMs || 120000, 120000)
      };
      if (this.context.maxOutputTokens) {
        chatOpts.maxTokens = this.context.maxOutputTokens;
      }
      if (lastVerifPassed) chatOpts.toolChoice = 'none';

      // enableThinking: map to supported provider options only when the selected model supports them
      if (this.executionProfile.enableThinking && modelCaps.supportsThinking) {
        chatOpts.thinking = { type: 'enabled', budget_tokens: this.context.reasoningBudget || 2048 };
      }

      if (progress.consecutiveCycleDetections > 0 || this.stagnationDetector.getRecoveryAttempts() > 0) {
        chatOpts.temperature = 0.35;
        chatOpts.repeatPenalty = 1.18;
        chatOpts.frequencyPenalty = 0.25;
        chatOpts.presencePenalty = 0.15;
      }

      // Pre-flight spending control: evaluate conservative projected request cost BEFORE dispatching
      const outgoingMessages = this.prepareMessagesForProvider(compacted);
      const estPromptTokens = this.contextEngine.estimateMessagesTokens(outgoingMessages);
      let requestedOutputTokens = chatOpts.maxTokens || modelCaps.defaultOutputTokens || 4096;
      let preflightCost = estimatePreflightCost(
        estPromptTokens,
        requestedOutputTokens,
        turnCost,
        this.context.model,
        this.context.provider,
        this.executionProfile.costPolicy.maxCostPerTurn
      );

      // Reduce output allowance when prospective request would exceed budget (Requirement B.3)
      if (preflightCost.isKnown && preflightCost.isExceeded) {
        if (preflightCost.canReduceOutputAllowance && preflightCost.maxAllowableOutputTokens) {
          const originalTokens = requestedOutputTokens;
          chatOpts.maxTokens = preflightCost.maxAllowableOutputTokens;
          this.renderer.printWarning(
            `[Cost Control] Reduced output allowance from ${originalTokens} to ${chatOpts.maxTokens} tokens to fit within turn budget ($${this.executionProfile.costPolicy.maxCostPerTurn?.toFixed(2)}).`
          );
          preflightCost = estimatePreflightCost(
            estPromptTokens,
            chatOpts.maxTokens,
            turnCost,
            this.context.model,
            this.context.provider,
            this.executionProfile.costPolicy.maxCostPerTurn
          );
        }
      }

      await this.journal.recordEvent('model_request_started', {
        turn: stepCount,
        messageCount: outgoingMessages.length,
        estimatedPromptTokens: estPromptTokens,
        bufferedPromptTokens: preflightCost.bufferedPromptTokens,
        projectedCost: preflightCost.projectedTurnCost
      });

      // Stop before sending a request that cannot fit within configured budget (Requirements B.3 & B.4)
      if (preflightCost.isKnown && preflightCost.isExceeded) {
        let overrideApproved = false;
        if (this.context.interactive !== false && this.toolDispatcher) {
          overrideApproved = await this.toolDispatcher.requestApproval(
            'budget_limit',
            { projectedCost: preflightCost.projectedTurnCost, maxCostPerTurn: this.executionProfile.costPolicy.maxCostPerTurn },
            `Projected turn cost ($${preflightCost.projectedTurnCost?.toFixed(4)}) exceeds configured turn limit ($${this.executionProfile.costPolicy.maxCostPerTurn?.toFixed(2)}). Authorize request?`
          );
        }

        if (!overrideApproved) {
          this.renderer.printError(`[Pre-Flight Spending Block]: ${preflightCost.reason}`);
          this.messages.push({
            role: 'assistant',
            content: `[EXECUTION BLOCKED: PRE-FLIGHT COST LIMIT] ${preflightCost.reason}`
          });
          await this.journal.recordEvent('task_failed', {
            error: `Pre-flight cost limit exceeded: ${preflightCost.reason}`,
            consecutiveFailures: 1
          });
          break;
        }
      }

      try {
        rawResponse = await this.provider.chat(
          outgoingMessages,
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

      // Reconcile estimates against actual reported usage after each request (Requirement B.6)
      const reconciled = reconcileUsageCost(
        preflightCost,
        outcome.usage,
        turnCost,
        this.context.model,
        this.context.provider
      );

      await this.journal.recordEvent('model_response_received', {
        turn: stepCount,
        stopReason: outcome.stopReason,
        usage: outcome.usage ? {
          promptTokens: outcome.usage.promptTokens,
          completionTokens: outcome.usage.completionTokens,
          totalTokens: outcome.usage.totalTokens
        } : undefined,
        reconciledCost: reconciled.actualCost,
        costVariance: reconciled.variance,
        proposedToolCallsCount: outcome.toolCalls?.length || 0,
        hasTextContent: Boolean(outcome.cleanedText)
      });

      // Accumulate usage telemetry and enforce CostPolicy
      if (outcome.usage) {
        this.stats.turns++;
        this.stats.totalTokens += outcome.usage.totalTokens;
        this.stats.promptTokens += outcome.usage.promptTokens;
        this.stats.completionTokens += outcome.usage.completionTokens;
        this.stats.totalDurationMs += outcome.usage.durationMs;

        if (reconciled.isKnown) {
          turnCost = reconciled.reconciledTurnCost;
          if (this.executionProfile.costPolicy.alertOnCostThreshold && turnCost >= 0.5) {
            this.renderer.printWarning(`[Cost Alert] Turn cost reached $${turnCost.toFixed(4)}.`);
          }
          if (this.executionProfile.costPolicy.requireConfirmationAboveCost && turnCost >= this.executionProfile.costPolicy.requireConfirmationAboveCost) {
            if (this.context.interactive !== false && this.toolDispatcher) {
              const approved = await this.toolDispatcher.requestApproval('cost_limit', { turnCost }, `Estimated turn cost $${turnCost.toFixed(4)} exceeds confirmation threshold ($${this.executionProfile.costPolicy.requireConfirmationAboveCost})`);
              if (!approved) {
                this.renderer.printWarning(`Turn execution halted: Cost confirmation declined by user ($${turnCost.toFixed(4)}).`);
                break;
              }
            }
          }
          if (this.executionProfile.costPolicy.maxCostPerTurn && turnCost >= this.executionProfile.costPolicy.maxCostPerTurn) {
            this.renderer.printError(`[Cost Exceeded] Turn cost $${turnCost.toFixed(4)} exceeded maximum allowed cost per turn ($${this.executionProfile.costPolicy.maxCostPerTurn}). Halting turn.`);
            this.messages.push({
              role: 'assistant',
              content: `[EXECUTION HALTED: COST CEILING] The turn exceeded the maximum cost budget of $${this.executionProfile.costPolicy.maxCostPerTurn.toFixed(2)} ($${turnCost.toFixed(4)} spent).`
            });
            break;
          }
        }
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

        // Push assistant turn message ONCE before entering repair / verification branches
        this.messages.push({
          role: 'assistant',
          content: outcome.rawContent || ''
        });

        // Autonomous Verification & Self-Repair Gate
        if (hasModifiedCode && this.repairCoordinator.getRepairAttempts() < maxRepairAttempts) {
          this.renderer.startSpinner('Running automated verification & health check...');
          this.stats.verificationRuns++;
          const repairResult = await this.repairCoordinator.runVerificationAndDiagnosis(
            userInput,
            stepCount,
            this.messages,
            this.context,
            this.provider,
            this.journal
          );
          this.renderer.stopSpinner();

          if (repairResult.vResult) {
            this.contextEngine.recordVerificationResult(
              repairResult.passed,
              repairResult.vResult.command || 'verify',
              repairResult.vResult.errorOutput,
              repairResult.vResult.status
            );
          }

          if (repairResult.status === 'passed') {
            if (repairResult.vResult?.command) {
              this.renderer.printSuccess(`Verification passed: \`${repairResult.vResult.command}\` exited with 0 errors.`);
            }
          } else if (repairResult.status === 'inconclusive') {
            if (repairResult.vResult?.command) {
              this.renderer.printWarning(`Verification inconclusive for \`${repairResult.vResult.command}\`: ${repairResult.vResult.reason || 'Execution timed out'}`);
            }
          } else if (repairResult.status === 'stagnation_halt') {
            this.stats.progressLoopsDetected++;
            this.stats.recoveries++;
            this.renderer.printWarning(
              `Terminating: test failure stagnation limit exceeded. Halting cleanly with evidence.`
            );
            this.messages.push({
              role: 'user',
              content: `[VERIFICATION STAGNATION TERMINATION]\n${repairResult.reason || 'Verification failure stagnation limit exceeded.'}\nUnresolved blocker: ${repairResult.vResult?.errorOutput?.slice(0, 500)}`
            });
            break;
          } else if (repairResult.status === 'architect_escalated') {
            this.stats.progressLoopsDetected++;
            const archModel = this.context.architectModel || this.context.model;
            this.renderer.printWarning(`escalating to architect mode (${archModel}) for diagnosis...`);
            console.log(`\n  ${theme.strong('architect directive:')}\n  ${theme.muted(repairResult.architectDiagnosis || '')}\n`);
            this.messages.push({
              role: 'user',
              content: repairResult.feedbackDirective || '[ARCHITECT REPAIR DIRECTIVE]'
            });
            continue;
          } else if (repairResult.status === 'repair_feedback') {
            this.renderer.printWarning(
              `self-repair [attempt ${this.repairCoordinator.getRepairAttempts()}/${maxRepairAttempts}]: \`${repairResult.vResult?.command}\` failed. feeding error trace to model...`
            );
            this.messages.push({
              role: 'user',
              content: repairResult.feedbackDirective || '[VERIFICATION FAILED]'
            });
            continue;
          }
        }

        // Clean completion
        const estTokens = this.contextEngine.estimateMessagesTokens(this.messages);
        const maxTokens = this.contextEngine.getMaxTokens();
        this.renderer.printTelemetry(outcome.usage, {
          usedTokens: estTokens,
          maxTokens: maxTokens
        });

        // Save session memory for instant recall next time
        const checkpointSummary = this.contextEngine.getLatestCheckpoint();
        await this.sessionMemory.saveSession({
          model: this.context.model,
          messages: this.messages,
          lastDecisions: this.contextEngine.getTaskState().decisions,
          recentFiles: this.contextEngine.getTaskState().relevantFiles,
          summary: outcome.rawContent,
          checkpoint: checkpointSummary
        });

        await this.journal.recordEvent('task_completed', {
          finalStatus: 'success',
          totalTurns: stepCount,
          totalToolCalls: this.stats.toolCalls,
          summary: outcome.rawContent
        });
        await this.journal.createSnapshot({
          pendingObjectives: this.contextEngine.getTaskState().pendingObjectives,
          completedObjectives: this.contextEngine.getTaskState().completedObjectives,
          decisions: this.contextEngine.getTaskState().decisions,
          checkpoint: checkpointSummary
        });
        break;
      }

      // Outcome D: Tool Calls
      const toolCalls = outcome.toolCalls;

      // Persist model's tool-call proposals BEFORE performing side effects (Phase 2 requirement)
      for (const call of toolCalls) {
        await this.journal.recordEvent('tool_call_proposed', {
          toolCallId: call.id || `call_${Date.now()}`,
          toolName: call.function.name,
          arguments: call.function.arguments || {}
        }, call.id);
      }

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

      // Delegate tool batch execution to TurnExecutor
      const batchOutcome = await this.turnExecutor.executeTurnBatch(toolCalls, this.context, {
        profile: this.executionProfile,
        progress,
        stepCount,
        userInput,
        hasModifiedCode,
        readStepCount,
        safetyCeiling,
        signal: effectiveSignal,
        usage: outcome.usage,
        stopReason: outcome.stopReason,
        checkpointManager: this.checkpointManager,
        renderer: this.renderer,
        stagnationDetector: this.stagnationDetector,
        recoveryController: this.recoveryController,
        contextEngine: this.contextEngine
      });

      hasModifiedCode = batchOutcome.hasModifiedCode;
      readStepCount = batchOutcome.readStepCount;
      safetyCeiling = batchOutcome.safetyCeiling;
      this.stats.toolCalls += batchOutcome.toolCallsCount;
      this.stats.successfulToolCalls += batchOutcome.successfulToolCalls;
      this.stats.failedToolCalls += batchOutcome.failedToolCalls;

      for (const msg of batchOutcome.toolMessages) {
        this.messages.push(msg);
      }

      if (batchOutcome.shouldTerminateTurn) {
        break;
      }
    }

    const lastMessage = this.messages[this.messages.length - 1];
    endedWithFinalAssistantText = Boolean(lastMessage?.role === 'assistant' && !lastMessage.tool_calls);
    if (stepCount >= safetyCeiling && !endedWithFinalAssistantText) {
      const stopReport = `[EXECUTION STOPPED: STEP CEILING] Locode reached its ${safetyCeiling}-step safety ceiling without producing a normal completion. Further tool execution was halted to prevent a runaway loop. Review the latest tool results and unresolved task state before retrying.`;
      this.renderer.printWarning(`Safety ceiling reached (${safetyCeiling} steps) to prevent runaway execution.`);
      this.renderer.printAssistantMessage(stopReport);
      this.messages.push({ role: 'assistant', content: stopReport });
    }
  } finally {
    if (taskTimeoutTimer) clearTimeout(taskTimeoutTimer);
    if (this.journal.getSnapshot().taskState === 'running') {
      const isInterrupted = effectiveSignal?.aborted || (stepCount >= safetyCeiling && !endedWithFinalAssistantText);
      if (isInterrupted) {
        await this.journal.recordEvent('task_interrupted', {
          reason: effectiveSignal?.aborted ? 'Aborted by signal' : 'Safety ceiling reached',
          lastSequence: this.journal.getSnapshot().lastSeq,
          interruptedToolCalls: []
        }).catch(() => {});
      }
    }
  }
}
}
