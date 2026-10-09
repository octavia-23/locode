import fs from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';

export interface VerificationResult {
  passed: boolean;
  command?: string;
  output?: string;
  errorOutput?: string;
}

export class CodeVerifier {
  /**
   * Automatically detects the appropriate verification command for the workspace.
   */
  static async detectCommand(cwd: string): Promise<string | null> {
    // 1. Check for Node.js / TypeScript project
    const pkgPath = path.join(cwd, 'package.json');
    try {
      const pkgContent = await fs.readFile(pkgPath, 'utf8');
      const pkg = JSON.parse(pkgContent);

      // Prioritize typecheck script (fastest, deterministic, catches 90% of model bugs)
      if (pkg.scripts?.typecheck) {
        return 'npm run typecheck';
      }
      if (pkg.scripts?.check) {
        return 'npm run check';
      }

      // If tsconfig.json exists, run tsc --noEmit
      try {
        await fs.access(path.join(cwd, 'tsconfig.json'));
        return 'npx --no-install tsc --noEmit';
      } catch {}

      // If tests are configured and not default template dummy
      if (pkg.scripts?.test && !pkg.scripts.test.includes('no test specified')) {
        return 'npm test';
      }
    } catch {}

    // 2. Check for Python project
    try {
      const hasPyProject = await fs.access(path.join(cwd, 'pyproject.toml')).then(() => true).catch(() => false);
      const hasPytestIni = await fs.access(path.join(cwd, 'pytest.ini')).then(() => true).catch(() => false);
      const hasTestsDir = await fs.access(path.join(cwd, 'tests')).then(() => true).catch(() => false);

      if (hasPyProject || hasPytestIni || hasTestsDir) {
        return 'pytest';
      }
    } catch {}

    // 3. Check for Rust project
    try {
      await fs.access(path.join(cwd, 'Cargo.toml'));
      return 'cargo check';
    } catch {}

    // 4. Check for Go project
    try {
      await fs.access(path.join(cwd, 'go.mod'));
      return 'go test ./...';
    } catch {}

    return null;
  }

  /**
   * Fast file-level or workspace-level linter check executed immediately after an edit.
   * Catches syntax errors and broken types instantly before proceeding to subsequent turns.
   */
  static async runFastLint(cwd: string, targetFile?: string): Promise<VerificationResult> {
    // 1. Python quick syntax check: python -m py_compile <targetFile>
    if (targetFile && targetFile.endsWith('.py')) {
      try {
        const full = path.resolve(cwd, targetFile);
        const res = await execa('python', ['-m', 'py_compile', full], {
          cwd,
          timeout: 5000,
          reject: false
        });
        if (res.exitCode !== 0) {
          const combined = `${res.stdout}\n${res.stderr}`.trim();
          return {
            passed: false,
            command: `python -m py_compile ${targetFile}`,
            errorOutput: this.sanitizeErrorOutput(combined)
          };
        }
      } catch {}
    }

    // 2. Node/TypeScript: fast typecheck/check/lint
    const pkgPath = path.join(cwd, 'package.json');
    try {
      const pkgContent = await fs.readFile(pkgPath, 'utf8');
      const pkg = JSON.parse(pkgContent);
      let cmd: string | null = null;
      if (pkg.scripts?.typecheck) cmd = 'npm run typecheck';
      else if (pkg.scripts?.check) cmd = 'npm run check';
      else if (pkg.scripts?.lint) cmd = 'npm run lint';
      else {
        try {
          await fs.access(path.join(cwd, 'tsconfig.json'));
          cmd = 'npx --no-install tsc --noEmit';
        } catch {}
      }

      if (cmd) {
        return await this.run(cwd, cmd);
      }
    } catch {}

    // 3. Rust: cargo check
    try {
      await fs.access(path.join(cwd, 'Cargo.toml'));
      return await this.run(cwd, 'cargo check');
    } catch {}

    return { passed: true };
  }

  /**
   * Executes the verification command and returns whether the code passed or failed.
   */
  static async run(cwd: string, customCommand?: string): Promise<VerificationResult> {
    const command = customCommand || (await this.detectCommand(cwd));

    if (!command) {
      return { passed: true }; // No verifier configured for this project
    }

    try {
      const res = await execa(command, {
        cwd,
        shell: true,
        timeout: 30000,
        reject: false
      });

      if (res.exitCode === 0) {
        return {
          passed: true,
          command,
          output: res.stdout.trim()
        };
      }

      // Clean and sanitize the error output for LLM consumption
      const combined = `${res.stdout}\n${res.stderr}`.trim();
      const sanitized = this.sanitizeErrorOutput(combined);

      return {
        passed: false,
        command,
        errorOutput: sanitized
      };
    } catch (err: any) {
      return {
        passed: false,
        command,
        errorOutput: err.message || 'Verification process timed out or failed to execute.'
      };
    }
  }

  /**
   * Strips noisy npm/build boilerplate and keeps actionable compiler/test error lines.
   */
  private static sanitizeErrorOutput(raw: string): string {
    const lines = raw.split('\n');
    const filtered = lines.filter(line => {
      const l = line.trim();
      if (!l) return false;
      if (l.startsWith('npm ERR! code')) return false;
      if (l.startsWith('npm ERR! path')) return false;
      if (l.startsWith('npm ERR! command failed')) return false;
      if (l.startsWith('npm ERR! A complete log of this run can be found in')) return false;
      return true;
    });

    const result = filtered.join('\n');
    // Truncate to maximum 2,500 characters so we don't blow the LLM context window
    if (result.length > 2500) {
      return result.slice(0, 2500) + '\n... [Remaining output truncated for brevity]';
    }
    return result;
  }
}
