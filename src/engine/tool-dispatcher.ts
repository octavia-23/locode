import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { ToolDefinition, AgentContext } from '../types.js';
import { DurableToolResult, ToolDispatchOptions, FileChangeRecord } from './types.js';
import { ToolSchemaValidator } from './schema-validator.js';
import { PermissionEngine } from './permission-engine.js';
import { ExecutionJournal } from '../journal/journal.js';

export interface PromptHandler {
  confirmApproval: (toolName: string, args: Record<string, any>, reason?: string) => Promise<boolean>;
  onProgress?: (progress: { elapsedMs: number; lastOutput?: string }) => void;
}

export class ToolDispatcher {
  private permissionEngine: PermissionEngine;
  private promptHandler?: PromptHandler;
  private journal?: ExecutionJournal;

  constructor(
    permissionEngine?: PermissionEngine,
    promptHandler?: PromptHandler,
    journal?: ExecutionJournal
  ) {
    this.permissionEngine = permissionEngine || new PermissionEngine();
    this.promptHandler = promptHandler;
    this.journal = journal;
  }

  setPromptHandler(handler: PromptHandler) {
    this.promptHandler = handler;
  }

  setJournal(journal: ExecutionJournal) {
    this.journal = journal;
  }

  getJournal(): ExecutionJournal | undefined {
    return this.journal;
  }

  getPermissionEngine(): PermissionEngine {
    return this.permissionEngine;
  }

  async requestApproval(toolName: string, args: Record<string, any>, reason?: string): Promise<boolean> {
    if (this.promptHandler?.confirmApproval) {
      return await this.promptHandler.confirmApproval(toolName, args, reason);
    }
    return false;
  }

  /**
   * Dispatches a single tool call through Schema Validation, Permission Check,
   * Pre-execution snapshotting, Tool Execution, and Durable Result recording.
   * Strictly fails closed if user approval is required but unavailable.
   */
  async dispatch(
    tool: ToolDefinition,
    rawArgs: any,
    context: AgentContext,
    callId: string = `call_${Date.now()}`,
    options?: ToolDispatchOptions
  ): Promise<DurableToolResult> {
    const startTime = Date.now();
    const toolName = tool.name;

    // STEP 1: Schema Validation
    const validation = ToolSchemaValidator.validate(tool, rawArgs);
    if (!validation.valid) {
      if (this.journal) {
        await this.journal.recordEvent('tool_execution_completed', {
          toolCallId: callId,
          toolName,
          status: 'validation_failed',
          isError: true,
          durationMs: Date.now() - startTime,
          outputSummary: `Invalid arguments: ${validation.errors.join(', ')}`
        }, callId).catch(() => {});
      }
      return {
        callId,
        toolName,
        arguments: typeof rawArgs === 'object' && rawArgs !== null ? rawArgs : { raw: rawArgs },
        status: 'validation_failed',
        output: `[SCHEMA VALIDATION ERROR] Invalid arguments for tool "${toolName}":\n- ${validation.errors.join('\n- ')}`,
        isError: true,
        durationMs: Date.now() - startTime
      };
    }

    const cleanArgs: Record<string, any> = { ...rawArgs };

    // STEP 2: Permission & Security Check
    const permEval = this.permissionEngine.evaluate(tool, cleanArgs, context, options);
    if (!permEval.allowed) {
      if (this.journal) {
        await this.journal.recordEvent('permission_decided', {
          toolCallId: callId,
          toolName,
          decision: 'deny',
          allowed: false,
          requiresPrompt: permEval.requiresPrompt,
          autoApproved: Boolean(options?.autoApprove || context.autoApprove),
          reason: permEval.reason
        }, callId).catch(() => {});
        await this.journal.recordEvent('tool_execution_completed', {
          toolCallId: callId,
          toolName,
          status: 'permission_denied',
          isError: true,
          durationMs: Date.now() - startTime,
          outputSummary: permEval.reason || 'Permission denied'
        }, callId).catch(() => {});
      }
      return {
        callId,
        toolName,
        arguments: cleanArgs,
        status: 'permission_denied',
        output: permEval.reason || `Permission denied: Tool "${toolName}" execution blocked.`,
        isError: true,
        durationMs: Date.now() - startTime
      };
    }

    // STEP 3: User Confirmation if required (Fails closed if approval handler is missing)
    const isUnredactableSecret = Boolean(permEval.reason?.includes('cannot be safely redacted'));
    const needsUserPrompt = permEval.requiresPrompt && (isUnredactableSecret || (!options?.autoApprove && !context.autoApprove));
    if (needsUserPrompt) {
      if (!this.promptHandler?.confirmApproval) {
        if (this.journal) {
          await this.journal.recordEvent('permission_decided', {
            toolCallId: callId,
            toolName,
            decision: 'ask',
            allowed: false,
            requiresPrompt: true,
            autoApproved: false,
            reason: 'Approval handler unavailable'
          }, callId).catch(() => {});
          await this.journal.recordEvent('tool_execution_completed', {
            toolCallId: callId,
            toolName,
            status: 'permission_denied',
            isError: true,
            durationMs: Date.now() - startTime,
            outputSummary: 'Approval unavailable'
          }, callId).catch(() => {});
        }
        return {
          callId,
          toolName,
          arguments: cleanArgs,
          status: 'permission_denied',
          output: `Permission Denied: Tool "${toolName}" requires user approval, but approval is unavailable (no prompt handler configured).`,
          isError: true,
          durationMs: Date.now() - startTime
        };
      }

      const approved = await this.promptHandler.confirmApproval(toolName, cleanArgs, permEval.reason);
      if (this.journal) {
        await this.journal.recordEvent('permission_decided', {
          toolCallId: callId,
          toolName,
          decision: 'ask',
          allowed: approved,
          requiresPrompt: true,
          autoApproved: false,
          reason: approved ? 'User approved' : 'User rejected'
        }, callId).catch(() => {});
      }
      if (!approved) {
        if (this.journal) {
          await this.journal.recordEvent('tool_execution_completed', {
            toolCallId: callId,
            toolName,
            status: 'permission_denied',
            isError: true,
            durationMs: Date.now() - startTime,
            outputSummary: 'Rejected by user'
          }, callId).catch(() => {});
        }
        return {
          callId,
          toolName,
          arguments: cleanArgs,
          status: 'permission_denied',
          output: `Execution of "${toolName}" was rejected by user.`,
          isError: true,
          durationMs: Date.now() - startTime
        };
      }
    } else {
      if (this.journal) {
        await this.journal.recordEvent('permission_decided', {
          toolCallId: callId,
          toolName,
          decision: 'allow',
          allowed: true,
          requiresPrompt: false,
          autoApproved: Boolean(options?.autoApprove || context.autoApprove),
          reason: 'Auto-approved or allowed by policy'
        }, callId).catch(() => {});
      }
    }

    // STEP 4: Pre-execution File Snapshot
    let fileChangeRecord: FileChangeRecord | undefined;
    const isFileMutation = (toolName === 'edit_file' || toolName === 'write_file') && Boolean(cleanArgs.path);

    if (isFileMutation && cleanArgs.path) {
      try {
        const fullPath = path.resolve(context.cwd, cleanArgs.path);
        const contentBefore = await fs.readFile(fullPath, 'utf8');
        const hashBefore = crypto.createHash('sha256').update(contentBefore).digest('hex');
        fileChangeRecord = {
          path: cleanArgs.path,
          changed: false,
          contentBefore,
          hashBefore
        };
      } catch {
        fileChangeRecord = {
          path: cleanArgs.path,
          changed: false
        };
      }
    }

    // STEP 5: Tool Execution
    if (this.journal) {
      await this.journal.recordEvent('tool_execution_started', {
        toolCallId: callId,
        toolName,
        startTime
      }, callId).catch(() => {});
    }

    let resultText = '';
    let isError = false;

    // Attach progress listener for long-running commands
    const origOnProgress = context.onCommandProgress;
    if (this.promptHandler?.onProgress) {
      context.onCommandProgress = this.promptHandler.onProgress;
    }

    try {
      if (options?.signal?.aborted) {
        throw new Error('Tool execution was cancelled before start');
      }

      const effectiveContext: AgentContext = options?.signal
        ? { ...context, signal: options.signal }
        : context;

      const execResult = await tool.execute(cleanArgs, effectiveContext);
      resultText = execResult.result || '';
      isError = Boolean(execResult.isError);
    } catch (err: any) {
      resultText = `Tool execution threw error: ${err.message || String(err)}`;
      isError = true;
    } finally {
      context.onCommandProgress = origOnProgress;
    }

    // STEP 6: Post-execution File Snapshot & Verification
    if (isFileMutation && cleanArgs.path && fileChangeRecord) {
      try {
        const fullPath = path.resolve(context.cwd, cleanArgs.path);
        const contentAfter = await fs.readFile(fullPath, 'utf8');
        const hashAfter = crypto.createHash('sha256').update(contentAfter).digest('hex');
        fileChangeRecord.contentAfter = contentAfter;
        fileChangeRecord.hashAfter = hashAfter;
        fileChangeRecord.changed = fileChangeRecord.hashBefore !== hashAfter;
      } catch {
        // File may have been deleted or not created
      }
    }

    const durationMs = Date.now() - startTime;

    if (this.journal) {
      if (fileChangeRecord && fileChangeRecord.changed) {
        await this.journal.recordEvent('file_change_recorded', {
          toolCallId: callId,
          path: fileChangeRecord.path,
          beforeHash: fileChangeRecord.hashBefore,
          afterHash: fileChangeRecord.hashAfter,
          changed: true
        }, callId).catch(() => {});
      }

      await this.journal.recordEvent('tool_execution_completed', {
        toolCallId: callId,
        toolName,
        status: isError ? 'execution_error' : 'success',
        isError,
        durationMs,
        outputSummary: resultText.slice(0, 500)
      }, callId).catch(() => {});
    }

    return {
      callId,
      toolName,
      arguments: cleanArgs,
      status: isError ? 'execution_error' : 'success',
      output: resultText,
      isError,
      durationMs,
      fileChanges: fileChangeRecord
    };
  }
}
