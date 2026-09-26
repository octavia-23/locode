import { execa } from 'execa';

export interface Checkpoint {
  id: string;
  timestamp: Date;
  stashCreated: boolean;
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

  /**
   * Creates a snapshot of all uncommitted working changes before the agent begins editing.
   */
  async createCheckpoint(): Promise<Checkpoint | null> {
    if (!(await this.isGitRepo())) return null;

    try {
      // Check if there are dirty changes or untracked files
      const status = await execa('git status --porcelain', { cwd: this.cwd, shell: true });
      const hasChanges = status.stdout.trim().length > 0;

      if (!hasChanges) {
        const cp: Checkpoint = {
          id: `clean-${Date.now()}`,
          timestamp: new Date(),
          stashCreated: false
        };
        this.checkpoints.push(cp);
        return cp;
      }

      // Create a temporary git stash of the current state
      const stashName = `locode-checkpoint-${Date.now()}`;
      await execa(`git stash push -u -m "${stashName}"`, { cwd: this.cwd, shell: true });
      // Immediately restore it back to workspace so user keeps their state, but stash is safely saved!
      await execa('git stash apply stash@{0}', { cwd: this.cwd, shell: true });

      const cp: Checkpoint = {
        id: stashName,
        timestamp: new Date(),
        stashCreated: true
      };
      this.checkpoints.push(cp);
      return cp;
    } catch {
      return null;
    }
  }

  /**
   * Rolls back workspace to the state prior to the last agent turn.
   */
  async undo(): Promise<{ success: boolean; message: string }> {
    if (!(await this.isGitRepo())) {
      return { success: false, message: 'Current workspace is not a Git repository.' };
    }

    if (this.checkpoints.length === 0) {
      return { success: false, message: 'No checkpoints found to undo.' };
    }

    const last = this.checkpoints.pop()!;

    try {
      // Clean untracked files and hard reset tracked files
      await execa('git reset --hard HEAD', { cwd: this.cwd, shell: true });
      await execa('git clean -fd', { cwd: this.cwd, shell: true });

      if (last.stashCreated) {
        // Find and apply the saved stash
        const stashList = await execa('git stash list', { cwd: this.cwd, shell: true });
        const lines = stashList.stdout.split('\n');
        let stashIndex = -1;
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(last.id)) {
            stashIndex = i;
            break;
          }
        }

        if (stashIndex !== -1) {
          await execa(`git stash apply stash@{${stashIndex}}`, { cwd: this.cwd, shell: true });
          await execa(`git stash drop stash@{${stashIndex}}`, { cwd: this.cwd, shell: true });
        }
      }

      return { success: true, message: `Successfully rolled back to checkpoint from ${last.timestamp.toLocaleTimeString()}.` };
    } catch (err: any) {
      return { success: false, message: `Undo failed: ${err.message}` };
    }
  }
}
