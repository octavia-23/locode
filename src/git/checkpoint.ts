import { execa } from 'execa';
import fs from 'node:fs/promises';
import path from 'node:path';

export interface FileSnapshot {
  relPath: string;
  exists: boolean;
  content?: string;
}

export interface Checkpoint {
  id: string;
  timestamp: Date;
  stashCreated: boolean;
  stashMessage?: string;
  snapshots: FileSnapshot[];
  preStatus: string;
}

export class CheckpointManager {
  private cwd: string;
  private checkpoints: Checkpoint[] = [];

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  async isGitRepo(): Promise<boolean> {
    try {
      const res = await execa('git rev-parse --is-inside-work-tree', { cwd: this.cwd, shell: true });
      return res.stdout.trim() === 'true';
    } catch {
      return false;
    }
  }

  getCheckpointsCount(): number {
    return this.checkpoints.length;
  }

  /**
   * Captures a snapshot of specific files before they are edited.
   */
  async recordPreEditFile(relPath: string): Promise<void> {
    const fullPath = path.resolve(this.cwd, relPath);
    const topCheckpoint = this.checkpoints[this.checkpoints.length - 1];
    if (!topCheckpoint) return;

    if (topCheckpoint.snapshots.some(s => s.relPath === relPath)) {
      return; // Already snapshotted for this turn
    }

    try {
      const content = await fs.readFile(fullPath, 'utf8');
      topCheckpoint.snapshots.push({
        relPath,
        exists: true,
        content
      });
    } catch {
      topCheckpoint.snapshots.push({
        relPath,
        exists: false
      });
    }
  }

  /**
   * Creates a snapshot of all uncommitted working changes before the agent begins editing.
   */
  async createCheckpoint(): Promise<Checkpoint | null> {
    const isGit = await this.isGitRepo();

    const timestamp = new Date();
    const id = `locode-checkpoint-${Date.now()}`;

    if (!isGit) {
      // Non-git fallback checkpoint supported via file snapshots
      const cp: Checkpoint = {
        id,
        timestamp,
        stashCreated: false,
        snapshots: [],
        preStatus: ''
      };
      this.checkpoints.push(cp);
      return cp;
    }

    try {
      const statusRes = await execa('git status --porcelain', { cwd: this.cwd, shell: true });
      const preStatus = statusRes.stdout.trim();

      if (!preStatus) {
        const cp: Checkpoint = {
          id: `clean-${Date.now()}`,
          timestamp,
          stashCreated: false,
          snapshots: [],
          preStatus: ''
        };
        this.checkpoints.push(cp);
        return cp;
      }

      // We have existing uncommitted work by user. Stash it safely with an explicit marker
      const stashMessage = `locode-checkpoint-${Date.now()}`;
      await execa(`git stash push -u -m "${stashMessage}"`, { cwd: this.cwd, shell: true });
      // Immediately re-apply to preserve user's working copy
      await execa('git stash apply stash@{0}', { cwd: this.cwd, shell: true });

      const cp: Checkpoint = {
        id: stashMessage,
        timestamp,
        stashCreated: true,
        stashMessage,
        snapshots: [],
        preStatus
      };
      this.checkpoints.push(cp);
      return cp;
    } catch {
      const cp: Checkpoint = {
        id,
        timestamp,
        stashCreated: false,
        snapshots: [],
        preStatus: ''
      };
      this.checkpoints.push(cp);
      return cp;
    }
  }

  /**
   * Rolls back workspace to the state prior to the last agent turn.
   * If targeted file snapshots exist, restores them directly.
   * In a Git repository, restores tracked & untracked states safely.
   */
  async undo(): Promise<{ success: boolean; message: string }> {
    if (this.checkpoints.length === 0) {
      return { success: false, message: 'No checkpoints found to undo.' };
    }

    const last = this.checkpoints.pop()!;
    const isGit = await this.isGitRepo();

    // 1. If we have explicit file-level snapshots, restore those surgical files first
    if (last.snapshots.length > 0) {
      try {
        for (const snap of last.snapshots) {
          const fullPath = path.resolve(this.cwd, snap.relPath);
          if (snap.exists && snap.content !== undefined) {
            await fs.mkdir(path.dirname(fullPath), { recursive: true });
            await fs.writeFile(fullPath, snap.content, 'utf8');
          } else {
            await fs.rm(fullPath, { force: true });
          }
        }
        return {
          success: true,
          message: `Successfully rolled back ${last.snapshots.length} file(s) to turn checkpoint (${last.timestamp.toLocaleTimeString()}).`
        };
      } catch (err: any) {
        return { success: false, message: `Failed to restore file snapshot: ${err.message}` };
      }
    }

    // 2. Git-based rollback
    if (isGit) {
      try {
        // Reset tracked modifications and remove newly created untracked files
        await execa('git reset --hard HEAD', { cwd: this.cwd, shell: true });
        await execa('git clean -fd', { cwd: this.cwd, shell: true });

        if (last.stashCreated && last.stashMessage) {
          // Find stash index by name
          const stashList = await execa('git stash list', { cwd: this.cwd, shell: true });
          const lines = stashList.stdout.split('\n');
          let stashIndex = -1;
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes(last.stashMessage)) {
              stashIndex = i;
              break;
            }
          }

          if (stashIndex !== -1) {
            await execa(`git stash apply stash@{${stashIndex}}`, { cwd: this.cwd, shell: true });
            await execa(`git stash drop stash@{${stashIndex}}`, { cwd: this.cwd, shell: true });
          }
        }

        return {
          success: true,
          message: `Successfully rolled back workspace to checkpoint from ${last.timestamp.toLocaleTimeString()}.`
        };
      } catch (err: any) {
        return { success: false, message: `Git undo failed: ${err.message}` };
      }
    }

    return { success: true, message: `Checkpoint from ${last.timestamp.toLocaleTimeString()} cleared.` };
  }
}
