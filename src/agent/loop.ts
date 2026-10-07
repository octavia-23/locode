import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
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
  successfulToolCount: number;
  failedToolCount: number;
  consecutiveNoProgressCount: number;
  consecutiveEmptyResponses: number;
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
      const msg = rawError.message || String(rawError);
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
    // while researching code. When active modifications occur, the leash dynamically extends.
    let safetyCeiling = 150;
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
      successfulToolCount: 0,
      failedToolCount: 0,
      consecutiveNoProgressCount: 0,
      consecutiveEmptyResponses: 0
    };

    while (stepCount < safetyCeiling) {
      stepCount++;

      // Run working synthesis ONLY once per compaction cycle (not every step!)
      // and only when approaching the true context boundary
      let synthesizedFindings: string | undefined;
      const currentMsgTokens = this.contextEngine.estimateMessagesTokens(this.messages);
      const toolTokens = this.contextEngine.estimateToolsTokens(allTools);
      const maxTokens = this.contextEngine.getMaxTokens();
      const hasSynthesisHeadroom = currentMsgTokens + toolTokens < maxTokens - 1500;

      if (
        this.contextEngine.shouldCompact(this.messages, toolTokens) &&
        this.messages.length > 8 &&
        hasSynthesisHeadroom &&
        progress.consecutiveNoProgressCount === 0 &&
        stepCount % 5 === 0 // Don't interrupt every single turn with synthesis
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

      this.renderer.startSpinner(`Thinking with ${chalk.cyan(this.context.model)}...`);

      let rawResponse: any;
      let rawError: any;
      try {
        rawResponse = await this.provider.chat(compacted, allTools);
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
              this.renderer.printWarning(
                `⚡ Escalating to Architect Engine (${chalk.cyan(archModel)}) for deep root-cause diagnosis...`
              );
              this.renderer.startSpinner('Architect analyzing cross-file contracts and root cause...');
              architectPlan = await ArchitectEngine.diagnose(
                vResult.errorOutput || '',
                vResult.command || '',
                this.messages,
                this.context,
                this.provider
              );
              this.renderer.stopSpinner();
              console.log(chalk.bold.magenta('\n🏛️ Senior Architect Directive:'));
              console.log(chalk.gray(architectPlan) + '\n');
            } else {
              this.renderer.printWarning(
                `Autonomous Self-Repair [Attempt ${repairAttempts}/${maxRepairAttempts}]: \`${vResult.command}\` failed. Feeding error trace back to model...`
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

      // Progress Guard 1: Detect repetitive identical tool calls
      const currentCallSignature = toolCalls
        .map(tc => `${tc.function.name}:${JSON.stringify(tc.function.arguments)}`)
        .join(';');

      progress.recentToolSignatures.push(currentCallSignature);
      if (progress.recentToolSignatures.length > 8) {
        progress.recentToolSignatures.shift();
      }

      const duplicateCallCount = progress.recentToolSignatures.filter(sig => sig === currentCallSignature).length;
      if (duplicateCallCount >= 4) {
        this.stats.progressLoopsDetected++;
        this.renderer.printWarning('Detected repetitive identical tool execution loop. Intervening with recovery directive...');
        
        progress.recentToolSignatures = [];

        for (const call of toolCalls) {
          this.messages.push({
            role: 'tool',
            name: call.function.name,
            tool_call_id: call.id,
            content: `[PROGRESS GUARD WARNING] This exact tool action has been called ${duplicateCallCount} times without making new progress. Do not repeat this identical call. Please inspect an alternate file, run verification via run_command, or provide your final response.`
          });
        }
        continue;
      }

      // Progress Guard 2: Trap obsessive single-file read loops & force action
      // If the model reads from the same file 3+ times without writing code, or has done >8 read steps with 0 edits,
      // intervene immediately and force it to execute edit_file/write_file!
      let singleFileObsession = false;
      let obsessedFilePath = '';
      for (const call of toolCalls) {
        if (call.function.name === 'view_file' && call.function.arguments?.path) {
          const p = String(call.function.arguments.path);
          const currentReads = (progress.fileReadTurns.get(p) || 0) + 1;
          progress.fileReadTurns.set(p, currentReads);
          if (currentReads >= 3 && !hasModifiedCode) {
            singleFileObsession = true;
            obsessedFilePath = p;
            break;
          }
        }
      }

      const totalExplorationOnlyTurns = readStepCount >= 8 && mutationStepCount === 0;

      if (singleFileObsession || totalExplorationOnlyTurns) {
        const reason = singleFileObsession
          ? `You have read "${obsessedFilePath}" 3 times without writing code.`
          : `You have spent ${readStepCount} turns exploring without writing any code.`;

        this.renderer.printWarning(`${reason} Forcing transition to edit_file/write_file...`);
        if (singleFileObsession) progress.fileReadTurns.set(obsessedFilePath, 0);

        for (const call of toolCalls) {
          this.messages.push({
            role: 'tool',
            name: call.function.name,
            tool_call_id: call.id,
            content: `[MANDATORY ACTION DIRECTIVE] ${reason} Stop reading and stop synthesizing. You already have enough context. You MUST now execute 'edit_file' or 'write_file' to apply the concrete code changes, or provide your final solution.`
          });
        }
        continue;
      }

      // Execute each tool call sequentially
      for (const call of toolCalls) {
        this.stats.toolCalls++;
        const toolName = call.function.name;
        const toolArgs = call.function.arguments;

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
              console.log(chalk.green(`  (New file: ${toolArgs.path})`));
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
              message: `Approve execution of ${chalk.bold.yellow(toolName)}?`,
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
        } else {
          this.stats.successfulToolCalls++;
          progress.successfulToolCount++;
          if ((toolName === 'edit_file' || toolName === 'write_file') && toolArgs.path) {
            hasModifiedCode = true;
            progress.filesModified.add(toolArgs.path);
            // DYNAMIC LEASH EXTENSION: When the model makes a successful file edit,
            // ensure it always has at least 80 steps remaining from now so it never gets throttled mid-refactor!
            if (safetyCeiling - stepCount < 80) {
              safetyCeiling = stepCount + 80;
            }
          }
        }

        let toolOutput = executionResult.result || '';
        // Ingest-time safety ceiling: clamp oversized raw tool outputs immediately (max 4,000 characters)
        // so that massive terminal logs or huge file dumps never blow out the context window.
        const MAX_TOOL_INGEST_CHARS = 4000;
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
    }

    if (stepCount >= safetyCeiling) {
      this.renderer.printWarning(`Safety ceiling reached (${safetyCeiling} steps) to prevent runaway execution.`);
    }
  }
}
