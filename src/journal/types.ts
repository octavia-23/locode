import { VerificationCategory, VerificationStatus } from '../agent/context.js';
import { HarnessExecutionProfile } from '../runtime/profiles.js';

export type { VerificationCategory, VerificationStatus };

export const CURRENT_JOURNAL_VERSION = 1;

export type JournalEventType =
  | 'task_started'
  | 'model_request_started'
  | 'model_response_received'
  | 'tool_call_proposed'
  | 'permission_decided'
  | 'tool_execution_started'
  | 'tool_execution_completed'
  | 'file_change_recorded'
  | 'verification_completed'
  | 'task_interrupted'
  | 'task_completed'
  | 'task_failed';

export interface JournalEvent<T = any> {
  version: number;
  sessionId: string;
  taskId: string;
  seq: number;
  timestamp: string;
  type: JournalEventType;
  toolCallId?: string;
  payload: T;
  checksum?: string;
}

export interface TaskStartedPayload {
  objective: string;
  model: string;
  provider: string;
  executionProfile: Partial<HarnessExecutionProfile>;
  cwd: string;
}

export interface ModelRequestStartedPayload {
  turn: number;
  messageCount: number;
  estimatedPromptTokens: number;
  projectedCost?: number;
}

export interface ModelResponseReceivedPayload {
  turn: number;
  stopReason?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  reconciledCost?: number;
  costVariance?: number;
  proposedToolCallsCount: number;
  hasTextContent: boolean;
}

export interface ToolCallProposedPayload {
  toolCallId: string;
  toolName: string;
  arguments: Record<string, any>;
}

export interface PermissionDecidedPayload {
  toolCallId: string;
  toolName: string;
  decision: 'allow' | 'ask' | 'deny';
  allowed: boolean;
  requiresPrompt: boolean;
  autoApproved: boolean;
  reason?: string;
}

export interface ToolExecutionStartedPayload {
  toolCallId: string;
  toolName: string;
  startTime: number;
}

export interface ToolExecutionCompletedPayload {
  toolCallId: string;
  toolName: string;
  status: 'success' | 'execution_error' | 'permission_denied' | 'validation_failed' | 'cancelled' | 'interrupted';
  isError: boolean;
  durationMs: number;
  outputSummary: string;
}

export interface FileChangeRecordedPayload {
  toolCallId?: string;
  path: string;
  beforeHash?: string;
  afterHash?: string;
  changed: boolean;
}

export interface VerificationCompletedPayload {
  command: string;
  category: VerificationCategory;
  status: VerificationStatus;
  passed: boolean;
  summary: string;
}

export interface TaskInterruptedPayload {
  reason: string;
  lastSequence: number;
  interruptedToolCalls: string[];
}

export interface TaskCompletedPayload {
  finalStatus: 'success' | 'stopped';
  totalTurns: number;
  totalToolCalls: number;
  summary?: string;
}

export interface TaskFailedPayload {
  error: string;
  consecutiveFailures: number;
}

export interface DurableToolRecord {
  toolCallId: string;
  toolName: string;
  proposed: boolean;
  permissionDecision?: 'allow' | 'ask' | 'deny';
  permissionAllowed?: boolean;
  started: boolean;
  completed: boolean;
  status?: string;
  isError?: boolean;
  arguments?: Record<string, any>;
  fileChanges?: { path: string; beforeHash?: string; afterHash?: string; changed: boolean }[];
}

export interface DurableJournalSnapshot {
  version: number;
  sessionId: string;
  taskId: string;
  lastSeq: number;
  updatedAt: string;
  objective: string;
  model: string;
  provider: string;
  executionProfile: Partial<HarnessExecutionProfile>;
  pendingObjectives: string[];
  completedObjectives: string[];
  decisions: string[];
  fileHashes: Record<string, string>; // path -> latest confirmed hash
  toolCalls: Record<string, DurableToolRecord>;
  verificationResults: Record<string, {
    category: VerificationCategory;
    status: VerificationStatus;
    passed: boolean;
    command: string;
    summary: string;
  }>;
  taskState: 'running' | 'completed' | 'failed' | 'interrupted';
}
