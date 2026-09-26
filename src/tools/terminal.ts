import { execa } from 'execa';
import { ToolDefinition } from '../types.js';

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
  needsApproval: true,
  async execute(args, context) {
    try {
      const workingDir = args.cwd ? args.cwd : context.cwd;
      const isWindows = process.platform === 'win32';

      // Run via shell (powershell / cmd on windows, sh on unix)
      const child = execa(args.command, {
        cwd: workingDir,
        shell: isWindows ? 'cmd.exe' : true,
        timeout: 90000,
        reject: false,
        all: true,
        env: {
          ...process.env,
          CI: 'true'
        }
      });

      const result = await child;
      const output = result.all || `${result.stdout}\n${result.stderr}`.trim();
      const exitCode = result.exitCode;

      if (exitCode !== 0) {
        return {
          result: `Command exited with status code ${exitCode}:\n${output || '(no output)'}`,
          isError: true
        };
      }

      return {
        result: output.trim() ? output.trim() : 'Command executed successfully with no output.'
      };
    } catch (err: any) {
      if (err.timedOut) {
        return { result: `Command timed out after 90 seconds.`, isError: true };
      }
      return { result: `Failed to execute command: ${err.message}`, isError: true };
    }
  }
};
