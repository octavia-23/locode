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
  status: 'passed' | 'repair_feedback' | 'architect_escalated' | 'stagnation_halt' | 'not_run' | 'inconclusive';
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

    if (vResult.status === 'not-run') {
      return {
        passed: false,
        shouldContinue: false,
        status: 'not_run',
        vResult
      };
    }

    if (vResult.status === 'inconclusive') {
      return {
        passed: false,
        shouldContinue: false,
        status: 'inconclusive',
        vResult
      };
    }

    // Failure path (vResult.status === 'failed')
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

      const recoveryDirective = this.stagnationDetector.buildRecoveryDirective(userInput, stagDiag);
      return {
        passed: false,
        shouldContinue: true,
        status: 'repair_feedback',
        vResult,
        feedbackDirective: recoveryDirective,
        reason: `Verification failure stagnation detected: ${stagDiag.summary}`
      };
    }

    // Escalate to Architect Mode if worker failed repeatedly or mode is architect
    if (this.currentRepairAttempts >= 2 || context.mode === 'architect') {
      const diagText = await ArchitectEngine.diagnose(
        vResult.errorOutput || 'Verification test failed without output',
        vResult.command || 'verify',
        recentMessages,
        context,
        provider
      );

      const architectDirective =
        `[AUTONOMOUS VERIFICATION FAILED - ARCHITECT ESCALATION]\n` +
        `Command executed: \`${vResult.command}\`\n` +
        `Compiler / Test failure:\n\`\`\`\n${vResult.errorOutput}\n\`\`\`\n\n` +
        `🏛️ Senior Architect Directive:\n${diagText}\n\n` +
        `Follow the Senior Architect's diagnosis above. Use 'edit_file' to apply the surgical fix to the affected files. Do not deviate from the plan.`;

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
      `[AUTONOMOUS VERIFICATION FAILED]\n` +
      `Command executed: \`${vResult.command}\`\n\n` +
      `Error output:\n\`\`\`\n${vResult.errorOutput}\n\`\`\`\n\n` +
      `The modifications introduced compilation, syntax, or test errors. Analyze the stack trace above, locate the offending file and line, and use 'edit_file' to repair the error. Do not complete the task until the error is resolved.`;

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
