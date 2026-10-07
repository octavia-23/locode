import fs from 'node:fs/promises';
import path from 'node:path';
import { ChatMessage } from '../types.js';

export interface SerializedSession {
  version: number;
  updatedAt: string;
  cwd: string;
  model: string;
  summary?: string;
  lastDecisions: string[];
  recentFiles: string[];
  messages: ChatMessage[];
}

/**
 * Persistent Session Memory Manager
 *
 * Saves and restores conversation state and workspace findings to `.locode/session.json`
 * so when Locode is reopened, it retains memory of what was done, what decisions were made,
 * and relevant files, avoiding repetitive exploration from scratch.
 */
export class SessionMemory {
  private cwd: string;
  private sessionDir: string;
  private sessionFile: string;

  constructor(cwd: string) {
    this.cwd = cwd;
    this.sessionDir = path.join(cwd, '.locode');
    this.sessionFile = path.join(this.sessionDir, 'session.json');
  }

  async hasPreviousSession(): Promise<boolean> {
    try {
      const stat = await fs.stat(this.sessionFile);
      return stat.isFile() && stat.size > 0;
    } catch {
      return false;
    }
  }

  async loadSession(): Promise<SerializedSession | null> {
    try {
      const data = await fs.readFile(this.sessionFile, 'utf8');
      const parsed = JSON.parse(data) as SerializedSession;
      if (parsed && Array.isArray(parsed.messages)) {
        return parsed;
      }
      return null;
    } catch {
      return null;
    }
  }

  async saveSession(sessionData: {
    model: string;
    messages: ChatMessage[];
    lastDecisions?: string[];
    recentFiles?: string[];
    summary?: string;
  }): Promise<void> {
    try {
      await fs.mkdir(this.sessionDir, { recursive: true });

      // Keep recent messages (filter out large raw tool dumps if needed, but preserve last turns)
      // Exclude system message as that is dynamically rebuilt
      const nonSystemMessages = sessionData.messages.filter(m => m.role !== 'system');
      
      // Preserve up to the last 20 messages to keep the session compact and fast
      const savedMessages = nonSystemMessages.slice(-20);

      const record: SerializedSession = {
        version: 1,
        updatedAt: new Date().toISOString(),
        cwd: this.cwd,
        model: sessionData.model,
        summary: sessionData.summary,
        lastDecisions: sessionData.lastDecisions || [],
        recentFiles: sessionData.recentFiles || [],
        messages: savedMessages
      };

      await fs.writeFile(this.sessionFile, JSON.stringify(record, null, 2), 'utf8');
    } catch {
      // Silently ignore write failures if permission denied or disk locked
    }
  }

  async clearSession(): Promise<void> {
    try {
      await fs.rm(this.sessionFile, { force: true });
    } catch {}
  }
}
