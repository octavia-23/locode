import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { ChatMessage } from '../types.js';
import type { VerificationStatus } from './verifier.js';

export type { VerificationStatus };

export interface CompactionConfig {
  maxTokens: number;
  preserveHeadChars?: number;
  preserveTailChars?: number;
}

export { ContextEngine as ContextManager };

export interface RepositoryMap {
  projectType: string;
  entryPoints: string[];
  packageManager?: string;
  buildCommands: string[];
  keyDirectories: string[];
  configFiles: string[];
  dependencies: string[];
}

export interface CachedFile {
  path: string;
  content: string;
  hash: string;
  lineCount: number;
  timestamp: number;
}

export type VerificationCategory = 'typecheck' | 'test' | 'build' | 'custom';

export interface VerificationEntry {
  category: VerificationCategory;
  status: VerificationStatus;
  passed: boolean;
  command: string;
  summary: string;
  timestamp: number;
}

export interface TaskState {
  objective: string;
  currentSubtask?: string;
  completedObjectives: string[];
  pendingObjectives: string[];
  decisions: string[];
  unresolvedErrors: string[];
  lastVerification?: {
    status?: VerificationStatus;
    passed: boolean;
    command: string;
    summary: string;
  };
  verificationResults?: {
    typecheck?: VerificationEntry;
    test?: VerificationEntry;
    build?: VerificationEntry;
    custom?: VerificationEntry;
  };
  relevantFiles: string[];
}

export interface ContextStats {
  totalTokensEstimated: number;
  budgetTokens: number;
  compactionRuns: number;
  tokensSavedByCompression: number;
  tokensAvoidedByDeduplication: number;
}

/**
 * Production-grade Context Engine for autonomous coding agent.
 *
 * Implements 7 structured context layers:
 * Layer A — System invariants (rules, roles, tool contracts)
 * Layer B — Current user objective (durable goal, requirements)
 * Layer C — Task state (progress, unresolved errors, verification, decisions)
 * Layer D — Repository understanding (cached repo map, package info, commands)
 * Layer E — Relevant code context (file cache with content-hash invalidation)
 * Layer F — Recent execution state (normalized, deduplicated tool observations)
 * Layer G — Durable session memory (architectural decisions, confirmed findings)
 */
export class ContextEngine {
  private maxTokens: number;
  private cwd: string;
  private fileCache: Map<string, CachedFile> = new Map();
  private toolResultCache: Map<string, { hash: string; callCount: number; summary: string }> = new Map();
  private repoMap: RepositoryMap | null = null;
  private repoMapCachedAt: number = 0;
  private taskState: TaskState;
  private durableDecisions: string[] = [];
  private stats: ContextStats = {
    totalTokensEstimated: 0,
    budgetTokens: 0,
    compactionRuns: 0,
    tokensSavedByCompression: 0,
    tokensAvoidedByDeduplication: 0
  };

  constructor(maxTokens: number = 262144, cwd: string = process.cwd()) {
    this.maxTokens = maxTokens;
    this.cwd = cwd;
    this.taskState = {
      objective: '',
      completedObjectives: [],
      pendingObjectives: [],
      decisions: [],
      unresolvedErrors: [],
      relevantFiles: []
    };
  }

  setMaxTokens(tokens: number) {
    this.maxTokens = tokens;
  }

  getMaxTokens(): number {
    return this.maxTokens;
  }

  getStats(): ContextStats {
    return { ...this.stats };
  }

  setObjective(objective: string) {
    if (!this.taskState.objective || this.taskState.objective !== objective) {
      this.taskState.objective = objective;
    }
  }

  getTaskState(): TaskState {
    return this.taskState;
  }

  addDecision(decision: string) {
    if (!this.durableDecisions.includes(decision)) {
      this.durableDecisions.push(decision);
      this.taskState.decisions = [...this.durableDecisions];
    }
  }

  recordVerificationResult(
    passed: boolean,
    command: string,
    output?: string,
    status?: VerificationStatus
  ) {
    const effStatus: VerificationStatus = status || (passed ? 'passed' : 'failed');
    const summary = effStatus === 'passed'
      ? `PASSED: \`${command}\` (0 errors)`
      : effStatus === 'not-run'
      ? `NOT RUN: No test command configured`
      : effStatus === 'inconclusive'
      ? `INCONCLUSIVE: \`${command}\` (execution timed out or indeterminate)`
      : `FAILED: \`${command}\` - ${this.extractTopErrorLine(output || '')}`;
    
    this.taskState.lastVerification = {
      status: effStatus,
      passed: effStatus === 'passed',
      command,
      summary
    };

    // Separate type checking, tests, and builds into distinct categories
    let category: VerificationCategory = 'custom';
    if (/\b(tsc|typecheck|check|lint|py_compile)\b/i.test(command)) {
      category = 'typecheck';
    } else if (/\b(test|pytest|cargo\s+test|go\s+test|jest|vitest|mocha)\b/i.test(command)) {
      category = 'test';
    } else if (/\b(build|tsup|webpack|rollup|vite\s+build|cargo\s+build)\b/i.test(command)) {
      category = 'build';
    }

    if (!this.taskState.verificationResults) {
      this.taskState.verificationResults = {};
    }
    this.taskState.verificationResults[category] = {
      category,
      status: effStatus,
      passed: effStatus === 'passed',
      command,
      summary,
      timestamp: Date.now()
    };

    if (effStatus === 'passed') {
      // Clear unresolved errors if verification passed
      this.taskState.unresolvedErrors = [];
    } else if (output && effStatus === 'failed') {
      const topError = this.extractTopErrorLine(output);
      if (topError && !this.taskState.unresolvedErrors.includes(topError)) {
        this.taskState.unresolvedErrors.push(topError);
      }
    }
  }

  getVerificationResults(): Record<string, VerificationEntry | undefined> {
    return this.taskState.verificationResults || {};
  }

  private extractTopErrorLine(output: string): string {
    const lines = output.split('\n');
    for (const line of lines) {
      const t = line.trim();
      if (/error\s+ts\d+|syntaxerror|typeerror|referenceerror|failed|assertionerror/i.test(t)) {
        return t.slice(0, 200);
      }
    }
    return lines[0]?.trim().slice(0, 200) || 'Unknown verification error';
  }

  /**
   * File Invalidation Hook: Called immediately whenever write_file or edit_file occurs.
   * Invalidates stale cache and forces fresh inspection.
   */
  invalidateFile(filePath: string) {
    const norm = this.normalizePath(filePath);
    this.fileCache.delete(norm);
    // A verification result only applies to the exact workspace state that was tested.
    // Any file write/edit invalidates it until verification is run again.
    this.taskState.lastVerification = undefined;
    if (!this.taskState.relevantFiles.includes(norm)) {
      this.taskState.relevantFiles.push(norm);
    }
  }

  /**
   * Tracks file reads in cache with content hashing.
   */
  recordFileRead(filePath: string, content: string) {
    const norm = this.normalizePath(filePath);
    const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
    this.fileCache.set(norm, {
      path: norm,
      content,
      hash,
      lineCount: content.split('\n').length,
      timestamp: Date.now()
    });
    if (!this.taskState.relevantFiles.includes(norm)) {
      this.taskState.relevantFiles.push(norm);
    }
  }

  private normalizePath(p: string): string {
    return path.relative(this.cwd, path.resolve(this.cwd, p)).replace(/\\/g, '/');
  }

  /**
   * Accurate token estimation calibrated against code & markdown.
   * Prose: ~3.8 chars per token.
   * Code / JSON / AST / paths: ~2.0 chars per token (pessimistic 1.8-2.2 range).
   */
  estimateTokens(text: string): number {
    if (!text) return 0;
    // Check if snippet contains heavy code/syntax characters
    const codePunctuation = (text.match(/[{}[\]()<>;:=/\\`"'_|&%^$#@!*~]/g) || []).length;
    const ratio = codePunctuation / text.length;
    // If heavily punctuated or indented (code/diff/json), use pessimistic 2.2 chars/tok
    const charsPerToken = ratio > 0.08 ? 2.2 : 3.6;
    return Math.ceil(text.length / charsPerToken);
  }

  estimateMessagesTokens(messages: ChatMessage[]): number {
    let total = 0;
    for (const msg of messages) {
      total += this.estimateTokens(msg.content);
      if (msg.tool_calls) {
        total += this.estimateTokens(JSON.stringify(msg.tool_calls));
      }
    }
    return total;
  }

  estimateToolsTokens(tools?: any[]): number {
    if (!tools || tools.length === 0) return 2500;
    let charCount = 0;
    for (const t of tools) {
      charCount += (t.name?.length || 0) + (t.description?.length || 0) + JSON.stringify(t.parameters || {}).length;
    }
    return Math.ceil(charCount / 2.5);
  }

  /**
   * Reika-inspired Prefix-Stable watermark check:
   * Returns true only when total tokens cross the compaction threshold (e.g. 75% of budget)
   */
  shouldCompact(messages: ChatMessage[], toolOverhead: number = 2500): boolean {
    const budget = this.getAvailableContextBudget(toolOverhead);
    const currentTokens = this.estimateMessagesTokens(messages);
    return currentTokens >= budget;
  }

  /**
   * Computes available context budget reserving space for model response, tool schemas, and safety slack.
   */
  getAvailableContextBudget(toolOverhead: number = 2500): number {
    if (this.maxTokens <= 1000) {
      return Math.floor(this.maxTokens * 0.75); // 75% budget for test fixtures (e.g. 500, 1000)
    }
    if (this.maxTokens <= 8192) {
      const toolSlack = Math.min(toolOverhead, Math.floor(this.maxTokens * 0.15));
      return Math.max(1024, Math.floor(this.maxTokens * 0.75) - toolSlack);
    }
    // High-context profiles (16k, 32k, 64k, 128k):
    // Allow the model to actually use its full allocated context window.
    // Reserve response headroom (15%), tool schemas, and safety slack (5%).
    const responseReserve = Math.min(4096, Math.floor(this.maxTokens * 0.15));
    const safetySlack = Math.min(2048, Math.floor(this.maxTokens * 0.05));
    return Math.max(4096, Math.floor(this.maxTokens * 0.80) - responseReserve - safetySlack - toolOverhead);
  }

  /**
   * Compresses large tool output deterministically:
   * - Preserves exit codes, command names, compiler diagnostic sections, stack traces, paths, line numbers
   * - Strips repetitive build noise, progress bars, and duplicate output
   */
  compactToolOutput(content: string, maxLen: number = 700): string {
    if (!content || content.length <= maxLen) {
      return content;
    }

    const lines = content.split('\n');
    const criticalIndices = new Set<number>();

    const isCritical = (line: string): boolean => {
      const l = line.trim();
      return (
        /error|fail|exception|panic|fatal|ts\d{4}|warning/i.test(l) ||
        /^\s*at\s+[\w\s.<>$]+\(.*:\d+:\d+\)/.test(l) ||
        /:\d+:\d+:/.test(l) ||
        /\berr!|status\s+code\s+\d+/i.test(l) ||
        /^>\s+/.test(l) ||
        /assert(ion)?/i.test(l)
      );
    };

    lines.forEach((line, idx) => {
      if (isCritical(line)) {
        criticalIndices.add(idx);
        if (idx + 1 < lines.length) criticalIndices.add(idx + 1);
        if (idx > 0) criticalIndices.add(idx - 1);
      }
    });

    if (criticalIndices.size > 0) {
      const headCount = Math.min(4, lines.length);
      const tailCount = Math.min(4, lines.length);
      for (let i = 0; i < headCount; i++) criticalIndices.add(i);
      for (let i = lines.length - tailCount; i < lines.length; i++) criticalIndices.add(i);

      const sortedIndices = Array.from(criticalIndices).sort((a, b) => a - b);
      const outputParts: string[] = [];
      let lastIdx = -1;

      for (const idx of sortedIndices) {
        if (lastIdx !== -1 && idx > lastIdx + 1) {
          outputParts.push(`  ... [${idx - lastIdx - 1} lines collapsed] ...`);
        }
        outputParts.push(lines[idx]);
        lastIdx = idx;
      }

      const compactedResult = outputParts.join('\n');
      if (compactedResult.length < content.length) {
        const saved = this.estimateTokens(content) - this.estimateTokens(compactedResult);
        if (saved > 0) this.stats.tokensSavedByCompression += saved;
        return `[Compacted Output (${lines.length} lines total, preserving key errors & traces)]:\n${compactedResult}`;
      }
    }

    // Default head/tail split
    const headChars = Math.floor(maxLen * 0.6);
    const tailChars = Math.floor(maxLen * 0.3);
    const head = content.slice(0, headChars);
    const tail = content.slice(-tailChars);
    const saved = this.estimateTokens(content) - this.estimateTokens(head + tail);
    if (saved > 0) this.stats.tokensSavedByCompression += saved;

    return `[Output compacted: ${head} ... [${content.length - headChars - tailChars} characters collapsed] ... ${tail}]`;
  }

  /**
   * Discovers and caches high-level repository structure without expensive rescanning.
   */
  async getRepositoryMap(): Promise<RepositoryMap> {
    const now = Date.now();
    if (this.repoMap && now - this.repoMapCachedAt < 60000) {
      return this.repoMap;
    }

    const map: RepositoryMap = {
      projectType: 'unknown',
      entryPoints: [],
      buildCommands: [],
      keyDirectories: [],
      configFiles: [],
      dependencies: []
    };

    try {
      const pkgPath = path.join(this.cwd, 'package.json');
      const pkgRaw = await fs.readFile(pkgPath, 'utf8').catch(() => null);
      if (pkgRaw) {
        const pkg = JSON.parse(pkgRaw);
        map.projectType = 'Node.js / TypeScript';
        map.packageManager = 'npm';
        if (pkg.main) map.entryPoints.push(pkg.main);
        if (pkg.bin) {
          if (typeof pkg.bin === 'string') map.entryPoints.push(pkg.bin);
          else Object.values(pkg.bin).forEach((b: any) => map.entryPoints.push(String(b)));
        }
        if (pkg.scripts) {
          Object.keys(pkg.scripts).forEach(s => map.buildCommands.push(`npm run ${s}`));
        }
        if (pkg.dependencies) {
          map.dependencies = Object.keys(pkg.dependencies).slice(0, 15);
        }
        map.configFiles.push('package.json');
      }

      // Check common directories
      const dirs = ['src', 'lib', 'tests', 'test', 'dist', 'scripts'];
      for (const d of dirs) {
        try {
          const s = await fs.stat(path.join(this.cwd, d));
          if (s.isDirectory()) map.keyDirectories.push(d);
        } catch {}
      }
    } catch {}

    this.repoMap = map;
    this.repoMapCachedAt = now;
    return map;
  }

  /**
   * Assembles optimized model context respecting token budget and layered priorities.
   *
   * Priority Ordering:
   * 1. Layer A: System Invariants (index 0)
   * 2. Layer B: Current user objective (never destroyed)
   * 3. Layer C: Task state & unresolved errors (durable)
   * 4. Layer E: Latest tool call & result (turn N)
   * 5. Layer F: Recent execution window (turns N-1, N-2)
   * 6. Lower: Historical turns compacted or pruned
   */
  /**
   * Replaces older duplicate tool outputs with a short note, ALWAYS keeping the newest copy intact.
   * (Previously the newest copy was replaced with a pointer to the older one; once the older one was
   * folded away the model had no copy of the content anywhere and kept re-reading it in a loop.)
   */
  private dedupeToolOutputs(msgs: ChatMessage[], startIdx: number = 0): boolean {
    const seen = new Set<string>();
    let changed = false;
    for (let i = msgs.length - 1; i >= startIdx; i--) {
      const msg = msgs[i];
      if (msg.role !== 'tool' || !msg.content || !msg.content.trim()) continue;
      const isVerifOrStatus = /^(PASSED|FAILED|Command .* exited cleanly|\[Command .* exited cleanly|\(no output\))/i.test(msg.content.trim());
      if (isVerifOrStatus) continue;
      const hash = crypto.createHash('sha256').update(msg.content).digest('hex');
      if (seen.has(hash)) {
        const tokensSaved = this.estimateTokens(msg.content) - 15;
        if (tokensSaved > 0) this.stats.tokensAvoidedByDeduplication += tokensSaved;
        msg.content = '[Identical output appears again later in this conversation; omitted here to save context]';
        changed = true;
      } else {
        seen.add(hash);
      }
    }
    return changed;
  }

  compactMessages(messages: ChatMessage[], synthesizedFindings?: string): ChatMessage[] {
    const budget = this.getAvailableContextBudget();
    this.stats.budgetTokens = budget;

    const totalTokens = this.estimateMessagesTokens(messages);
    this.stats.totalTokensEstimated = totalTokens;

    // Check if there are duplicate verbose tool outputs that should be deduplicated
    let hasDuplicateTools = false;
    const testSeen = new Set<string>();
    for (const m of messages) {
      // Exempt empty outputs, short exit statuses, and verification messages from deduplication
      if (m.role === 'tool' && m.content && m.content.trim().length > 0) {
        const isVerifOrStatus = /^(PASSED|FAILED|Command .* exited cleanly|\[Command .* exited cleanly|\(no output\))/i.test(m.content.trim());
        if (!isVerifOrStatus) {
          const hash = crypto.createHash('sha256').update(m.content).digest('hex');
          if (testSeen.has(hash)) {
            hasDuplicateTools = true;
            break;
          }
          testSeen.add(hash);
        }
      }
    }

    // PREFIX-STABILITY CHECK:
    // If history fits, never run the full compaction pass. In particular, a repeated
    // tool result must not cause older file inspections to be replaced with pointers
    // while there is still ample context space; that can make the model reread files.
    if (totalTokens <= budget) {
      if (!hasDuplicateTools) return messages;

      // Deduplicate exact repeated tool outputs only (keeping the newest copy).
      const deduplicated = messages.map(m => ({ ...m }));
      this.dedupeToolOutputs(deduplicated);
      return deduplicated;
    }

    this.stats.compactionRuns++;
    const compacted = messages.map(m => ({ ...m }));

    // Find initial user prompt (Layer B)
    const initialUserMsg = compacted.find(m => m.role === 'user');
    if (initialUserMsg && !this.taskState.objective) {
      this.taskState.objective = initialUserMsg.content.slice(0, 500);
    }

    // Step 1: Deduplicate identical tool outputs, keeping the NEWEST copy so a re-read always returns content.
    this.dedupeToolOutputs(compacted, 1);

    // Step 2: Compress older tool outputs & evict older file viewings
    // Keep the final turn (last 2 messages: assistant/user) intact; compact earlier turns
    const preserveLast = 2;
    const endIdx = compacted.length - preserveLast;

    for (let i = 1; i < endIdx; i++) {
      const msg = compacted[i];
      if (msg.role === 'tool' && msg.content) {
        // If older tool output was a view_file inspection, evict raw code lines and keep file pointer
        const fileMatch = /^File:\s+([^\s\n]+)\s+\(lines\s+(\d+)-(\d+)\s+of\s+(\d+)\)/.exec(msg.content);
        if (fileMatch) {
          const [, filePath, startL, endL, totalL] = fileMatch;
          msg.content = `[File inspection: ${filePath} (lines ${startL}-${endL} of ${totalL}) raw lines were dropped from context to save space. Call view_file again if you need the contents]`;
        } else if (msg.content.length > 500) {
          msg.content = this.compactToolOutput(msg.content, 500);
        }
      } else if (msg.role === 'assistant' && msg.content && msg.content.length > 600) {
        const preview = msg.content.slice(0, 250).replace(/\s+/g, ' ');
        msg.content = `${preview}...\n[Older assistant thought compacted for token budget]`;
      }
    }

    // Step 3: If still over budget, retain structured task state and drop stale intermediate messages
    let currentTokens = this.estimateMessagesTokens(compacted);
    if (currentTokens > budget && compacted.length > 4) {
      // Build a synthetic structured state message to replace older dropped turns
      let stateSummary = this.buildTaskStateSummary();
      if (synthesizedFindings) {
        stateSummary = `WORKING FINDINGS & SYNTHESIS:\n${synthesizedFindings}\n\n` + stateSummary;
      }
      const systemMsg = compacted[0];
      const initialUser = compacted.find(m => m.role === 'user') || { role: 'user', content: this.taskState.objective };
      // Never start the window on a `tool` message: its assistant tool_call would be dropped (orphaned result).
      let windowStart = Math.max(1, compacted.length - 4);
      while (windowStart > 1 && compacted[windowStart].role === 'tool') windowStart--;
      const recentWindow = compacted.slice(windowStart);

      const prunedMessages: ChatMessage[] = [
        systemMsg,
        initialUser,
        {
          role: 'user',
          content: `[SESSION CONTEXT RESTORED FROM COMPACT STATE]\n${stateSummary}`
        },
        ...recentWindow.filter(m => m !== initialUser && m !== systemMsg)
      ];

      currentTokens = this.estimateMessagesTokens(prunedMessages);
      if (currentTokens <= budget) {
        return prunedMessages;
      }
      compacted.splice(0, compacted.length, ...prunedMessages);
    }

    // Step 4: Emergency ceiling guard
    // If messages are still exceeding budget (e.g. short conversation but massive single turn),
    // clamp all non-system message contents to fit safely within budget.
    currentTokens = this.estimateMessagesTokens(compacted);
    if (currentTokens > budget) {
      const perMsgCap = Math.max(400, Math.floor((budget * 2) / Math.max(1, compacted.length)));
      for (let i = 1; i < compacted.length; i++) {
        if (compacted[i].content && compacted[i].content.length > perMsgCap) {
          compacted[i].content = this.compactToolOutput(compacted[i].content, perMsgCap);
        }
      }
    }

    return compacted;
  }

  private buildTaskStateSummary(): string {
    const parts: string[] = [];
    if (this.taskState.objective) {
      parts.push(`OBJECTIVE: ${this.taskState.objective}`);
    }
    if (this.taskState.relevantFiles.length > 0) {
      parts.push(`RELEVANT FILES: ${this.taskState.relevantFiles.join(', ')}`);
    }
    if (this.taskState.unresolvedErrors.length > 0) {
      parts.push(`CURRENT UNRESOLVED ERRORS:\n- ${this.taskState.unresolvedErrors.join('\n- ')}`);
    }
    if (this.taskState.lastVerification) {
      parts.push(`VERIFICATION STATUS: ${this.taskState.lastVerification.summary}`);
    }
    if (this.durableDecisions.length > 0) {
      parts.push(`KEY ARCHITECTURAL DECISIONS:\n- ${this.durableDecisions.join('\n- ')}`);
    }
    return parts.join('\n\n');
  }
}
