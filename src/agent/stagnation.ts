import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';

export interface SignalHistoryRecord {
  turn: number;
  toolCallId: string;
  normalizedTool: string;
  normalizedArgs: Record<string, any>;
  resultFingerprint: string;
  workspaceFingerprint: string;
  isError: boolean;
  testOutcome?: {
    passed: boolean;
    errorSignature: string;
    command?: string;
  };
  telemetry?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    stopReason?: string;
  };
}

export interface StagnationThresholds {
  maxEquivalentToolCalls: number;       // default 3: identical normalized tool + args + unchanged workspace
  maxCycleRepetitions: number;           // default 2 (period 2-4)
  maxUnchangedFailures: number;          // default 3: consecutive runs with identical errorSignature
  maxInspectionsWithoutEdit: number;     // default 6: inspections without modifying workspace
  maxRepeatedUnsuccessfulEdits: number;  // default 5: edits with isError or reverting oscillation
  maxRecoveryAttempts: number;           // default 2: bounded recovery attempts before clean termination
}

export const DEFAULT_STAGNATION_THRESHOLDS: StagnationThresholds = {
  maxEquivalentToolCalls: 3,
  maxCycleRepetitions: 2,
  maxUnchangedFailures: 3,
  maxInspectionsWithoutEdit: 8,
  maxRepeatedUnsuccessfulEdits: 5,
  maxRecoveryAttempts: 2
};

export const CLOUD_STAGNATION_THRESHOLDS: StagnationThresholds = {
  maxEquivalentToolCalls: 4,
  maxCycleRepetitions: 3,
  maxUnchangedFailures: 5,
  maxInspectionsWithoutEdit: 50,
  maxRepeatedUnsuccessfulEdits: 8,
  maxRecoveryAttempts: 4
};

export type StagnationReason =
  | 'EQUIVALENT_TOOL_CALLS'
  | 'PERIODIC_CYCLE'
  | 'UNCHANGED_TEST_FAILURE'
  | 'INSPECTION_WITHOUT_ACTION'
  | 'REPEATED_UNSUCCESSFUL_EDITS';

export interface StagnationDiagnosis {
  stagnated: boolean;
  reason?: StagnationReason;
  summary: string;
  evidence: string[];
  suggestedAction: string;
}

export class StagnationDetector {
  private history: SignalHistoryRecord[] = [];
  private thresholds: StagnationThresholds;
  private recoveryAttempts: number = 0;
  private lastWorkspaceFingerprint: string = 'initial';

  constructor(thresholds: Partial<StagnationThresholds> = {}) {
    this.thresholds = { ...DEFAULT_STAGNATION_THRESHOLDS, ...thresholds };
  }

  getThresholds(): StagnationThresholds {
    return { ...this.thresholds };
  }

  getRecoveryAttempts(): number {
    return this.recoveryAttempts;
  }

  incrementRecoveryAttempts(): number {
    this.recoveryAttempts++;
    return this.recoveryAttempts;
  }

  resetRecoveryAttempts(): void {
    this.recoveryAttempts = 0;
  }

  getHistory(): SignalHistoryRecord[] {
    return [...this.history];
  }

  /**
   * Normalizes tool arguments into a deterministic, canonical JSON-compatible object.
   * Strips non-essential whitespace, sorts object keys recursively.
   */
  static normalizeArguments(args: any): Record<string, any> {
    if (!args || typeof args !== 'object') {
      return {};
    }
    if (Array.isArray(args)) {
      return { items: args.map(item => typeof item === 'object' ? StagnationDetector.normalizeArguments(item) : item) };
    }

    const sortedKeys = Object.keys(args).sort();
    const normalized: Record<string, any> = {};

    for (const key of sortedKeys) {
      const val = args[key];
      if (val === null || val === undefined) {
        continue;
      }
      if (typeof val === 'string') {
        // Normalize file paths to forward slashes and trim
        let s = val.trim();
        if (key === 'path' || key === 'file' || key === 'cwd') {
          s = s.replace(/\\/g, '/').replace(/^\.\//, '');
        } else if (key === 'command' || key === 'cmd') {
          s = s.replace(/\s+/g, ' ');
        }
        normalized[key] = s;
      } else if (typeof val === 'object' && !Array.isArray(val)) {
        normalized[key] = StagnationDetector.normalizeArguments(val);
      } else if (Array.isArray(val)) {
        normalized[key] = val.map(item => {
          if (typeof item === 'object') return StagnationDetector.normalizeArguments(item);
          if (typeof item === 'string') {
            let s = item.trim();
            if (key === 'paths' || key === 'files') {
              s = s.replace(/\\/g, '/').replace(/^\.\//, '');
            }
            return s;
          }
          return item;
        });
      } else {
        normalized[key] = val;
      }
    }

    return normalized;
  }

  /**
   * Generates a deterministic SHA256 fingerprint for a tool result.
   */
  static fingerprintResult(result: string, isError: boolean): string {
    const sanitized = (result || '').trim().replace(/\r\n/g, '\n');
    return crypto
      .createHash('sha256')
      .update(`${isError ? 'ERR:' : 'OK:'}${sanitized}`)
      .digest('hex')
      .slice(0, 16);
  }

  /**
   * Fingerprints the actual tracked diff plus untracked file contents. `git diff --stat`
   * alone misses edits that keep the same line counts, which can make real progress look
   * like stagnation. For non-git directories, hash relevant file contents as a fallback.
   */
  static async computeWorkspaceFingerprint(cwd: string): Promise<string> {
    try {
      const { stdout: diff } = await execa('git diff --binary HEAD --', {
        cwd,
        shell: true,
        maxBuffer: 64 * 1024 * 1024
      });
      const { stdout: untracked } = await execa('git ls-files --others --exclude-standard -z', {
        cwd,
        shell: true
      });
      const hash = crypto.createHash('sha256');
      hash.update('tracked-diff\0').update(diff);
      const untrackedPaths = untracked.split('\0').filter(Boolean).sort();
      for (const relativePath of untrackedPaths) {
        const normRel = relativePath.replace(/\\/g, '/');
        if (normRel === '.locode' || normRel.startsWith('.locode/') || normRel.startsWith('.git/')) continue;
        const fullPath = path.resolve(cwd, relativePath);
        const root = path.resolve(cwd) + path.sep;
        if (!fullPath.startsWith(root)) continue;
        try {
          const content = await fs.readFile(fullPath);
          hash.update('\0untracked\0').update(relativePath).update('\0').update(content);
        } catch {
          // Ignore files that disappear between git listing and reading.
        }
      }
      if (!diff && untrackedPaths.length === 0) return 'clean';
      return hash.digest('hex').slice(0, 16);
    } catch {
      // Non-git fallback: recursively hash relevant filenames and file contents.
      const hash = crypto.createHash('sha256');
      const ignoredDirs = new Set(['.git', '.locode', 'node_modules', '.venv', 'venv', 'dist', 'build', 'coverage', '.next', 'target']);
      let bytesHashed = 0;
      let filesVisited = 0;
      const maxBytes = 32 * 1024 * 1024;
      const maxFiles = 20000;
      const walk = async (directory: string, relativeDirectory: string): Promise<void> => {
        if (filesVisited >= maxFiles || bytesHashed >= maxBytes) return;
        let entries;
        try {
          entries = await fs.readdir(directory, { withFileTypes: true });
        } catch {
          return;
        }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
          if (filesVisited >= maxFiles || bytesHashed >= maxBytes) break;
          if (entry.isDirectory() && ignoredDirs.has(entry.name)) continue;
          const absolute = path.join(directory, entry.name);
          const relative = path.posix.join(relativeDirectory, entry.name);
          if (entry.isDirectory()) {
            await walk(absolute, relative);
          } else if (entry.isFile()) {
            try {
              const stat = await fs.stat(absolute);
              hash.update(relative).update('\0').update(String(stat.size)).update('\0');
              if (stat.size <= 2 * 1024 * 1024 && bytesHashed + stat.size <= maxBytes) {
                hash.update(await fs.readFile(absolute));
                bytesHashed += stat.size;
              } else {
                hash.update(String(stat.mtimeMs));
              }
              filesVisited++;
            } catch {
              // Ignore transient filesystem errors.
            }
          }
        }
      };
      await walk(path.resolve(cwd), '');
      return `fallback-${hash.digest('hex').slice(0, 16)}`;
    }
  }

  /**
   * Computes a normalized error signature from compiler or test failure output.
   */
  static extractErrorSignature(output: string): string {
    if (!output) return 'no-error-output';
    const lines = output.split('\n');
    const matched: string[] = [];

    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      // TS error, syntax error, assertion failure, or exit code
      if (
        /error\s+TS\d+/i.test(t) ||
        /(TypeError|ReferenceError|SyntaxError|AssertionError|Error):\s+/i.test(t) ||
        /FAIL\s+.*|failed:\s+\d+/i.test(t) ||
        /Assertion\s+`[^`]+`\s+failed/i.test(t)
      ) {
        // Strip line/col numbers to match identical underlying error across trivial edits
        const normalizedLine = t
          .replace(/:\d+:\d+/g, ':LINE:COL')
          .replace(/\(\d+:\d+\)/g, '(LINE:COL)');
        matched.push(normalizedLine);
      }
    }

    if (matched.length > 0) {
      return matched.slice(0, 3).join(' | ');
    }

    // Fallback: first 2 non-empty lines sanitized
    return lines.filter(l => l.trim().length > 0).slice(0, 2).map(l => l.trim()).join(' | ').slice(0, 200);
  }

  /**
   * Records a progress signal for a completed tool execution step.
   */
  recordStep(record: SignalHistoryRecord): void {
    this.history.push(record);
    this.lastWorkspaceFingerprint = record.workspaceFingerprint;
  }

  /**
   * Diagnoses stagnation across all tracked progress signals.
   */
  diagnose(): StagnationDiagnosis {
    const len = this.history.length;
    if (len === 0) {
      return { stagnated: false, summary: '', evidence: [], suggestedAction: '' };
    }

    // 1. Detect repeated unchanged test/compiler failures (highest diagnostic specificity)
    const failureDiagnosis = this.checkUnchangedFailures();
    if (failureDiagnosis.stagnated) return failureDiagnosis;

    // 2. Detect repeated equivalent tool call + result with UNCHANGED workspace
    const eqDiagnosis = this.checkEquivalentToolCalls();
    if (eqDiagnosis.stagnated) return eqDiagnosis;

    // 3. Detect periodic cycles (A-B-A-B or A-B-C-A-B-C) without workspace change
    const cycleDiagnosis = this.checkPeriodicCycles();
    if (cycleDiagnosis.stagnated) return cycleDiagnosis;

    // 4. Detect repeated inspections without workspace modification
    const inspectionDiagnosis = this.checkInspectionWithoutAction();
    if (inspectionDiagnosis.stagnated) return inspectionDiagnosis;

    // 5. Detect repeated unsuccessful edits (continuous errors or reverting oscillation)
    const editDiagnosis = this.checkRepeatedUnsuccessfulEdits();
    if (editDiagnosis.stagnated) return editDiagnosis;

    return { stagnated: false, summary: '', evidence: [], suggestedAction: '' };
  }

  /**
   * Checks whether prospective tool call(s) continue an established stagnation pattern
   * rather than taking a materially different or corrective action.
   */
  isContinuingStagnation(toolCalls: Array<{ function: { name: string; arguments?: any } }>): boolean {
    const diag = this.diagnose();
    if (!diag.stagnated) {
      return false;
    }

    const len = this.history.length;
    if (len === 0) return false;
    const latest = this.history[len - 1];

    switch (diag.reason) {
      case 'UNCHANGED_TEST_FAILURE': {
        // Stagnation is continuing if the model tries to rerun the exact same failing test/command
        // without any intervening workspace edits.
        const failingCommand = String(latest.testOutcome?.command || latest.normalizedArgs?.command || '');
        for (const tc of toolCalls) {
          if (tc.function.name === 'run_command') {
            const cmd = StagnationDetector.normalizeArguments(tc.function.arguments)?.command;
            if (cmd === failingCommand) {
              return true;
            }
          }
          if (tc.function.name === 'verify') {
            return true;
          }
        }
        return false;
      }

      case 'EQUIVALENT_TOOL_CALLS': {
        // Stagnation is continuing if ANY incoming tool call matches the same tool and arguments
        for (const tc of toolCalls) {
          const normArgs = StagnationDetector.normalizeArguments(tc.function.arguments);
          if (
            tc.function.name === latest.normalizedTool &&
            JSON.stringify(normArgs) === JSON.stringify(latest.normalizedArgs)
          ) {
            return true;
          }
        }
        return false;
      }

      case 'INSPECTION_WITHOUT_ACTION': {
        const passiveTools = new Set(['view_file', 'search_code', 'batch_read_files', 'list_dir', 'find_by_name', 'grep_search', 'file_search']);
        const allPassive = toolCalls.every(tc => passiveTools.has(tc.function.name));
        if (!allPassive) {
          return false;
        }

        // Stagnation is continuing if the model is attempting to re-read targets
        // that have already been inspected in history.
        // If the model is inspecting a new, unread target, allow the read so the model
        // can inspect all necessary files to solve the task.
        const inspectedTargets = new Set<string>();
        for (const h of this.history) {
          const a = h.normalizedArgs || {};
          if (a.path) inspectedTargets.add(String(a.path).replace(/\\/g, '/').replace(/^\.\//, ''));
          if (a.file) inspectedTargets.add(String(a.file).replace(/\\/g, '/').replace(/^\.\//, ''));
          if (a.pattern) inspectedTargets.add(String(a.pattern));
          if (a.query) inspectedTargets.add(String(a.query));
          if (Array.isArray(a.paths)) {
            for (const p of a.paths) if (p) inspectedTargets.add(String(p).replace(/\\/g, '/').replace(/^\.\//, ''));
          }
          if (Array.isArray(a.files)) {
            for (const f of a.files) if (f) inspectedTargets.add(String(f).replace(/\\/g, '/').replace(/^\.\//, ''));
          }
        }

        for (const tc of toolCalls) {
          const normArgs = StagnationDetector.normalizeArguments(tc.function.arguments);
          const target = normArgs?.path || normArgs?.file || normArgs?.pattern || normArgs?.query;
          if (target && inspectedTargets.has(String(target).replace(/\\/g, '/').replace(/^\.\//, ''))) {
            return true;
          }
          if (Array.isArray(normArgs?.paths)) {
            for (const p of normArgs.paths) {
              if (p && inspectedTargets.has(String(p).replace(/\\/g, '/').replace(/^\.\//, ''))) return true;
            }
          }
          if (Array.isArray(normArgs?.files)) {
            for (const f of normArgs.files) {
              if (f && inspectedTargets.has(String(f).replace(/\\/g, '/').replace(/^\.\//, ''))) return true;
            }
          }
        }

        // If inspecting previously unread targets, do not block
        return false;
      }

      case 'PERIODIC_CYCLE': {
        // Stagnation is continuing if the incoming tool calls match recent cycle signatures
        for (const tc of toolCalls) {
          const normArgs = StagnationDetector.normalizeArguments(tc.function.arguments);
          const sig = `${tc.function.name}:${JSON.stringify(normArgs)}`;
          const historySigs = this.history.slice(-4).map(h => `${h.normalizedTool}:${JSON.stringify(h.normalizedArgs)}`);
          if (historySigs.includes(sig)) {
            return true;
          }
        }
        return false;
      }

      case 'REPEATED_UNSUCCESSFUL_EDITS': {
        // Stagnation is continuing if the model attempts to edit the same failing file without inspection or change
        const editTools = new Set(['edit_file', 'write_file']);
        for (const tc of toolCalls) {
          if (editTools.has(tc.function.name)) {
            const p = tc.function.arguments?.path;
            if (p && p === latest.normalizedArgs?.path) {
              return true;
            }
          }
        }
        return false;
      }

      default:
        return true;
    }
  }

  private checkEquivalentToolCalls(): StagnationDiagnosis {
    const len = this.history.length;
    if (len < this.thresholds.maxEquivalentToolCalls) {
      return { stagnated: false, summary: '', evidence: [], suggestedAction: '' };
    }

    const latest = this.history[len - 1];
    const latestArgStr = JSON.stringify(latest.normalizedArgs);

    let matchCount = 0;
    const evidence: string[] = [];

    // Look backward through recent history
    for (let i = len - 1; i >= 0; i--) {
      const item = this.history[i];
      const itemArgStr = JSON.stringify(item.normalizedArgs);

      if (
        item.normalizedTool === latest.normalizedTool &&
        itemArgStr === latestArgStr &&
        item.resultFingerprint === latest.resultFingerprint &&
        item.workspaceFingerprint === latest.workspaceFingerprint
      ) {
        matchCount++;
        evidence.push(
          `Turn ${item.turn}: ${item.normalizedTool}(${itemArgStr}) -> result [${item.resultFingerprint}], workspace [${item.workspaceFingerprint}]`
        );
      } else {
        // Discontinuity in identical call stream
        break;
      }
    }

    if (matchCount >= this.thresholds.maxEquivalentToolCalls) {
      return {
        stagnated: true,
        reason: 'EQUIVALENT_TOOL_CALLS',
        summary: `Repeated identical tool call \`${latest.normalizedTool}\` ${matchCount} times with identical result and unchanged workspace.`,
        evidence,
        suggestedAction: `Stop repeating \`${latest.normalizedTool}\`. Take a concrete implementation action or formulate an alternative approach.`
      };
    }

    return { stagnated: false, summary: '', evidence: [], suggestedAction: '' };
  }

  private checkPeriodicCycles(): StagnationDiagnosis {
    const len = this.history.length;
    if (len < 4) {
      return { stagnated: false, summary: '', evidence: [], suggestedAction: '' };
    }

    // Build signatures: "tool:argsHash:resultHash:wsHash"
    const signatures = this.history.map(h => {
      const argsHash = crypto.createHash('md5').update(JSON.stringify(h.normalizedArgs)).digest('hex').slice(0, 8);
      return `${h.normalizedTool}:${argsHash}:${h.resultFingerprint}:${h.workspaceFingerprint}`;
    });

    for (let p = 1; p <= 4; p++) {
      const minReps = p === 1 ? this.thresholds.maxEquivalentToolCalls : this.thresholds.maxCycleRepetitions;
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
        // Ensure that workspace state did not genuinely change between repetitions
        const recentRecords = this.history.slice(len - requiredLen);
        const uniqueWs = new Set(recentRecords.map(r => r.workspaceFingerprint));

        if (uniqueWs.size === 1) {
          const cyclePattern = pattern.map(s => s.split(':')[0]).join(' → ');
          const evidence = recentRecords.map(
            r => `Turn ${r.turn}: ${r.normalizedTool} (result: ${r.resultFingerprint})`
          );

          return {
            stagnated: true,
            reason: 'PERIODIC_CYCLE',
            summary: `Repeated cyclic tool sequence [${cyclePattern}] (period ${p}, ${minReps} repetitions) with no workspace progression.`,
            evidence,
            suggestedAction: `Break the cyclic loop [${cyclePattern}]. Choose a fundamentally different tool or file.`
          };
        }
      }
    }

    return { stagnated: false, summary: '', evidence: [], suggestedAction: '' };
  }

  private checkUnchangedFailures(): StagnationDiagnosis {
    const len = this.history.length;
    if (len < this.thresholds.maxUnchangedFailures) {
      return { stagnated: false, summary: '', evidence: [], suggestedAction: '' };
    }

    // Only failures that occur in an UNCHANGED workspace state count toward UNCHANGED_TEST_FAILURE.
    // If a source edit occurred (workspace fingerprint changed), subsequent test runs are legitimate verifications.
    const latestWs = this.history[len - 1].workspaceFingerprint;
    const failuresInCurrentWs: SignalHistoryRecord[] = [];

    for (let i = len - 1; i >= 0; i--) {
      const rec = this.history[i];
      if (rec.workspaceFingerprint !== latestWs) {
        // Intervening workspace modification occurred before this point
        break;
      }
      if (rec.testOutcome !== undefined) {
        if (!rec.testOutcome.passed) {
          failuresInCurrentWs.push(rec);
        } else {
          // A test passed in this workspace state
          break;
        }
      }
    }

    if (failuresInCurrentWs.length < this.thresholds.maxUnchangedFailures) {
      return { stagnated: false, summary: '', evidence: [], suggestedAction: '' };
    }

    const recent = failuresInCurrentWs.slice(0, this.thresholds.maxUnchangedFailures);
    const signatures = recent.map(r => r.testOutcome?.errorSignature);
    const firstSig = signatures[0];
    const allSameSig = signatures.every(s => s && s === firstSig);

    if (allSameSig) {
      const evidence = recent.map(
        r => `Turn ${r.turn}: \`${r.testOutcome?.command || 'test'}\` failed with: ${r.testOutcome?.errorSignature}`
      );

      return {
        stagnated: true,
        reason: 'UNCHANGED_TEST_FAILURE',
        summary: `Repeated test/verification failure with unchanged error signature across ${recent.length} attempts in unchanged workspace: "${firstSig}".`,
        evidence,
        suggestedAction: `Your recent changes did not alter or resolve the error. Edit the source code to fix the root cause before rerunning the test.`
      };
    }

    return { stagnated: false, summary: '', evidence: [], suggestedAction: '' };
  }

  private checkInspectionWithoutAction(): StagnationDiagnosis {
    const passiveTools = new Set(['view_file', 'search_code', 'batch_read_files', 'list_dir', 'find_by_name', 'grep_search', 'file_search']);
    const len = this.history.length;
    if (len < this.thresholds.maxInspectionsWithoutEdit) {
      return { stagnated: false, summary: '', evidence: [], suggestedAction: '' };
    }

    const inspectionThreshold = this.thresholds.maxInspectionsWithoutEdit;
    const recent = this.history.slice(-inspectionThreshold);
    const allPassive = recent.every(r => passiveTools.has(r.normalizedTool));
    const uniqueWs = new Set(recent.map(r => r.workspaceFingerprint));

    // This window must be at least the size of the threshold it tests. Previously,
    // `recent` was capped at inspectionThreshold but the predicate required threshold + 4
    // (or 12), making the high-volume branch unreachable.
    const highVolumeWindow = Math.max(inspectionThreshold + 4, 12);
    const highVolumeRecent = this.history.slice(-highVolumeWindow);
    const isHighInspectionVolume =
      this.history.length >= highVolumeWindow &&
      highVolumeRecent.every(r => passiveTools.has(r.normalizedTool)) &&
      new Set(highVolumeRecent.map(r => r.workspaceFingerprint)).size === 1;

    if ((allPassive && uniqueWs.size === 1) || isHighInspectionVolume) {
      const targets: string[] = [];
      for (const r of recent) {
        const a = r.normalizedArgs || {};
        if (a.path) targets.push(String(a.path).replace(/\\/g, '/').replace(/^\.\//, ''));
        else if (a.file) targets.push(String(a.file).replace(/\\/g, '/').replace(/^\.\//, ''));
        else if (a.pattern) targets.push(String(a.pattern));
        else if (a.query) targets.push(String(a.query));
        else if (Array.isArray(a.paths)) {
          targets.push(...a.paths.map((p: any) => String(p).replace(/\\/g, '/').replace(/^\.\//, '')));
        } else if (Array.isArray(a.files)) {
          targets.push(...a.files.map((f: any) => String(f).replace(/\\/g, '/').replace(/^\.\//, '')));
        } else {
          targets.push(JSON.stringify(a));
        }
      }
      const uniqueTargets = new Set(targets);

      const targetCounts = new Map<string, number>();
      for (const t of targets) {
        targetCounts.set(t, (targetCounts.get(t) || 0) + 1);
      }
      const maxTargetRepetitions = Math.max(...Array.from(targetCounts.values()), 0);
      const isRepeatedTarget = maxTargetRepetitions >= 2 || uniqueTargets.size < targets.length;
      if (isRepeatedTarget || isHighInspectionVolume) {
        const evidenceWindow = isHighInspectionVolume ? highVolumeRecent : recent;
        const evidence = evidenceWindow.map(
          r => `Turn ${r.turn}: ${r.normalizedTool}(${JSON.stringify(r.normalizedArgs).slice(0, 80)})`
        );

        return {
          stagnated: true,
          reason: 'INSPECTION_WITHOUT_ACTION',
          summary: `Executed ${evidenceWindow.length} consecutive inspection tool calls without applying any workspace edits${isRepeatedTarget ? ' (including repeated inspections of the same targets)' : ''}.`,
          evidence,
          suggestedAction: `Stop inspecting. Apply the required changes immediately using 'edit_file' or 'write_file'.`
        };
      }
    }

    return { stagnated: false, summary: '', evidence: [], suggestedAction: '' };
  }

  private checkRepeatedUnsuccessfulEdits(): StagnationDiagnosis {
    const editTools = new Set(['edit_file', 'write_file']);
    const recentEdits = this.history.filter(h => editTools.has(h.normalizedTool));
    if (recentEdits.length < this.thresholds.maxRepeatedUnsuccessfulEdits) {
      return { stagnated: false, summary: '', evidence: [], suggestedAction: '' };
    }

    const lastEdits = recentEdits.slice(-this.thresholds.maxRepeatedUnsuccessfulEdits);
    const allErrors = lastEdits.every(r => r.isError);

    if (allErrors) {
      const evidence = lastEdits.map(
        r => `Turn ${r.turn}: ${r.normalizedTool}(${JSON.stringify(r.normalizedArgs).slice(0, 80)}) failed`
      );

      return {
        stagnated: true,
        reason: 'REPEATED_UNSUCCESSFUL_EDITS',
        summary: `${this.thresholds.maxRepeatedUnsuccessfulEdits} consecutive edit attempts failed with errors.`,
        evidence,
        suggestedAction: `Check the exact file contents and line matching before guessing edits.`
      };
    }

    return { stagnated: false, summary: '', evidence: [], suggestedAction: '' };
  }

  /**
   * Builds a compact, high-density recovery prompt for the model.
   * Excludes verbose raw outputs while retaining task objective, repository status,
   * tried approaches, observed failures, and an explicit requirement to take a new action.
   */
  buildRecoveryDirective(objective: string, diagnosis: StagnationDiagnosis): string {
    const attemptedActions: string[] = [];
    const seen = new Set<string>();

    for (const h of this.history.slice(-8)) {
      const key = `${h.normalizedTool}:${JSON.stringify(h.normalizedArgs)}`;
      if (!seen.has(key)) {
        seen.add(key);
        attemptedActions.push(`- ${h.normalizedTool} with arguments: ${JSON.stringify(h.normalizedArgs).slice(0, 150)} (${h.isError ? 'FAILED' : 'SUCCESS'})`);
      }
    }

    const evidenceList = diagnosis.evidence.slice(-4).map(e => `  * ${e}`).join('\n');

    return `[BOUNDED STAGNATION RECOVERY DIRECTIVE - ATTEMPT ${this.recoveryAttempts}/${this.thresholds.maxRecoveryAttempts}]
Reason: ${diagnosis.summary}

Evidence:
${evidenceList}

Task Objective:
${objective}

Recent actions already attempted:
${attemptedActions.join('\n') || '- None'}

MANDATORY INSTRUCTIONS:
1. Do NOT repeat any identical tool call or cyclic pattern listed above.
2. Formulate a MATERIALLY DIFFERENT, evidence-based next step.
3. If an edit or command has failed repeatedly, explain the root blocker or apply an alternate surgical fix now.
4. If you have completely finished all required work, output your final conclusion now.`;
  }
}
