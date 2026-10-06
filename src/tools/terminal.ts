import fs from 'node:fs/promises';
import { execa } from 'execa';
import { ToolDefinition } from '../types.js';
import { resolveSafePath, isDangerousCommand } from './security.js';

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
      const check = isDangerousCommand(args.command);
      if (check.dangerous && !context.autoApprove) {
        // High risk command detected
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

      // Run via shell (Git Bash on Windows if available for full POSIX compatibility, powershell/cmd fallback)
      let shellExecutable: string | boolean = true;
      if (isWindows) {
        // Automatically prefer Git Bash on Windows (has git, wc, ls, grep, cat, curl, npm built-in)
        const gitBashPath = 'C:\\Program Files\\Git\\bin\\bash.exe';
        try {
          await fs.access(gitBashPath);
          shellExecutable = gitBashPath;
        } catch {
          shellExecutable = 'cmd.exe';
        }
      }

      const child = execa(args.command, {
        cwd: effectiveCwd,
        shell: shellExecutable,
        timeout: 90000,
        reject: false,
        all: true,
        env: {
          ...process.env,
          CI: 'true'
        }
      });

      const result = await child;
      const rawOutput = (result.all || `${result.stdout}\n${result.stderr}`).trim();
      const exitCode = result.exitCode;

      let trimmedOutput = rawOutput;
      const MAX_CMD_CHARS = 4000;
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
      if (err.timedOut) {
        return { result: `Command timed out after 90 seconds.`, isError: true };
      }
      return { result: `Failed to execute command: ${err.message}`, isError: true };
    }
  }
};
