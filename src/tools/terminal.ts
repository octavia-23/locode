import fs from 'node:fs/promises';
import { execa } from 'execa';
import { ToolDefinition } from '../types.js';
import { resolveSafePath, classifyCommandSecurity, isDangerousCommand } from './security.js';
import { isCloudProvider } from '../providers/factory.js';

/**
 * Safely and recursively terminates a process and all its child processes.
 * Uses taskkill on Windows to clean the whole process tree, and process group SIGKILL on POSIX.
 */
export async function killProcessTree(pid: number | undefined): Promise<void> {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      await execa('taskkill', ['/F', '/T', '/PID', String(pid)], { reject: false, timeout: 5000 });
    } else {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        process.kill(pid, 'SIGKILL');
      }
    }
  } catch {
    // Process may have already exited
  }
}

export const runCommandTool: ToolDefinition = {
  name: 'run_command',
  description: 'Execute a shell command in the project directory (e.g., git, npm, tests, linters, builds).',
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The shell command to run'
      },
      cwd: {
        type: 'string',
        description: 'Optional subpath to run command in (defaults to project root)'
      },
      timeout: {
        type: 'number',
        description: 'Optional timeout in milliseconds (defaults to 45000ms or context.commandTimeoutMs)'
      }
    },
    required: ['command']
  },
  needsApproval(args: any) {
    // If command is dangerous, strictly require approval
    return true;
  },
  async execute(args, context) {
    try {
      const workingDir = args.cwd ? resolveSafePath(args.cwd, context.cwd) : context.cwd;
      const check = classifyCommandSecurity(args.command);
      if (check.decision === 'deny') {
        return {
          result: `Command execution denied: Command is unconditionally prohibited: ${check.reason}`,
          isError: true
        };
      }

      const isWindows = process.platform === 'win32';
      const cmdStr = (args.command || '').trim();

      // Windows Compatibility Shim: intercept 'wc -l <file>' which models frequently attempt
      if (isWindows && /^wc\s+-l\s+(.+)$/i.test(cmdStr)) {
        const targetRel = cmdStr.replace(/^wc\s+-l\s+/i, '').trim().replace(/^["']|["']$/g, '');
        try {
          const targetFull = resolveSafePath(targetRel, workingDir);
          const content = await fs.readFile(targetFull, 'utf8');
          const lineCount = content.split('\n').length;
          return { result: `${lineCount} ${targetRel}` };
        } catch (err: any) {
          return { result: `wc: ${targetRel}: No such file or directory`, isError: true };
        }
      }

      // If running git commands and workingDir is a subdirectory or invalid git location,
      // fallback to project root context.cwd
      let effectiveCwd = workingDir;
      if (/^git\b/i.test(cmdStr) && effectiveCwd !== context.cwd) {
        try {
          const gitCheck = await execa('git rev-parse --is-inside-work-tree', { cwd: effectiveCwd, shell: true });
          if (gitCheck.stdout.trim() !== 'true') {
            effectiveCwd = context.cwd;
          }
        } catch {
          effectiveCwd = context.cwd;
        }
      }

      // Run via shell (Git Bash on Windows if available for full POSIX compatibility, cmd fallback)
      let shellExecutable: string | boolean = true;
      if (isWindows) {
        const gitBashPath = 'C:\\Program Files\\Git\\bin\\bash.exe';
        try {
          await fs.access(gitBashPath);
          shellExecutable = gitBashPath;
        } catch {
          shellExecutable = 'cmd.exe';
        }
      }

      const timeoutMs = typeof args.timeout === 'number' && args.timeout > 0
        ? args.timeout
        : (typeof context.commandTimeoutMs === 'number' && context.commandTimeoutMs > 0 ? context.commandTimeoutMs : 45000);

      // Check pre-aborted signal
      if (context.signal?.aborted) {
        return { result: 'Command was cancelled before execution began.', isError: true };
      }

      let timedOut = false;
      let cancelled = false;
      let timer: NodeJS.Timeout | undefined;

      const allChunks: string[] = [];
      let lastOutputLine = '';
      const startTime = Date.now();

      // Spawn child process with stdin: 'ignore' to prevent interactive stalls
      const child = execa(args.command, {
        cwd: effectiveCwd,
        shell: shellExecutable,
        stdin: 'ignore',
        reject: false,
        all: true,
        env: {
          ...process.env,
          CI: 'true',
          PYTHONUNBUFFERED: '1',
          NODE_ENV: 'test',
          FORCE_COLOR: '0'
        }
      });

      // Stream stdout/stderr in real-time and expose progress
      if (child.all) {
        child.all.on('data', (chunk: Buffer | string) => {
          const text = chunk.toString();
          allChunks.push(text);
          const lines = text.trim().split('\n');
          if (lines.length > 0) {
            lastOutputLine = lines[lines.length - 1].trim();
          }
          if (context.onCommandProgress) {
            context.onCommandProgress({
              elapsedMs: Date.now() - startTime,
              lastOutput: lastOutputLine
            });
          }
        });
      }

      // Cancellation listener
      let abortListener: (() => void) | undefined;
      if (context.signal) {
        abortListener = async () => {
          cancelled = true;
          if (child.pid) {
            await killProcessTree(child.pid);
          }
          try {
            child.kill('SIGKILL');
          } catch {}
        };
        context.signal.addEventListener('abort', abortListener, { once: true });
      }

      // Timeout watchdog
      timer = setTimeout(async () => {
        timedOut = true;
        if (child.pid) {
          await killProcessTree(child.pid);
        }
        try {
          child.kill('SIGKILL');
        } catch {}
      }, timeoutMs);

      let result: any;
      try {
        result = await child;
      } finally {
        if (timer) clearTimeout(timer);
        if (context.signal && abortListener) {
          context.signal.removeEventListener('abort', abortListener);
        }
      }

      const rawOutput = (allChunks.join('') || result?.all || `${result?.stdout || ''}\n${result?.stderr || ''}`).trim();
      const exitCode = result?.exitCode ?? (timedOut || cancelled ? 1 : 0);

      let trimmedOutput = rawOutput;
      const isCloud = isCloudProvider(context?.provider);
      const MAX_CMD_CHARS = isCloud || (context?.numCtx && context.numCtx >= 65536) ? 35000 : 4000;
      if (trimmedOutput.length > MAX_CMD_CHARS) {
        if (context.contextEngine?.compactToolOutput) {
          trimmedOutput = context.contextEngine.compactToolOutput(trimmedOutput, MAX_CMD_CHARS);
        } else {
          const lines = trimmedOutput.split('\n');
          if (lines.length > 40) {
            const head = lines.slice(0, 15).join('\n');
            const tail = lines.slice(-25).join('\n');
            trimmedOutput = `${head}\n... [${lines.length - 40} lines collapsed to preserve context window] ...\n${tail}`;
          } else {
            const headChars = Math.floor(MAX_CMD_CHARS * 0.6);
            const tailChars = Math.floor(MAX_CMD_CHARS * 0.3);
            trimmedOutput = `${trimmedOutput.slice(0, headChars)}\n... [Output collapsed to preserve context window] ...\n${trimmedOutput.slice(-tailChars)}`;
          }
        }
      }

      if (timedOut) {
        return {
          result: `Command timed out after ${timeoutMs / 1000} seconds:\n${trimmedOutput || '(no output produced before timeout)'}`,
          isError: true
        };
      }

      if (cancelled) {
        return {
          result: `Command was cancelled:\n${trimmedOutput || '(no output produced before cancellation)'}`,
          isError: true
        };
      }

      if (exitCode !== 0) {
        return {
          result: `Command exited with status code ${exitCode}:\n${trimmedOutput || '(no output)'}`,
          isError: true
        };
      }

      return {
        result: trimmedOutput || 'Command executed successfully with no output.'
      };
    } catch (err: any) {
      return { result: `Failed to execute command: ${err.message}`, isError: true };
    }
  }
};
