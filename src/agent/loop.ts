import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import { theme } from '../ui/theme.js';
import { AgentContext, ChatMessage } from '../types.js';
import { allTools, toolRegistry } from '../tools/index.js';
import { ILLMProvider } from '../providers/types.js';
import { createLLMProvider } from '../providers/factory.js';
import { ContextEngine } from './context.js';
import { TerminalRenderer } from '../ui/renderer.js';
import { buildSystemPrompt } from './prompt.js';
import { CheckpointManager } from '../git/checkpoint.js';
import { resolveFileMentions } from './mentions.js';
import { MCPManager } from '../mcp/manager.js';
import { CodeVerifier } from './verifier.js';
import { ArchitectEngine } from './architect.js';
import { SessionMemory } from './memory.js';

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
  const len = signatures.length;
  if (len < 4) return { detected: false, period: 0, repetitions: 0, summary: '' };

  for (let p = 1; p <= 4; p++) {
    const minReps = p === 1 ? 4 : (p === 2 ? 3 : 2);
    const requiredLen = p * minReps;
    if (len < requiredLen) continue;

    const pattern = signatures.slice(len - p);
    let allMatch = true;

    for (let rep = 1; rep < minReps; rep++) {
      for (let i = 0; i < p; i++) {
        if (signatures[len - (rep + 1) * p + i] !== pattern[i]) {
          allMatch = false;
          break;
        }
      }
      if (!allMatch) break;
    }

    if (allMatch) {
      const summary = pattern.map(s => s.split(':')[0]).join(' → ');
      return { detected: true, period: p, repetitions: minReps, summary };
    }
  }

  return { detected: false, period: 0, repetitions: 0, summary: '' };
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

  constructor(context: AgentContext, renderer: TerminalRenderer, customProvider?: ILLMProvider) {
    this.context = context;
    this.renderer = renderer;
    this.provider = customProvider || createLLMProvider(context);
    this.contextEngine = new ContextEngine(context.numCtx || 8192, context.cwd);
    this.context.contextEngine = this.contextEngine;
    this.checkpointManager = new CheckpointManager(context.cwd);
    this.mcpManager = new MCPManager(context.cwd);
    this.sessionMemory = new SessionMemory(context.cwd);
  }

  async init() {
    this.messages = [{
      role: 'system',
      content: await buildSystemPrompt(this.context.cwd)
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
      toolRegistry.set(tool.name, tool);
      if (!allTools.some(t => t.name === tool.name)) {
        allTools.push(tool);
      }
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
    await this.mcpManager.closeAll();
  }

  setContext(context: Partial<AgentContext>) {
    this.context = { ...this.context, ...context };
    if (context.model) {
      this.provider.setModel(context.model);
    }
    if (context.numCtx) {
      if (this.provider.setNumCtx) {
        this.provider.setNumCtx(context.numCtx);
      }
      this.contextEngine.setMaxTokens(context.numCtx);
    }
    this.context.contextEngine = this.contextEngine;
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
    this.messages = [{
      role: 'system',
      content: await buildSystemPrompt(this.context.cwd)
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
   * Generates a clean Conventional Commit message based on git diff
   */
  async generateCommitMessage(diffText: string): Promise<string> {
    const prompt = `Based on the following git diff, generate a concise Conventional Commit message (e.g. "feat: add user auth" or "fix(parser): handle empty strings"). Output ONLY the commit message without any quotes or explanations.\n\nGit diff:\n${diffText.slice(0, 4000)}`;

    try {
      const res = await this.provider.chat([
        { role: 'user', content: prompt }
      ], []);
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
          }
        };
      });
    }

    // Clean text by stripping embedded tool call tags/blocks
    let cleanedText = content.trim();
    if (formattedToolCalls && formattedToolCalls.length > 0) {
      cleanedText = cleanedText
        .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
        .replace(/```(?:json)?\s*\{\s*"name"\s*:\s*"[^"]+".*?\}\s*```/gis, '')
        .trim();
    }

    const isJustJson = (cleanedText.startsWith('{') && cleanedText.endsWith('}')) ||
                       (cleanedText.startsWith('<tool_call>') && cleanedText.endsWith('</tool_call>'));
    if (isJustJson && (!formattedToolCalls || formattedToolCalls.length === 0)) {
      // Check if text was a malformed tool call attempt
      try {
        const parsed = JSON.parse(cleanedText);
        if (parsed.name) {
          formattedToolCalls = [{
            id: `call_${Date.now()}_0`,
            type: 'function',
            function: {
              name: parsed.name,
              arguments: parsed.arguments || {}
            }
          }];
          cleanedText = '';
        }
      } catch {}
    }

    if (formattedToolCalls && formattedToolCalls.length > 0) {
      return {
        type: 'TOOL_CALLS',
        rawContent: content,
        cleanedText: isJustJson ? '' : cleanedText,
        toolCalls: formattedToolCalls,
        usage: response.usage
      };
    }

    // If completely empty or whitespace only
    if (!content.trim()) {
      return {
        type: 'EMPTY_RESPONSE',
        rawContent: '',
        cleanedText: '',
        usage: response.usage
      };
    }

    return {
      type: 'TEXT_FINAL',
      rawContent: content,
      cleanedText: isJustJson ? '' : cleanedText,
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
    // while researching code. Strictly bounded by ABSOLUTE_MAX_STEPS (60) to prevent infinite loops.
    let safetyCeiling = 45;
    const ABSOLUTE_MAX_STEPS = 60;
    let stepCount = 0;
    let readStepCount = 0;
    let mutationStepCount = 0;
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
          const digest = await this.provider.chat(preFoldTurn, [], undefined, { toolChoice: 'none' });
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
      const compacted = this.contextEngine.compactMessages(this.messages, synthesizedFindings);
      if (compacted !== this.messages) {
        this.messages = compacted;
      }

      // AGGRESSIVE AUTONOMOUS ACTION GATE:
      // If the model has completed 2+ exploration calls without editing code,
      // temporarily withdraw passive read tools so the ONLY available actions are edit_file, write_file, and run_command!
      // This makes it physically impossible for the local model to procrastinate or get stuck in read loops.
      const shouldForceMutationTools = readStepCount >= 2 && mutationStepCount === 0;
      const activeTools = shouldForceMutationTools
        ? allTools.filter(t => t.name === 'edit_file' || t.name === 'write_file' || t.name === 'run_command')
        : allTools;

      this.renderer.startSpinner(`thinking (${this.context.model})...`);

      let rawResponse: any;
      let rawError: any;
      let streamedTokens = 0;
      try {
        rawResponse = await this.provider.chat(compacted, activeTools, (token) => {
          streamedTokens++;
          if (streamedTokens === 1) {
            this.renderer.startSpinner(`generating (${this.context.model})...`);
          } else if (streamedTokens % 15 === 0) {
            this.renderer.startSpinner(`generating (${this.context.model} · ${streamedTokens} tokens)...`);
          }
        });
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
          this.renderer.printWarning(`Model connection interrupted (${outcome.errorMessage}). Retrying (${progress.consecutiveNoProgressCount}/3)...`);
          await new Promise(r => setTimeout(r, 1000));
          continue;
        } else {
          this.renderer.printError(`Model request failed: ${outcome.errorMessage}`);
          break;
        }
      }

      // Outcome B: Empty / Quiet Generation Recovery
      if (outcome.type === 'EMPTY_RESPONSE') {
        progress.consecutiveEmptyResponses++;
        this.stats.emptyGenerations++;

        if (progress.consecutiveEmptyResponses <= 3) {
          this.stats.recoveries++;
          this.renderer.printWarning(
            `Model generated an empty response without tool calls. Issuing bounded continuation directive (${progress.consecutiveEmptyResponses}/3)...`
          );

          const lastToolMsg = [...this.messages].reverse().find(m => m.role === 'tool');
          const recoveryPrompt = `[CONTINUATION INSTRUCTION]
Your previous response contained no text or tool actions.
Current Objective: ${userInput}
${lastToolMsg ? `Most recent tool outcome: ${typeof lastToolMsg.content === 'string' ? lastToolMsg.content.slice(0, 300) : ''}` : ''}
Please proceed with the next tool call (e.g., view_file, edit_file, run_command) to complete the task, or provide your final answer if finished.`;

          this.messages.push({
            role: 'user',
            content: recoveryPrompt
          });
          continue;
        } else {
          this.renderer.printError('Model returned empty responses repeatedly without progressing. Terminating turn cleanly.');
          break;
        }
      }

      // Reset empty response counter on productive generation
      progress.consecutiveEmptyResponses = 0;

      // Print assistant textual thoughts if available
      if (outcome.cleanedText) {
        this.renderer.printAssistantMessage(outcome.cleanedText);
      }

      // Outcome C: Text Only (No Tool Calls Requested)
      if (outcome.type === 'TEXT_FINAL' || !outcome.toolCalls || outcome.toolCalls.length === 0) {
        // Anti-Procrastination Nudge: If user requested code modification, but model only returned text without edits
        if (!hasModifiedCode && readStepCount >= 1 && !progress.actionNudgeGiven) {
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

          this.contextEngine.recordVerificationResult(vResult.passed, vResult.command || 'verify', vResult.errorOutput);

          if (!vResult.passed) {
            repairAttempts++;

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
          } else if (vResult.command) {
            this.renderer.printSuccess(`Verification passed: \`${vResult.command}\` exited with 0 errors.`);
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
        content: outcome.rawContent || '',
        tool_calls: toolCalls
      });

      // Progress Guard 1: Detect repetitive identical tool calls and periodic cycles
      const currentCallSignature = toolCalls
        .map(tc => `${tc.function.name}:${JSON.stringify(tc.function.arguments)}`)
        .join(';');

      progress.recentToolSignatures.push(currentCallSignature);
      if (progress.recentToolSignatures.length > 16) {
        progress.recentToolSignatures.shift();
      }

      const duplicateCallCount = progress.recentToolSignatures.filter(sig => sig === currentCallSignature).length;
      const cycle = detectToolExecutionCycle(progress.recentToolSignatures);

      if (duplicateCallCount >= 4 || cycle.detected) {
        this.stats.progressLoopsDetected++;
        progress.consecutiveCycleDetections++;
        const cycleSummary = cycle.detected ? cycle.summary : currentCallSignature.split(':')[0];

        if (progress.consecutiveCycleDetections >= 3) {
          this.renderer.printWarning(
            `Model entered persistent repetition loop (${cycleSummary}). Halting execution to prevent token burn.`
          );
          break;
        } else if (progress.consecutiveCycleDetections === 2) {
          this.renderer.printWarning(
            `Repeated execution cycle detected (${cycleSummary}). Blocking repeated tool actions.`
          );
          for (const call of toolCalls) {
            this.messages.push({
              role: 'tool',
              name: call.function.name,
              tool_call_id: call.id,
              content: `[EXECUTION BLOCKED - CYCLE DETECTED] You have repeated the pattern [${cycleSummary}] multiple times without making progress. This tool call was BLOCKED. You must stop repeating this sequence. Either take a completely different approach or conclude and provide your final response.`
            });
          }
          continue;
        } else {
          this.renderer.printWarning(
            `Detected repetitive tool execution loop (${cycleSummary}). Intervening with recovery directive...`
          );
          for (const call of toolCalls) {
            this.messages.push({
              role: 'tool',
              name: call.function.name,
              tool_call_id: call.id,
              content: `[PROGRESS GUARD WARNING] This exact tool action has been called ${duplicateCallCount >= 4 ? duplicateCallCount : cycle.repetitions} times without making new progress. Do not repeat this identical call. Please inspect an alternate file, run verification via run_command, or provide your final response.`
            });
          }
          continue;
        }
      } else {
        progress.consecutiveCycleDetections = 0;
      }

      // Progress Guard 2: Trap obsessive single-file read loops & accelerate to action gate
      let singleFileObsession = false;
      let obsessedFilePath = '';
      for (const call of toolCalls) {
        if (call.function.name === 'view_file' && call.function.arguments?.path) {
          const p = String(call.function.arguments.path);
          const currentReads = (progress.fileReadTurns.get(p) || 0) + 1;
          progress.fileReadTurns.set(p, currentReads);
          if (currentReads >= 2 && !hasModifiedCode) {
            singleFileObsession = true;
            obsessedFilePath = p;
            break;
          }
        }
      }

      if (singleFileObsession) {
        readStepCount = Math.max(readStepCount, 2);
        progress.fileReadTurns.set(obsessedFilePath, 0);
      }

      const isPassiveTool = (name: string) =>
        name === 'view_file' ||
        name === 'search_code' ||
        name === 'batch_read_files' ||
        name === 'list_dir' ||
        name === 'find_by_name';

      // Execute each tool call sequentially
      let shouldTerminateTurn = false;
      for (const call of toolCalls) {
        this.stats.toolCalls++;
        const toolName = call.function.name;
        const toolArgs = call.function.arguments || {};

        // RUNTIME ACTION GATE:
        // If shouldForceMutationTools is true, passive inspection tools are strictly blocked at runtime.
        // Provide the model an exact edit_file syntax template targeting the file it attempted to inspect.
        if (shouldForceMutationTools && isPassiveTool(toolName)) {
          this.stats.failedToolCalls++;
          const targetFile = toolArgs.path || (toolArgs.paths && toolArgs.paths[0]) || obsessedFilePath || '';
          const targetHint = targetFile ? ` on "${targetFile}"` : '';
          const directive = `[EXECUTION BLOCKED - ACTION REQUIRED] You have completed code exploration (${readStepCount} reads). Tool "${toolName}" is DISABLED in execution mode.
You MUST execute 'edit_file' or 'write_file' now${targetHint} to apply your code changes.
Example 'edit_file' invocation:
{
  "path": "${targetFile || 'path/to/file'}",
  "target_content": "<exact code to replace>",
  "replacement_content": "<new updated code>"
}`;
          this.renderer.printWarning(`Blocked passive tool "${toolName}" — forcing 'edit_file' / 'write_file' execution.`);
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

        // Approval Check
        let isApproved = true;
        const needsApproval = typeof tool.needsApproval === 'function'
          ? tool.needsApproval(toolArgs)
          : tool.needsApproval;

        if (needsApproval && !this.context.autoApprove) {
          try {
            isApproved = await confirm({
              message: `approve ${theme.accent(toolName)}?`,
              default: true
            });
          } catch {
            isApproved = false;
          }
        }

        if (!isApproved) {
          const rejectedMsg = `Execution of "${toolName}" was rejected by the user.`;
          this.renderer.printError(rejectedMsg);
          this.messages.push({
            role: 'tool',
            name: toolName,
            tool_call_id: call.id,
            content: rejectedMsg
          });
          continue;
        }

        // Execute tool
        this.renderer.startSpinner(`Executing ${toolName}...`);
        if ((toolName === 'edit_file' || toolName === 'write_file') && toolArgs.path) {
          await this.checkpointManager.recordPreEditFile(toolArgs.path);
        }

        let executionResult: { result: string; isError?: boolean };
        try {
          executionResult = await tool.execute(toolArgs, this.context);
        } catch (err: any) {
          executionResult = { result: `Tool execution threw error: ${err.message}`, isError: true };
        } finally {
          // Guarantee spinner is stopped even if tool execution crashes
          this.renderer.stopSpinner();
        }

        this.renderer.printToolResult(toolName, executionResult.result, executionResult.isError);

        const isMutation = toolName === 'edit_file' || toolName === 'write_file' || toolName === 'run_command';
        if (isMutation) {
          mutationStepCount++;
        } else {
          readStepCount++;
        }

        if (executionResult.isError) {
          this.stats.failedToolCalls++;
          progress.failedToolCount++;
          progress.consecutiveToolFailures++;

          if (progress.consecutiveToolFailures >= 5) {
            this.renderer.printError(
              `Execution halted: ${progress.consecutiveToolFailures} consecutive tool execution errors encountered. Aborting turn to prevent token waste.`
            );
            shouldTerminateTurn = true;
            break;
          } else if (progress.consecutiveToolFailures >= 3) {
            executionResult.result += `\n\n[CIRCUIT BREAKER WARNING] ${progress.consecutiveToolFailures} consecutive tool actions have failed. Stop guessing tool arguments. Re-read the target file with 'view_file' or check directory paths before proceeding.`;
          }
        } else {
          this.stats.successfulToolCalls++;
          progress.successfulToolCount++;
          progress.consecutiveToolFailures = 0;

          if ((toolName === 'edit_file' || toolName === 'write_file') && toolArgs.path) {
            hasModifiedCode = true;
            progress.filesModified.add(toolArgs.path);

            const editCount = (progress.fileEditCounts.get(toolArgs.path) || 0) + 1;
            progress.fileEditCounts.set(toolArgs.path, editCount);

            // Check for file content oscillation (reverting to a previous state in this turn)
            let isOscillation = false;
            try {
              const targetFullPath = path.resolve(this.context.cwd, toolArgs.path);
              const currentContent = await fs.readFile(targetFullPath, 'utf8');
              const contentHash = crypto.createHash('md5').update(currentContent).digest('hex');
              const pastHashes = progress.fileContentHashes.get(toolArgs.path) || [];
              if (pastHashes.includes(contentHash)) {
                isOscillation = true;
              }
              pastHashes.push(contentHash);
              if (pastHashes.length > 5) pastHashes.shift();
              progress.fileContentHashes.set(toolArgs.path, pastHashes);
            } catch {}

            if (isOscillation) {
              this.renderer.printWarning(`Detected edit oscillation on "${toolArgs.path}" (file reverted to earlier state).`);
              executionResult.result += `\n\n[OSCILLATION WARNING] Your modification reverted "${toolArgs.path}" to an earlier state from this turn. You are thrashing between alternate versions. Run tests or inspect compiler output before editing this file again.`;
            }

            if (editCount > 6) {
              this.renderer.printWarning(`High edit churn on "${toolArgs.path}" (${editCount} edits in single turn).`);
              executionResult.result += `\n\n[CHURN LIMIT REACHED] "${toolArgs.path}" has been modified ${editCount} times in this turn. Further blind edits are restricted. Please verify the code or finish the task.`;
            }

            // Bounded dynamic leash extension:
            // Extend only for productive, non-thrashing edits, capped strictly at ABSOLUTE_MAX_STEPS (60)
            if (editCount <= 4 && safetyCeiling < ABSOLUTE_MAX_STEPS) {
              safetyCeiling = Math.min(stepCount + 15, ABSOLUTE_MAX_STEPS);
            }

            // Layer 3: Automated Linter / Compiler Self-Healing Loop with failure cap
            try {
              const lintResult = await CodeVerifier.runFastLint(this.context.cwd, toolArgs.path);
              if (!lintResult.passed && lintResult.errorOutput) {
                const fastLintFails = (progress.fastLintFailuresPerFile.get(toolArgs.path) || 0) + 1;
                progress.fastLintFailuresPerFile.set(toolArgs.path, fastLintFails);

                if (fastLintFails <= 2) {
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

    if (stepCount >= safetyCeiling) {
      this.renderer.printWarning(`Safety ceiling reached (${safetyCeiling} steps) to prevent runaway execution.`);
    }
  }
}
