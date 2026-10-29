import { ChatMessage, ToolDefinition, AgentContext } from '../types.js';
import { ModelCapabilities } from '../providers/types.js';

export type ExecutionState =
  | 'idle'
  | 'initializing'
  | 'prompt_processing'
  | 'model_querying'
  | 'evaluating_outcome'
  | 'validating_tools'
  | 'requesting_permissions'
  | 'executing_tools'
  | 'verifying'
  | 'repairing'
  | 'recovering'
  | 'completed'
  | 'failed'
  | 'halted';

export interface ToolValidationResult {
  valid: boolean;
  errors: string[];
}

export type DurableToolStatus =
  | 'success'
  | 'validation_failed'
  | 'permission_denied'
  | 'execution_error'
  | 'blocked'
  | 'cancelled';

export interface FileChangeRecord {
  path: string;
  changed: boolean;
  contentBefore?: string;
  contentAfter?: string;
  hashBefore?: string;
  hashAfter?: string;
}

export interface DurableToolResult {
  callId: string;
  toolName: string;
  arguments: Record<string, any>;
  status: DurableToolStatus;
  output: string;
  isError: boolean;
  durationMs: number;
  fileChanges?: FileChangeRecord;
}

export interface PermissionEvaluation {
  allowed: boolean;
  reason?: string;
  requiresPrompt?: boolean;
}

export interface ToolDispatchOptions {
  autoApprove?: boolean;
  allowOutsideWorkspace?: boolean;
  allowNetwork?: boolean;
  approvalAvailable?: boolean;
  interactive?: boolean;
  authorizedForCloud?: boolean;
  signal?: AbortSignal;
}
