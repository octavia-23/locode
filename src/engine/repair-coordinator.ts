import { CodeVerifier, VerificationResult } from '../agent/verifier.js';
import { ArchitectEngine } from '../agent/architect.js';
import { StagnationDetector, StagnationDiagnosis } from '../agent/stagnation.js';
import { CheckpointManager } from '../git/checkpoint.js';
import { AgentContext, ChatMessage } from '../types.js';
import { ILLMProvider } from '../providers/types.js';
import { ExecutionJournal } from '../journal/journal.js';

export interface RepairEvaluationResult {
  passed: boolean;
  shouldContinue: boolean;
  status: 'passed' | 'repair_feedback' | 'architect_escalated' | 'stagnation_halt';
  vResult?: VerificationResult;
  feedbackDirective?: string;
  architectDiagnosis?: string;
  reason?: string;
}

export class RepairCoordinator {
  private cwd: string;
  private checkpointManager: CheckpointManager;
  private stagnationDetector: StagnationDetector;
  private maxRepairAttempts: number;
  private currentRepairAttempts: number = 0;

  constructor(
    cwd: string,
    checkpointManager?: CheckpointManager,
    stagnationDetector?: StagnationDetector,
    maxRepairAttempts: number = 3
  ) {
    this.cwd = cwd;
    this.checkpointManager = checkpointManager || new CheckpointManager(cwd);
    this.stagnationDetector = stagnationDetector || new StagnationDetector();
    this.maxRepairAttempts = maxRepairAttempts;
  }

  getRepairAttempts(): number {
    return this.currentRepairAttempts;
  }

  resetRepairAttempts(): void {
    this.currentRepairAttempts = 0;
  }

  /**
   * Runs verification, checks for failure loops/stagnation, and coordinates architect diagnosis.
   */
  async runVerificationAndDiagnosis(
    userInput: string,
    stepCount: number,
    recentMessages: ChatMessage[],
    context: AgentContext,
    provider: ILLMProvider,
    journal?: ExecutionJournal
  ): Promise<RepairEvaluationResult> {
    const vResult = await CodeVerifier.run(this.cwd);

    if (journal) {
      await journal.recordEvent('verification_completed', {
        command: vResult.command || 'verify',
        category: 'build',
        status: vResult.status,
        passed: vResult.passed,
        summary: vResult.errorOutput ? vResult.errorOutput.slice(0, 500) : 'Verification passed with 0 errors.'
      }).catch(() => {});
    }

    // Record verification result in stagnation detector
    const currentWs = await StagnationDetector.computeWorkspaceFingerprint(this.cwd);
    this.stagnationDetector.recordStep({
      turn: stepCount,
      toolCallId: `verify-${stepCount}-${this.currentRepairAttempts}`,
      normalizedTool: 'verify',
      normalizedArgs: { command: vResult.command || 'verify' },
      resultFingerprint: StagnationDetector.fingerprintResult(
        vResult.errorOutput || (vResult.passed ? 'PASSED' : 'FAILED'),
        !vResult.passed
      ),
      workspaceFingerprint: currentWs,
      isError: vResult.status === 'failed',
      testOutcome: {
        passed: vResult.status === 'passed',
        errorSignature: StagnationDetector.extractErrorSignature(vResult.errorOutput || ''),
        command: vResult.command || 'verify'
      }
    });

    if (vResult.status === 'passed') {
      this.resetRepairAttempts();
      return {
        passed: true,
        shouldContinue: false,
        status: 'passed',
        vResult
      };
    }

    // Failure path
    this.currentRepairAttempts++;

    // Check if verification failures have stagnated with identical error signatures
    const stagDiag = this.stagnationDetector.diagnose();
    if (stagDiag.stagnated) {
      const recAttempts = this.stagnationDetector.incrementRecoveryAttempts();
      if (recAttempts > this.stagnationDetector.getThresholds().maxRecoveryAttempts) {
        return {
          passed: false,
          shouldContinue: false,
          status: 'stagnation_halt',
          vResult,
          reason: `Verification failure stagnation limit exceeded (${recAttempts} recovery attempts). Halting cleanly with evidence.`
        };
      }
    }

    // Escalate to Architect Mode if worker failed repeatedly
    if (this.currentRepairAttempts >= 2) {
      const diagText = await ArchitectEngine.diagnose(
        vResult.errorOutput || 'Verification test failed without output',
        vResult.command || 'verify',
        recentMessages,
        context,
        provider
      );

      const architectDirective =
        `[ARCHITECT REPAIR DIRECTIVE]\n` +
        `The worker failed repeated repair attempts. The senior architect diagnosed the issue:\n` +
        `${diagText}\n\n` +
        `Apply this fix immediately using 'edit_file'.`;

      return {
        passed: false,
        shouldContinue: true,
        status: 'architect_escalated',
        vResult,
        architectDiagnosis: diagText,
        feedbackDirective: architectDirective
      };
    }

    // Standard repair feedback loop
    const standardDirective =
      `[VERIFICATION FAILED]\n` +
      `Command: ${vResult.command}\n` +
      `Error Output:\n${vResult.errorOutput}\n\n` +
      `Please analyze the failure trace, locate the source of error, and use 'edit_file' to repair the issue.`;

    return {
      passed: false,
      shouldContinue: true,
      status: 'repair_feedback',
      vResult,
      feedbackDirective: standardDirective
    };
  }

  async rollbackToCheckpoint(): Promise<{ success: boolean; message: string }> {
    return await this.checkpointManager.undo();
  }
}
