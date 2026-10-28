import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { ExecutionJournal } from './journal.js';
import {
  DurableJournalSnapshot,
  DurableToolRecord,
  VerificationStatus,
  CURRENT_JOURNAL_VERSION
} from './types.js';

export interface InterruptedToolReconciliation {
  toolCallId: string;
  toolName: string;
  resolution:
    | 'unexecuted'
    | 'applied_verified'
    | 'not_applied'
    | 'uncertain_non_idempotent'
    | 'diverged'
    | 'passive_interrupted';
  details: string;
  requiresUserConfirmation: boolean;
}

export interface VerificationReconciliation {
  command: string;
  status: VerificationStatus;
  passed: boolean;
  isValid: boolean;
  invalidationReason?: string;
  summary: string;
}

export interface RecoveryInspectionReport {
  hasJournal: boolean;
  journalVersion?: number;
  sessionId?: string;
  taskId?: string;
  taskState?: 'running' | 'completed' | 'failed' | 'interrupted';
  canSafelyResume: boolean;
  recommendation: 'resume' | 'reconcile_with_user' | 'abort';
  reason?: string;
  divergences: string[];
  reconciledTools: InterruptedToolReconciliation[];
  lastVerification?: VerificationReconciliation;
  pendingObjectives: string[];
  completedObjectives: string[];
  decisions: string[];
  snapshot?: DurableJournalSnapshot;
}

export class JournalRecoveryManager {
  private cwd: string;
  private journal: ExecutionJournal;

  constructor(cwd: string, journalDir?: string) {
    this.cwd = path.resolve(cwd);
    this.journal = new ExecutionJournal({ cwd: this.cwd, journalDir });
  }

  getJournal(): ExecutionJournal {
    return this.journal;
  }

  /**
   * Inspects workspace state against persisted journal records to determine
   * if execution can be safely resumed without duplicate side effects or false claims.
   */
  async inspectWorkspaceAndJournal(): Promise<RecoveryInspectionReport> {
    await this.journal.init();

    const snapshot = this.journal.getSnapshot();
    const events = await this.journal.readEvents();

    if (events.length === 0 && snapshot.lastSeq === 0) {
      return {
        hasJournal: false,
        canSafelyResume: false,
        recommendation: 'abort',
        reason: 'No journal events or snapshots found in workspace.',
        divergences: [],
        reconciledTools: [],
        pendingObjectives: [],
        completedObjectives: [],
        decisions: []
      };
    }

    const divergences: string[] = [];
    const reconciledTools: InterruptedToolReconciliation[] = [];

    // 1. Compare recorded file hashes against actual disk state
    for (const [relPath, recordedHash] of Object.entries(snapshot.fileHashes)) {
      const fullPath = path.resolve(this.cwd, relPath);
      try {
        const content = await fs.readFile(fullPath, 'utf8');
        const diskHash = crypto.createHash('sha256').update(content).digest('hex');
        if (diskHash !== recordedHash) {
          divergences.push(
            `File "${relPath}" hash diverged from recorded journal state (recorded: ${recordedHash.slice(0, 10)}..., disk: ${diskHash.slice(0, 10)}...)`
          );
        }
      } catch {
        divergences.push(
          `File "${relPath}" was recorded in journal but does not exist on disk.`
        );
      }
    }

    // 2. Detect interrupted or uncompleted tool calls
    for (const [toolCallId, record] of Object.entries(snapshot.toolCalls)) {
      if (record.completed) {
        // Tool finished normally before interruption
        continue;
      }

      if (record.proposed && !record.started) {
        // Case A: Model proposed tool, but process interrupted before execution began
        reconciledTools.push({
          toolCallId,
          toolName: record.toolName,
          resolution: 'unexecuted',
          details: `Tool "${record.toolName}" was proposed but never started execution. No side effects were performed.`,
          requiresUserConfirmation: false
        });
        continue;
      }

      if (record.started && !record.completed) {
        // Case B: Process interrupted during tool execution!
        const toolName = record.toolName;

        if (toolName === 'view_file' || toolName === 'list_directory' || toolName === 'search_files' || toolName === 'batch_read_files') {
          // Passive read tool: no mutations
          reconciledTools.push({
            toolCallId,
            toolName,
            resolution: 'passive_interrupted',
            details: `Read-only tool "${toolName}" was interrupted mid-flight. Safe to resume.`,
            requiresUserConfirmation: false
          });
        } else if (toolName === 'edit_file' || toolName === 'write_file') {
          // File mutation tool: check disk state against expected hashes
          const targetRel = record.arguments?.path;
          if (!targetRel) {
            reconciledTools.push({
              toolCallId,
              toolName,
              resolution: 'diverged',
              details: `File mutation tool "${toolName}" missing path argument.`,
              requiresUserConfirmation: true
            });
            continue;
          }

          const fullPath = path.resolve(this.cwd, targetRel);
          try {
            const diskContent = await fs.readFile(fullPath, 'utf8');
            const diskHash = crypto.createHash('sha256').update(diskContent).digest('hex');

            // Find recorded before/after hash from tool call record or file changes
            const fileChange = record.fileChanges?.find(fc => fc.path === targetRel);
            const recordedBefore = fileChange?.beforeHash;
            const recordedAfter = fileChange?.afterHash;

            if (recordedAfter && diskHash === recordedAfter) {
              reconciledTools.push({
                toolCallId,
                toolName,
                resolution: 'applied_verified',
                details: `File "${targetRel}" mutation completed on disk before process crash (hash verified: ${diskHash.slice(0, 10)}...). Will not duplicate edit.`,
                requiresUserConfirmation: false
              });
            } else if (recordedBefore && diskHash === recordedBefore) {
              reconciledTools.push({
                toolCallId,
                toolName,
                resolution: 'not_applied',
                details: `File "${targetRel}" was not modified on disk before interruption (hash matches pre-edit state: ${diskHash.slice(0, 10)}...).`,
                requiresUserConfirmation: false
              });
            } else {
              // Disk state differs from both before and after, or hashes unknown
              reconciledTools.push({
                toolCallId,
                toolName,
                resolution: 'diverged',
                details: `File "${targetRel}" has uncertain disk state (disk hash: ${diskHash.slice(0, 10)}...).`,
                requiresUserConfirmation: true
              });
            }
          } catch {
            reconciledTools.push({
              toolCallId,
              toolName,
              resolution: 'not_applied',
              details: `File "${targetRel}" does not exist on disk. Mutation was not applied.`,
              requiresUserConfirmation: false
            });
          }
        } else if (toolName === 'run_command') {
          // Non-idempotent shell execution: MUST NEVER REPLAY AUTOMATICALLY
          reconciledTools.push({
            toolCallId,
            toolName,
            resolution: 'uncertain_non_idempotent',
            details: `Command "${record.arguments?.command || 'unknown'}" was running when process terminated. Side effects are uncertain and cannot be automatically replayed.`,
            requiresUserConfirmation: true
          });
        } else {
          // Generic / custom tool
          reconciledTools.push({
            toolCallId,
            toolName,
            resolution: 'uncertain_non_idempotent',
            details: `Tool "${toolName}" was interrupted mid-flight. Side effects cannot be established safely.`,
            requiresUserConfirmation: true
          });
        }
      }
    }

    // 3. Reconcile verification records
    let lastVerification: VerificationReconciliation | undefined;
    const verifEntries = Object.values(snapshot.verificationResults);
    if (verifEntries.length > 0) {
      const latest = verifEntries[verifEntries.length - 1];
      const hasDivergences = divergences.length > 0;

      lastVerification = {
        command: latest.command,
        status: latest.status,
        passed: latest.passed && !hasDivergences,
        isValid: !hasDivergences,
        invalidationReason: hasDivergences ? 'Workspace files diverged since last verification.' : undefined,
        summary: latest.summary
      };
    }

    // 4. Determine safe resume status
    const hasUncertainTools = reconciledTools.some(t => t.requiresUserConfirmation);
    const hasDivergentFiles = divergences.length > 0;
    const taskFinished = snapshot.taskState === 'completed' || snapshot.taskState === 'failed';

    let canSafelyResume = true;
    let recommendation: 'resume' | 'reconcile_with_user' | 'abort' = 'resume';
    let reason: string | undefined;

    if (taskFinished) {
      canSafelyResume = false;
      recommendation = 'abort';
      reason = `Task is already marked as ${snapshot.taskState}. Cannot resume finished task.`;
    } else if (hasUncertainTools || hasDivergentFiles) {
      canSafelyResume = false;
      recommendation = 'reconcile_with_user';
      reason = hasUncertainTools
        ? 'Interrupted non-idempotent operations or diverged files detected. Explicit user reconciliation required before continuing.'
        : 'Workspace file contents diverged from recorded journal hashes.';
    }

    return {
      hasJournal: true,
      journalVersion: CURRENT_JOURNAL_VERSION,
      sessionId: snapshot.sessionId,
      taskId: snapshot.taskId,
      taskState: snapshot.taskState,
      canSafelyResume,
      recommendation,
      reason,
      divergences,
      reconciledTools,
      lastVerification,
      pendingObjectives: snapshot.pendingObjectives,
      completedObjectives: snapshot.completedObjectives,
      decisions: snapshot.decisions,
      snapshot
    };
  }

  /**
   * Applies validated journal recovery state onto an AgentLoop instance.
   */
  async applyRecoveryToAgent(agent: any, report: RecoveryInspectionReport): Promise<boolean> {
    if (!report.canSafelyResume || !report.snapshot) {
      return false;
    }

    const snapshot = report.snapshot;

    // 1. Restore execution profile if recorded
    if (snapshot.executionProfile && typeof agent.setExecutionProfile === 'function') {
      agent.setExecutionProfile(snapshot.executionProfile);
    }

    // 2. Restore pending and completed objectives and decisions into ContextEngine
    if (typeof agent.getContextEngine === 'function') {
      const contextEngine = agent.getContextEngine();
      if (contextEngine) {
        if (snapshot.objective) {
          contextEngine.setObjective(snapshot.objective);
        }
        if (Array.isArray(snapshot.decisions)) {
          for (const dec of snapshot.decisions) {
            contextEngine.addDecision(dec);
          }
        }
      }
    }

    return true;
  }
}
