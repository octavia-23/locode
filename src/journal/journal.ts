import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  CURRENT_JOURNAL_VERSION,
  JournalEvent,
  JournalEventType,
  DurableJournalSnapshot,
  DurableToolRecord,
  TaskStartedPayload,
  FileChangeRecordedPayload,
  VerificationCompletedPayload,
  PermissionDecidedPayload,
  ToolCallProposedPayload,
  ToolExecutionStartedPayload,
  ToolExecutionCompletedPayload,
  TaskInterruptedPayload,
  TaskCompletedPayload,
  TaskFailedPayload
} from './types.js';
import { redactValue } from '../utils/secret-redactor.js';

export interface ExecutionJournalOptions {
  cwd: string;
  journalDir?: string;
  sessionId?: string;
  taskId?: string;
}

export class ExecutionJournal {
  private cwd: string;
  private journalDir: string;
  private journalFilePath: string;
  private snapshotFilePath: string;
  private sessionId: string;
  private taskId: string;
  private seq: number = 0;
  private snapshot: DurableJournalSnapshot;
  private initialized: boolean = false;

  constructor(options: ExecutionJournalOptions) {
    this.cwd = path.resolve(options.cwd);
    this.journalDir = options.journalDir
      ? path.resolve(options.journalDir)
      : path.resolve(this.cwd, '.locode', 'journal');
    this.journalFilePath = path.join(this.journalDir, 'journal.jsonl');
    this.snapshotFilePath = path.join(this.journalDir, 'snapshot.json');
    this.sessionId = options.sessionId || crypto.randomUUID();
    this.taskId = options.taskId || crypto.randomUUID();

    this.snapshot = this.createEmptySnapshot();
  }

  private createEmptySnapshot(): DurableJournalSnapshot {
    return {
      version: CURRENT_JOURNAL_VERSION,
      sessionId: this.sessionId,
      taskId: this.taskId,
      lastSeq: 0,
      updatedAt: new Date().toISOString(),
      objective: '',
      model: '',
      provider: '',
      executionProfile: {},
      pendingObjectives: [],
      completedObjectives: [],
      decisions: [],
      fileHashes: {},
      toolCalls: {},
      verificationResults: {},
      taskState: 'running'
    };
  }

  getJournalDir(): string {
    return this.journalDir;
  }

  getJournalFilePath(): string {
    return this.journalFilePath;
  }

  getSnapshotFilePath(): string {
    return this.snapshotFilePath;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getTaskId(): string {
    return this.taskId;
  }

  getSnapshot(): DurableJournalSnapshot {
    return JSON.parse(JSON.stringify(this.snapshot));
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await fs.mkdir(this.journalDir, { recursive: true });

    // Attempt to load existing snapshot or replay existing events to recover sequence number
    const existingSnapshot = await this.readSnapshot();
    if (existingSnapshot && existingSnapshot.version === CURRENT_JOURNAL_VERSION) {
      this.snapshot = existingSnapshot;
      this.seq = existingSnapshot.lastSeq;
      this.sessionId = existingSnapshot.sessionId;
      this.taskId = existingSnapshot.taskId;
    } else {
      // If no valid snapshot, check if journal.jsonl exists and replay valid events
      const events = await this.readEvents();
      if (events.length > 0) {
        this.snapshot = this.replayEvents(events);
        this.seq = this.snapshot.lastSeq;
        this.sessionId = this.snapshot.sessionId;
        this.taskId = this.snapshot.taskId;
      }
    }

    this.initialized = true;
  }

  /**
   * Appends an event to journal.jsonl in an append-only, crash-safe manner.
   * Payloads are sanitized for secrets and truncated to prevent bloating the journal.
   */
  async recordEvent<T = any>(
    type: JournalEventType,
    rawPayload: T,
    toolCallId?: string
  ): Promise<JournalEvent<T>> {
    if (!this.initialized) {
      await this.init();
    }

    this.seq++;
    const timestamp = new Date().toISOString();

    // 1. Sanitize payload: redact secrets and enforce size bounds on large raw text
    const cleanPayload = this.sanitizePayload(rawPayload);

    // 2. Compute checksum
    const checksum = crypto
      .createHash('sha256')
      .update(`${this.seq}:${type}:${timestamp}:${JSON.stringify(cleanPayload)}`)
      .digest('hex')
      .slice(0, 16);

    const event: JournalEvent<T> = {
      version: CURRENT_JOURNAL_VERSION,
      sessionId: this.sessionId,
      taskId: this.taskId,
      seq: this.seq,
      timestamp,
      type,
      toolCallId,
      payload: cleanPayload,
      checksum
    };

    // 3. Append to journal.jsonl
    const line = JSON.stringify(event) + '\n';
    await fs.appendFile(this.journalFilePath, line, 'utf8');

    // 4. Update in-memory snapshot
    this.applyEventToSnapshot(this.snapshot, event);

    // 5. On milestone events, atomically persist snapshot
    if (
      type === 'task_completed' ||
      type === 'task_failed' ||
      type === 'task_interrupted' ||
      type === 'verification_completed' ||
      type === 'file_change_recorded'
    ) {
      await this.createSnapshot();
    }

    return event;
  }

  /**
   * Sanitizes payload by stripping secrets and truncating long output strings.
   */
  private sanitizePayload(payload: any): any {
    if (payload === null || payload === undefined) return payload;

    // Redact secrets recursively
    const redacted = redactValue(payload);

    // Deep truncate very large strings in tool output or error summaries
    const truncateDeep = (obj: any): any => {
      if (typeof obj === 'string') {
        if (obj.length > 2000) {
          return obj.slice(0, 2000) + '... [TRUNCATED_FOR_JOURNAL]';
        }
        return obj;
      }
      if (Array.isArray(obj)) {
        return obj.map(truncateDeep);
      }
      if (obj && typeof obj === 'object') {
        const res: Record<string, any> = {};
        for (const [k, v] of Object.entries(obj)) {
          res[k] = truncateDeep(v);
        }
        return res;
      }
      return obj;
    };

    return truncateDeep(redacted);
  }

  /**
   * Updates a snapshot based on an event.
   */
  private applyEventToSnapshot(snapshot: DurableJournalSnapshot, event: JournalEvent): void {
    snapshot.lastSeq = Math.max(snapshot.lastSeq, event.seq);
    snapshot.updatedAt = event.timestamp;
    snapshot.sessionId = event.sessionId;
    snapshot.taskId = event.taskId;

    switch (event.type) {
      case 'task_started': {
        const p = event.payload as TaskStartedPayload;
        snapshot.objective = p.objective || snapshot.objective;
        snapshot.model = p.model || snapshot.model;
        snapshot.provider = p.provider || snapshot.provider;
        if (p.executionProfile) {
          snapshot.executionProfile = { ...snapshot.executionProfile, ...p.executionProfile };
        }
        snapshot.taskState = 'running';
        break;
      }

      case 'tool_call_proposed': {
        const p = event.payload as ToolCallProposedPayload;
        const callId = event.toolCallId || p.toolCallId;
        if (callId) {
          snapshot.toolCalls[callId] = {
            toolCallId: callId,
            toolName: p.toolName,
            proposed: true,
            started: false,
            completed: false,
            arguments: p.arguments
          };
        }
        break;
      }

      case 'permission_decided': {
        const p = event.payload as PermissionDecidedPayload;
        const callId = event.toolCallId || p.toolCallId;
        if (callId && snapshot.toolCalls[callId]) {
          snapshot.toolCalls[callId].permissionDecision = p.decision;
          snapshot.toolCalls[callId].permissionAllowed = p.allowed;
        }
        break;
      }

      case 'tool_execution_started': {
        const p = event.payload as ToolExecutionStartedPayload;
        const callId = event.toolCallId || p.toolCallId;
        if (callId) {
          if (!snapshot.toolCalls[callId]) {
            snapshot.toolCalls[callId] = {
              toolCallId: callId,
              toolName: p.toolName,
              proposed: true,
              started: true,
              completed: false
            };
          } else {
            snapshot.toolCalls[callId].started = true;
          }
        }
        break;
      }

      case 'tool_execution_completed': {
        const p = event.payload as ToolExecutionCompletedPayload;
        const callId = event.toolCallId || p.toolCallId;
        if (callId) {
          if (!snapshot.toolCalls[callId]) {
            snapshot.toolCalls[callId] = {
              toolCallId: callId,
              toolName: p.toolName,
              proposed: true,
              started: true,
              completed: true,
              status: p.status,
              isError: p.isError
            };
          } else {
            snapshot.toolCalls[callId].completed = true;
            snapshot.toolCalls[callId].status = p.status;
            snapshot.toolCalls[callId].isError = p.isError;
          }
        }
        break;
      }

      case 'file_change_recorded': {
        const p = event.payload as FileChangeRecordedPayload;
        if (p.path && p.afterHash) {
          snapshot.fileHashes[p.path] = p.afterHash;
        }
        const callId = event.toolCallId || p.toolCallId;
        if (callId && snapshot.toolCalls[callId]) {
          snapshot.toolCalls[callId].fileChanges = snapshot.toolCalls[callId].fileChanges || [];
          snapshot.toolCalls[callId].fileChanges!.push({
            path: p.path,
            beforeHash: p.beforeHash,
            afterHash: p.afterHash,
            changed: p.changed
          });
        }
        break;
      }

      case 'verification_completed': {
        const p = event.payload as VerificationCompletedPayload;
        if (p.command) {
          snapshot.verificationResults[p.command] = {
            category: p.category,
            status: p.status,
            passed: p.passed,
            command: p.command,
            summary: p.summary
          };
        }
        break;
      }

      case 'task_interrupted': {
        snapshot.taskState = 'interrupted';
        break;
      }

      case 'task_completed': {
        snapshot.taskState = 'completed';
        break;
      }

      case 'task_failed': {
        snapshot.taskState = 'failed';
        break;
      }
    }
  }

  /**
   * Persists the snapshot atomically to snapshot.json using a temporary file and rename.
   */
  async createSnapshot(additionalState?: {
    pendingObjectives?: string[];
    completedObjectives?: string[];
    decisions?: string[];
    checkpoint?: string;
  }): Promise<DurableJournalSnapshot> {
    if (additionalState) {
      if (additionalState.pendingObjectives) {
        this.snapshot.pendingObjectives = [...additionalState.pendingObjectives];
      }
      if (additionalState.completedObjectives) {
        this.snapshot.completedObjectives = [...additionalState.completedObjectives];
      }
      if (additionalState.decisions) {
        this.snapshot.decisions = [...additionalState.decisions];
      }
      if (additionalState.checkpoint) {
        this.snapshot.checkpoint = additionalState.checkpoint;
      }
    }

    this.snapshot.updatedAt = new Date().toISOString();
    const serialized = JSON.stringify(this.snapshot, null, 2);

    const tmpPath = path.join(
      this.journalDir,
      `snapshot.json.tmp.${Date.now()}.${Math.floor(Math.random() * 100000)}`
    );

    await fs.writeFile(tmpPath, serialized, 'utf8');
    await fs.rename(tmpPath, this.snapshotFilePath);

    return this.getSnapshot();
  }

  /**
   * Reads and parses all valid events from journal.jsonl.
   * Safely ignores trailing partial/corrupted lines resulting from crashes.
   */
  async readEvents(): Promise<JournalEvent[]> {
    try {
      const content = await fs.readFile(this.journalFilePath, 'utf8');
      const lines = content.split(/\r?\n/);
      const events: JournalEvent[] = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        try {
          const parsed = JSON.parse(line);
          if (
            typeof parsed === 'object' &&
            parsed !== null &&
            typeof parsed.version === 'number' &&
            typeof parsed.seq === 'number' &&
            typeof parsed.type === 'string'
          ) {
            events.push(parsed as JournalEvent);
          }
        } catch {
          // Truncated or corrupted write encountered (e.g. from crash during append)
          // Intentionally skipped to avoid treating malformed data as valid execution
        }
      }

      // Sort by sequence number in case of any out-of-order writes
      return events.sort((a, b) => a.seq - b.seq);
    } catch {
      return [];
    }
  }

  /**
   * Reads snapshot.json if it exists and is valid.
   */
  async readSnapshot(): Promise<DurableJournalSnapshot | null> {
    try {
      const content = await fs.readFile(this.snapshotFilePath, 'utf8');
      const parsed = JSON.parse(content);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        typeof parsed.version === 'number' &&
        typeof parsed.lastSeq === 'number'
      ) {
        return parsed as DurableJournalSnapshot;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Replays an array of JournalEvents from scratch to construct a deterministic snapshot.
   */
  replayEvents(events: JournalEvent[]): DurableJournalSnapshot {
    const replay = this.createEmptySnapshot();
    for (const evt of events) {
      this.applyEventToSnapshot(replay, evt);
    }
    return replay;
  }
}
