import fs from 'node:fs/promises';
import path from 'node:path';
import { ChatMessage } from '../types.js';

export interface SessionMetadata {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  cwd: string;
  model: string;
  provider?: string;
  turns: number;
  summary?: string;
  objective?: string;
  checkpoint?: string;
  forkedFrom?: string;
  parentSessionId?: string;
  lastDecisions: string[];
  recentFiles: string[];
}

export interface SerializedSession extends SessionMetadata {
  version: number;
  messages: ChatMessage[];
}

/**
 * Persistent Multi-Session & Memory Manager
 *
 * Supports named sessions, session branching/forking (`/fork`), session switching (`/sessions`),
 * and transparent fallback to legacy `.locode/session.json`.
 */
export class SessionMemory {
  private cwd: string;
  private sessionDir: string;
  private sessionsDir: string;
  private legacySessionFile: string;
  private activeSessionFile: string;
  private activeSessionId: string = 'main';

  constructor(cwd: string) {
    this.cwd = cwd;
    this.sessionDir = path.join(cwd, '.locode');
    this.sessionsDir = path.join(this.sessionDir, 'sessions');
    this.legacySessionFile = path.join(this.sessionDir, 'session.json');
    this.activeSessionFile = path.join(this.sessionDir, 'active_session');
  }

  getActiveSessionId(): string {
    return this.activeSessionId;
  }

  async setActiveSessionId(id: string): Promise<void> {
    this.activeSessionId = id;
    try {
      await fs.mkdir(this.sessionDir, { recursive: true });
      await fs.writeFile(this.activeSessionFile, id.trim(), 'utf8');
    } catch {}
  }

  private async resolveActiveSessionId(): Promise<string> {
    try {
      const stored = await fs.readFile(this.activeSessionFile, 'utf8');
      if (stored && stored.trim()) {
        this.activeSessionId = stored.trim();
      }
    } catch {
      this.activeSessionId = 'main';
    }
    return this.activeSessionId;
  }

  private getSessionFilePath(sessionId: string): string {
    return path.join(this.sessionsDir, `${sessionId}.json`);
  }

  async hasPreviousSession(): Promise<boolean> {
    await this.resolveActiveSessionId();
    const activeFile = this.getSessionFilePath(this.activeSessionId);
    try {
      const stat = await fs.stat(activeFile);
      if (stat.isFile() && stat.size > 0) return true;
    } catch {}

    // Fallback to legacy session file
    try {
      const legacyStat = await fs.stat(this.legacySessionFile);
      return legacyStat.isFile() && legacyStat.size > 0;
    } catch {
      return false;
    }
  }

  async loadSession(sessionId?: string): Promise<SerializedSession | null> {
    if (!sessionId) {
      await this.resolveActiveSessionId();
    }
    const targetId = sessionId || this.activeSessionId;
    const targetFile = this.getSessionFilePath(targetId);

    try {
      let data: string | null = null;
      try {
        data = await fs.readFile(targetFile, 'utf8');
      } catch {
        // If not found in sessions/ and we are targeting 'main', try legacy session.json
        if (targetId === 'main') {
          data = await fs.readFile(this.legacySessionFile, 'utf8');
        }
      }

      if (!data) return null;

      const parsed = JSON.parse(data) as SerializedSession;
      if (parsed && Array.isArray(parsed.messages)) {
        // Strip any leading orphaned tool messages
        while (parsed.messages.length > 0 && parsed.messages[0].role === 'tool') {
          parsed.messages.shift();
        }

        // Fill in missing metadata defaults for legacy sessions
        if (!parsed.id) parsed.id = targetId;
        if (!parsed.name) parsed.name = targetId === 'main' ? 'Main Session' : targetId;
        if (!parsed.createdAt) parsed.createdAt = parsed.updatedAt || new Date().toISOString();
        if (typeof parsed.turns !== 'number') parsed.turns = parsed.messages.filter(m => m.role === 'user').length;

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
    name?: string;
    sessionId?: string;
    lastDecisions?: string[];
    recentFiles?: string[];
    summary?: string;
    objective?: string;
    checkpoint?: string;
    provider?: string;
    forkedFrom?: string;
    parentSessionId?: string;
  }): Promise<void> {
    try {
      await fs.mkdir(this.sessionsDir, { recursive: true });
      const targetId = sessionData.sessionId || this.activeSessionId || 'main';

      // Keep recent messages
      const nonSystemMessages = sessionData.messages.filter(m => m.role !== 'system');
      let savedMessages = nonSystemMessages.slice(-30);

      while (savedMessages.length > 0 && savedMessages[0].role === 'tool') {
        savedMessages.shift();
      }

      // Check if existing record has createdAt
      let createdAt = new Date().toISOString();
      let turns = savedMessages.filter(m => m.role === 'user').length;
      let sessionName = sessionData.name;

      try {
        const existing = await this.loadSession(targetId);
        if (existing) {
          if (existing.createdAt) createdAt = existing.createdAt;
          if (!sessionName && existing.name) sessionName = existing.name;
        }
      } catch {}

      if (!sessionName) {
        sessionName = targetId === 'main' ? 'Main Session' : targetId;
      }

      const record: SerializedSession = {
        version: 2,
        id: targetId,
        name: sessionName,
        createdAt,
        updatedAt: new Date().toISOString(),
        cwd: this.cwd,
        model: sessionData.model,
        provider: sessionData.provider,
        turns,
        summary: sessionData.summary,
        objective: sessionData.objective,
        checkpoint: sessionData.checkpoint,
        forkedFrom: sessionData.forkedFrom,
        parentSessionId: sessionData.parentSessionId,
        lastDecisions: sessionData.lastDecisions || [],
        recentFiles: sessionData.recentFiles || [],
        messages: savedMessages
      };

      const serialized = JSON.stringify(record, null, 2);

      // Save to sessions/
      await fs.writeFile(this.getSessionFilePath(targetId), serialized, 'utf8');

      // Sync active session if this is the active one
      if (targetId === this.activeSessionId) {
        await fs.writeFile(this.legacySessionFile, serialized, 'utf8');
      }
    } catch {
      // Silently ignore disk write issues
    }
  }

  /**
   * Forks the current session into an independent branch with identical conversation history.
   */
  async forkSession(options?: {
    name?: string;
    messages?: ChatMessage[];
    lastDecisions?: string[];
    recentFiles?: string[];
    summary?: string;
    checkpoint?: string;
    model?: string;
    provider?: string;
  }): Promise<SerializedSession> {
    await fs.mkdir(this.sessionsDir, { recursive: true });
    await this.resolveActiveSessionId();

    const parentId = this.activeSessionId;
    const parentSession = await this.loadSession(parentId);

    const now = new Date();
    const timeTag = `${now.getHours().toString().padStart(2, '0')}${now.getMinutes().toString().padStart(2, '0')}`;
    const randomSuffix = Math.random().toString(36).slice(2, 6);
    const newSessionId = `fork_${timeTag}_${randomSuffix}`;
    const newSessionName = options?.name || `Branch from ${parentSession?.name || parentId} (${now.toLocaleTimeString()})`;

    const messages = options?.messages || parentSession?.messages || [];
    const model = options?.model || parentSession?.model || 'default';
    const provider = options?.provider || parentSession?.provider;
    const lastDecisions = options?.lastDecisions || parentSession?.lastDecisions || [];
    const recentFiles = options?.recentFiles || parentSession?.recentFiles || [];
    const summary = options?.summary || parentSession?.summary;
    const checkpoint = options?.checkpoint || parentSession?.checkpoint;

    const forkedRecord: SerializedSession = {
      version: 2,
      id: newSessionId,
      name: newSessionName,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      cwd: this.cwd,
      model,
      provider,
      turns: messages.filter(m => m.role === 'user').length,
      summary,
      objective: parentSession?.objective,
      checkpoint,
      forkedFrom: parentSession?.name || parentId,
      parentSessionId: parentId,
      lastDecisions: [...lastDecisions],
      recentFiles: [...recentFiles],
      messages: messages.map(m => ({ ...m }))
    };

    await fs.writeFile(this.getSessionFilePath(newSessionId), JSON.stringify(forkedRecord, null, 2), 'utf8');
    await this.setActiveSessionId(newSessionId);

    return forkedRecord;
  }

  /**
   * Lists all saved sessions ordered by most recently updated.
   */
  async listSessions(): Promise<SessionMetadata[]> {
    await fs.mkdir(this.sessionsDir, { recursive: true });
    await this.resolveActiveSessionId();

    const sessions: SessionMetadata[] = [];
    const seenIds = new Set<string>();

    try {
      const files = await fs.readdir(this.sessionsDir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const sessionId = file.replace(/\.json$/, '');
        try {
          const content = await fs.readFile(path.join(this.sessionsDir, file), 'utf8');
          const parsed = JSON.parse(content) as SerializedSession;
          if (parsed) {
            seenIds.add(sessionId);
            sessions.push({
              id: parsed.id || sessionId,
              name: parsed.name || (sessionId === 'main' ? 'Main Session' : sessionId),
              createdAt: parsed.createdAt || parsed.updatedAt || new Date().toISOString(),
              updatedAt: parsed.updatedAt || new Date().toISOString(),
              cwd: parsed.cwd || this.cwd,
              model: parsed.model || 'unknown',
              provider: parsed.provider,
              turns: typeof parsed.turns === 'number' ? parsed.turns : (parsed.messages?.filter(m => m.role === 'user').length || 0),
              summary: parsed.summary,
              objective: parsed.objective,
              checkpoint: parsed.checkpoint,
              forkedFrom: parsed.forkedFrom,
              parentSessionId: parsed.parentSessionId,
              lastDecisions: parsed.lastDecisions || [],
              recentFiles: parsed.recentFiles || []
            });
          }
        } catch {}
      }
    } catch {}

    // Check if legacy session.json exists and hasn't been listed
    if (!seenIds.has('main')) {
      try {
        const legacyData = await fs.readFile(this.legacySessionFile, 'utf8');
        const parsed = JSON.parse(legacyData) as SerializedSession;
        if (parsed) {
          sessions.push({
            id: 'main',
            name: 'Main Session',
            createdAt: parsed.updatedAt || new Date().toISOString(),
            updatedAt: parsed.updatedAt || new Date().toISOString(),
            cwd: parsed.cwd || this.cwd,
            model: parsed.model || 'unknown',
            turns: parsed.messages?.filter(m => m.role === 'user').length || 0,
            summary: parsed.summary,
            lastDecisions: parsed.lastDecisions || [],
            recentFiles: parsed.recentFiles || []
          });
        }
      } catch {}
    }

    // Sort by most recently updated
    return sessions.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  }

  /**
   * Switches the active session to target ID or Name.
   */
  async switchSession(idOrName: string): Promise<SerializedSession | null> {
    const list = await this.listSessions();
    const query = idOrName.trim().toLowerCase();

    // Match by exact ID, prefix ID, or case-insensitive name
    const match = list.find(s =>
      s.id.toLowerCase() === query ||
      s.id.toLowerCase().startsWith(query) ||
      s.name.toLowerCase() === query ||
      s.name.toLowerCase().includes(query)
    );

    if (!match) return null;

    const session = await this.loadSession(match.id);
    if (session) {
      await this.setActiveSessionId(match.id);
    }
    return session;
  }

  /**
   * Deletes a session by ID or name.
   */
  async deleteSession(idOrName: string): Promise<boolean> {
    const list = await this.listSessions();
    const query = idOrName.trim().toLowerCase();

    const match = list.find(s =>
      s.id.toLowerCase() === query ||
      s.name.toLowerCase() === query
    );

    if (!match) return false;

    try {
      await fs.rm(this.getSessionFilePath(match.id), { force: true });
      if (this.activeSessionId === match.id) {
        await this.setActiveSessionId('main');
      }
      return true;
    } catch {
      return false;
    }
  }

  async clearSession(): Promise<void> {
    try {
      await fs.rm(this.getSessionFilePath(this.activeSessionId), { force: true });
      await fs.rm(this.legacySessionFile, { force: true });
    } catch {}
  }
}
