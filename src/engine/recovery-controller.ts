import crypto from 'node:crypto';
import {
  StagnationDetector,
  StagnationDiagnosis,
  StagnationThresholds,
  DEFAULT_STAGNATION_THRESHOLDS
} from '../agent/stagnation.js';

export interface CycleInfo {
  detected: boolean;
  period: number;
  repetitions: number;
  summary: string;
}

export interface RecoveryAction {
  type: 'proceed' | 'warn' | 'block_repetition' | 'halt';
  message?: string;
  directive?: string;
  consecutiveCycles: number;
  recoveryAttempts: number;
}

export class RecoveryController {
  private recentToolSignatures: string[] = [];
  private consecutiveCycleDetections: number = 0;
  private consecutiveToolFailures: number = 0;
  private consecutiveEmptyResponses: number = 0;
  private fileEditCounts: Map<string, number> = new Map();
  private fileContentHashes: Map<string, string[]> = new Map();
  private stagnationDetector: StagnationDetector;
  private maxConsecutiveFailures: number;

  constructor(thresholds?: Partial<StagnationThresholds>, maxConsecutiveFailures: number = 5) {
    this.stagnationDetector = new StagnationDetector({ ...DEFAULT_STAGNATION_THRESHOLDS, ...thresholds });
    this.maxConsecutiveFailures = maxConsecutiveFailures;
  }

  getStagnationDetector(): StagnationDetector {
    return this.stagnationDetector;
  }

  /**
   * Detects periodic cycles in tool signatures:
   * Traps period 1 (identical call), period 2 (A-B-A-B ping-pong), period 3, and period 4.
   */
  static detectToolCycle(signatures: string[]): CycleInfo {
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

  /**
   * Records a tool call signature and checks if repetition or cycle policies are violated.
   */
  evaluateToolCalls(
    toolCalls: Array<{ function: { name: string; arguments?: any } }>,
    userInput: string
  ): RecoveryAction {
    const currentCallSignature = toolCalls
      .map(tc => `${tc.function.name}:${JSON.stringify(StagnationDetector.normalizeArguments(tc.function.arguments || {}))}`)
      .join(';');

    this.recentToolSignatures.push(currentCallSignature);
    if (this.recentToolSignatures.length > 16) {
      this.recentToolSignatures.shift();
    }

    const duplicateCallCount = this.recentToolSignatures.filter(sig => sig === currentCallSignature).length;
    const cycle = RecoveryController.detectToolCycle(this.recentToolSignatures);

    const stagnationDiag = this.stagnationDetector.diagnose();
    const continuingStagnation = stagnationDiag.stagnated && this.stagnationDetector.isContinuingStagnation(toolCalls);

    if (duplicateCallCount >= 4 || cycle.detected || continuingStagnation) {
      this.consecutiveCycleDetections++;
      const recoveryAttempts = this.stagnationDetector.incrementRecoveryAttempts();
      const maxRecAttempts = this.stagnationDetector.getThresholds().maxRecoveryAttempts;
      const cycleSummary = cycle.detected
        ? cycle.summary
        : (stagnationDiag.stagnated ? stagnationDiag.summary : currentCallSignature);

      if (recoveryAttempts > maxRecAttempts || this.consecutiveCycleDetections >= 3) {
        return {
          type: 'halt',
          message: `Model entered persistent stagnation (${cycleSummary}). Halting cleanly after ${recoveryAttempts} recovery attempts.`,
          directive: `[STAGNATION TERMINATION REPORT]\nReason: ${stagnationDiag.summary || `Persistent tool repetition: ${cycleSummary}`}\nEvidence:\n${stagnationDiag.evidence?.length ? stagnationDiag.evidence.map(e => `* ${e}`).join('\n') : `* Pattern repeated across ${recoveryAttempts} recovery attempts.`}`,
          consecutiveCycles: this.consecutiveCycleDetections,
          recoveryAttempts
        };
      }

      if (this.consecutiveCycleDetections === 2 || recoveryAttempts === 2) {
        const directive = stagnationDiag.stagnated
          ? this.stagnationDetector.buildRecoveryDirective(userInput, stagnationDiag)
          : `[EXECUTION BLOCKED - CYCLE DETECTED] You have repeated the pattern [${cycleSummary}] multiple times without making progress. This tool call was BLOCKED. You must stop repeating this sequence. Either take a completely different approach or conclude and provide your final response.`;

        return {
          type: 'block_repetition',
          message: `Repeated execution cycle detected (${cycleSummary}). Blocking repeated tool actions and enforcing alternative action.`,
          directive,
          consecutiveCycles: this.consecutiveCycleDetections,
          recoveryAttempts
        };
      }

      const directive = stagnationDiag.stagnated
        ? `[PROGRESS GUARD WARNING]\n${this.stagnationDetector.buildRecoveryDirective(userInput, stagnationDiag)}`
        : `[PROGRESS GUARD WARNING] This exact tool action has been called ${duplicateCallCount >= 4 ? duplicateCallCount : cycle.repetitions} times without making new progress. Do not repeat this identical call. Please inspect an alternate file, run verification via run_command, or provide your final response.`;

      return {
        type: 'warn',
        message: `Detected repetitive tool execution loop (${cycleSummary}). Intervening with recovery directive...`,
        directive,
        consecutiveCycles: this.consecutiveCycleDetections,
        recoveryAttempts
      };
    }

    this.consecutiveCycleDetections = 0;
    return {
      type: 'proceed',
      consecutiveCycles: 0,
      recoveryAttempts: this.stagnationDetector.getRecoveryAttempts()
    };
  }

  /**
   * Tracks empty model response and returns recovery action.
   */
  handleEmptyResponse(userInput: string, lastToolOutcome?: string): RecoveryAction {
    this.consecutiveEmptyResponses++;
    if (this.consecutiveEmptyResponses <= 3) {
      const directive = `[CONTINUATION INSTRUCTION]\nYour previous response contained no text or tool actions.\nCurrent Objective: ${userInput}\n${lastToolOutcome ? `Most recent tool outcome: ${lastToolOutcome.slice(0, 300)}` : ''}\nPlease proceed with the next tool call (e.g., view_file, edit_file, run_command) to complete the task, or provide your final answer if finished.`;
      return {
        type: 'warn',
        message: `Model generated an empty response without tool calls. Issuing bounded continuation directive (${this.consecutiveEmptyResponses}/3)...`,
        directive,
        consecutiveCycles: 0,
        recoveryAttempts: this.consecutiveEmptyResponses
      };
    }

    return {
      type: 'halt',
      message: 'Model returned empty responses repeatedly without progressing. Terminating turn cleanly.',
      consecutiveCycles: 0,
      recoveryAttempts: this.consecutiveEmptyResponses
    };
  }

  resetEmptyResponseCount() {
    this.consecutiveEmptyResponses = 0;
  }

  /**
   * Records a tool result and updates circuit breaker / failure counters.
   */
  recordToolResult(isError: boolean, isCommandDiagnostic: boolean = false): { tripCircuitBreaker: boolean; consecutiveFailures: number } {
    if (isError) {
      if (!isCommandDiagnostic) {
        this.consecutiveToolFailures++;
      }
    } else {
      this.consecutiveToolFailures = 0;
    }

    return {
      tripCircuitBreaker: this.consecutiveToolFailures >= this.maxConsecutiveFailures,
      consecutiveFailures: this.consecutiveToolFailures
    };
  }

  /**
   * Tracks file oscillation (reverting to a previously observed hash state).
   */
  recordFileHash(filePath: string, content: string): { isOscillation: boolean; editCount: number } {
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    const pastHashes = this.fileContentHashes.get(filePath) || [];
    const editCount = (this.fileEditCounts.get(filePath) || 0) + 1;
    this.fileEditCounts.set(filePath, editCount);

    const isOscillation = pastHashes.includes(hash);
    if (!isOscillation) {
      pastHashes.push(hash);
      if (pastHashes.length > 6) pastHashes.shift();
      this.fileContentHashes.set(filePath, pastHashes);
    }

    return { isOscillation, editCount };
  }

  resetRepetitionOnRealChange() {
    this.recentToolSignatures = [];
    this.consecutiveCycleDetections = 0;
    this.stagnationDetector.resetRecoveryAttempts();
  }
}
