import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { ToolDefinition, AgentContext } from '../types.js';
import { DurableToolResult, ToolDispatchOptions, FileChangeRecord } from './types.js';
import { ToolSchemaValidator } from './schema-validator.js';
import { PermissionEngine } from './permission-engine.js';

export interface PromptHandler {
  confirmApproval: (toolName: string, args: Record<string, any>, reason?: string) => Promise<boolean>;
  onProgress?: (progress: { elapsedMs: number; lastOutput?: string }) => void;
}

export class ToolDispatcher {
  private permissionEngine: PermissionEngine;
  private promptHandler?: PromptHandler;

  constructor(permissionEngine?: PermissionEngine, promptHandler?: PromptHandler) {
    this.permissionEngine = permissionEngine || new PermissionEngine();
    this.promptHandler = promptHandler;
  }

  setPromptHandler(handler: PromptHandler) {
    this.promptHandler = handler;
  }

  getPermissionEngine(): PermissionEngine {
    return this.permissionEngine;
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
    if (permEval.requiresPrompt && !options?.autoApprove && !context.autoApprove) {
      if (!this.promptHandler?.confirmApproval) {
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
      if (!approved) {
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

      const execResult = await tool.execute(cleanArgs, context);
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
