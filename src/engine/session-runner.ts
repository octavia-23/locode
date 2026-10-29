import { AgentContext, ChatMessage } from '../types.js';
import { ExecutionJournal } from '../journal/journal.js';
import { SessionMemory } from '../agent/memory.js';
import { HarnessExecutionProfile } from '../runtime/profiles.js';

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

export class SessionRunner {
  private cwd: string;
  private journal: ExecutionJournal;
  private memory: SessionMemory;
  private stats: SessionStats;
  private turnCost: number = 0;
  private objective: string = '';
  private stepCount: number = 0;

  constructor(cwd: string, journal?: ExecutionJournal, memory?: SessionMemory) {
    this.cwd = cwd;
    this.journal = journal || new ExecutionJournal({ cwd });
    this.memory = memory || new SessionMemory(cwd);
    this.stats = {
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
  }

  getJournal(): ExecutionJournal {
    return this.journal;
  }

  getSessionMemory(): SessionMemory {
    return this.memory;
  }

  getStats(): SessionStats {
    return this.stats;
  }

  getTurnCost(): number {
    return this.turnCost;
  }

  setTurnCost(cost: number) {
    this.turnCost = cost;
  }

  getStepCount(): number {
    return this.stepCount;
  }

  incrementStep(): number {
    this.stepCount++;
    return this.stepCount;
  }

  incrementStat(key: keyof SessionStats, delta: number = 1): void {
    if (typeof this.stats[key] === 'number') {
      (this.stats[key] as number) += delta;
    }
  }

  async initializeSession(prompt: string, profile: HarnessExecutionProfile, context: AgentContext): Promise<void> {
    this.objective = prompt;
    this.stepCount = 0;
    this.turnCost = 0;

    await this.journal.init();
    await this.journal.recordEvent('task_started', {
      objective: prompt,
      model: context.model,
      provider: context.provider,
      executionProfile: profile,
      cwd: context.cwd
    });
  }

  recordTurnMetrics(
    usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number; durationMs?: number },
    reconciledCost?: number,
    costPolicy?: HarnessExecutionProfile['costPolicy']
  ): { budgetExceeded: boolean; alertTriggered: boolean; reason?: string } {
    if (usage) {
      this.stats.turns++;
      this.stats.totalTokens += usage.totalTokens || 0;
      this.stats.promptTokens += usage.promptTokens || 0;
      this.stats.completionTokens += usage.completionTokens || 0;
      this.stats.totalDurationMs += usage.durationMs || 0;
    }

    if (typeof reconciledCost === 'number') {
      this.turnCost = reconciledCost;
    }

    let budgetExceeded = false;
    let alertTriggered = false;
    let reason: string | undefined;

    if (costPolicy) {
      if (costPolicy.alertOnCostThreshold && this.turnCost >= 0.5) {
        alertTriggered = true;
      }
      if (costPolicy.maxCostPerTurn && this.turnCost >= costPolicy.maxCostPerTurn) {
        budgetExceeded = true;
        reason = `Turn cost $${this.turnCost.toFixed(4)} exceeded maximum allowed cost per turn ($${costPolicy.maxCostPerTurn.toFixed(2)}).`;
      }
    }

    return { budgetExceeded, alertTriggered, reason };
  }

  checkBudgetAndLimits(profile: HarnessExecutionProfile): { exceeded: boolean; reason?: string } {
    if (profile.costPolicy?.maxCostPerTurn && this.turnCost >= profile.costPolicy.maxCostPerTurn) {
      return {
        exceeded: true,
        reason: `Turn cost $${this.turnCost.toFixed(4)} exceeds maximum spend per turn limit ($${profile.costPolicy.maxCostPerTurn.toFixed(2)}).`
      };
    }
    return { exceeded: false };
  }

  async persistCheckpoint(data?: {
    pendingObjectives?: string[];
    completedObjectives?: string[];
    decisions?: string[];
    checkpoint?: string;
  }): Promise<void> {
    await this.journal.createSnapshot(data);
  }

  async finalizeSession(
    status: 'success' | 'stopped' | 'failed',
    summary?: string,
    contextState?: {
      model?: string;
      messages?: ChatMessage[];
      decisions?: string[];
      recentFiles?: string[];
      pendingObjectives?: string[];
      completedObjectives?: string[];
      checkpoint?: string;
    }
  ): Promise<void> {
    if (contextState && contextState.messages) {
      await this.memory.saveSession({
        model: contextState.model || 'default',
        messages: contextState.messages,
        lastDecisions: contextState.decisions || [],
        recentFiles: contextState.recentFiles || [],
        summary: summary || '',
        checkpoint: contextState.checkpoint
      });
    }

    if (status === 'success' || status === 'stopped') {
      await this.journal.recordEvent('task_completed', {
        finalStatus: status,
        totalTurns: this.stepCount,
        totalToolCalls: this.stats.toolCalls,
        summary
      });
    } else {
      await this.journal.recordEvent('task_failed', {
        error: summary || 'Task execution failed',
        consecutiveFailures: 1
      });
    }

    await this.journal.createSnapshot({
      pendingObjectives: contextState?.pendingObjectives,
      completedObjectives: contextState?.completedObjectives,
      decisions: contextState?.decisions,
      checkpoint: contextState?.checkpoint
    });
  }
}
