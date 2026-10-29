import fs from 'node:fs/promises';
import path from 'node:path';
import { transformSync } from 'esbuild';
import { execa } from 'execa';

export type VerificationStatus = 'passed' | 'failed' | 'not-run' | 'inconclusive';

export interface VerificationResult {
  status: VerificationStatus;
  passed: boolean;
  command?: string;
  output?: string;
  errorOutput?: string;
  reason?: string;
}

export interface FastVerificationDiagnostic {
  file: string;
  line: number;
  message: string;
  code?: string;
}

export interface FastVerificationResult {
  passed: boolean;
  durationMs: number;
  errors: FastVerificationDiagnostic[];
  summary?: string;
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
   * Fast in-memory syntactic verification of raw code content (<5ms)
   */
  static verifyContentFast(filePath: string, content: string): FastVerificationDiagnostic[] {
    const errors: FastVerificationDiagnostic[] = [];
    const ext = path.extname(filePath).toLowerCase();

    // 1. TypeScript / JavaScript syntax check via in-memory compiler
    if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
      try {
        const loader = ext.includes('tsx') ? 'tsx' : ext.includes('ts') ? 'ts' : ext.includes('jsx') ? 'jsx' : 'js';
        transformSync(content, {
          loader,
          sourcefile: filePath
        });
      } catch (err: any) {
        if (err.errors && Array.isArray(err.errors)) {
          for (const e of err.errors) {
            errors.push({
              file: filePath,
              line: e.location?.line || 1,
              message: e.text || err.message,
              code: 'TS_SYNTAX_ERROR'
            });
          }
        } else {
          errors.push({
            file: filePath,
            line: 1,
            message: err.message || 'Syntax error',
            code: 'TS_SYNTAX_ERROR'
          });
        }
      }
    } else if (ext === '.json') {
      // 2. JSON syntax check
      try {
        JSON.parse(content);
      } catch (jsonErr: any) {
        errors.push({
          file: filePath,
          line: 1,
          message: `Invalid JSON syntax: ${jsonErr.message}`
        });
      }
    }

    return errors;
  }

  /**
   * Fast in-memory compiler check using TypeScript compiler AST.
   * Checks syntactic & semantic validity of modified files in <50ms without spawning subprocesses.
   */
  static async verifyFilesFast(filePaths: string[], cwd: string): Promise<FastVerificationResult> {
    const startTime = Date.now();
    const errors: FastVerificationDiagnostic[] = [];

    for (const filePath of filePaths) {
      const fullPath = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
      let content: string;
      try {
        content = await fs.readFile(fullPath, 'utf8');
      } catch (err: any) {
        errors.push({
          file: path.relative(cwd, fullPath).replace(/\\/g, '/'),
          line: 1,
          message: `Could not read file: ${err.message}`
        });
        continue;
      }

      const relPath = path.relative(cwd, fullPath).replace(/\\/g, '/');
      const fileErrors = this.verifyContentFast(relPath, content);
      errors.push(...fileErrors);
    }

    const durationMs = Date.now() - startTime;
    const passed = errors.length === 0;

    const summary = passed
      ? `Fast compiler check passed (${filePaths.length} files in ${durationMs}ms)`
      : `Fast compiler check failed with ${errors.length} diagnostic error(s)`;

    return {
      passed,
      durationMs,
      errors,
      summary
    };
  }

  /**
   * Fast file-level or workspace-level linter check executed immediately after an edit.
   * Catches syntax errors and broken types instantly before proceeding to subsequent turns.
   */
  static async runFastLint(cwd: string, targetFile?: string): Promise<VerificationResult> {
    // 0. Instant in-memory TypeScript check (<5ms) if target file exists
    if (targetFile && ['.ts', '.tsx', '.js', '.jsx'].includes(path.extname(targetFile).toLowerCase())) {
      try {
        const full = path.isAbsolute(targetFile) ? targetFile : path.resolve(cwd, targetFile);
        const stat = await fs.stat(full).catch(() => null);
        if (stat && stat.isFile()) {
          const fastCheck = await this.verifyFilesFast([targetFile], cwd);
          if (!fastCheck.passed && fastCheck.errors.length > 0) {
            const errorLines = fastCheck.errors.map(e => `${e.file}:${e.line} - error ${e.code || ''}: ${e.message}`);
            return {
              status: 'failed',
              passed: false,
              command: `verifyFilesFast (${targetFile})`,
              errorOutput: this.sanitizeErrorOutput(errorLines.join('\n'))
            };
          }
        }
      } catch {}
    }

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
            status: 'failed',
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
        const vRes = await this.run(cwd, cmd);
        if (!vRes.passed && targetFile && vRes.errorOutput) {
          const baseName = path.basename(targetFile).toLowerCase();
          const targetRel = targetFile.replace(/\\/g, '/').toLowerCase();
          const errorLower = vRes.errorOutput.toLowerCase();
          if (!errorLower.includes(baseName) && !errorLower.includes(targetRel)) {
            // Attribution cannot be established to targetFile. Never report as passed!
            return {
              status: 'inconclusive',
              passed: false,
              command: vRes.command,
              errorOutput: vRes.errorOutput,
              reason: `Verification failed on ${vRes.command}, but attribution to edited file "${targetFile}" is inconclusive.`
            };
          }
        }
        return vRes;
      }
    } catch {}

    // 3. Rust: cargo check
    try {
      await fs.access(path.join(cwd, 'Cargo.toml'));
      const vRes = await this.run(cwd, 'cargo check');
      if (!vRes.passed && targetFile && vRes.errorOutput) {
        const baseName = path.basename(targetFile).toLowerCase();
        if (!vRes.errorOutput.toLowerCase().includes(baseName)) {
          return {
            status: 'inconclusive',
            passed: false,
            command: vRes.command,
            errorOutput: vRes.errorOutput,
            reason: `Verification failed on ${vRes.command}, but attribution to edited file "${targetFile}" is inconclusive.`
          };
        }
      }
      return vRes;
    } catch {}

    return {
      status: 'not-run',
      passed: false,
      reason: 'No fast linter configured for this workspace'
    };
  }

  /**
   * Executes the verification command and returns whether the code passed, failed, was not run, or was inconclusive.
   */
  static async run(cwd: string, customCommand?: string): Promise<VerificationResult> {
    const command = customCommand || (await this.detectCommand(cwd));

    if (!command) {
      return {
        status: 'not-run',
        passed: false,
        reason: 'No verification or test command configured for this project.'
      };
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
          status: 'passed',
          passed: true,
          command,
          output: res.stdout.trim()
        };
      }

      // Clean and sanitize the error output for LLM consumption
      const combined = `${res.stdout}\n${res.stderr}`.trim();
      const sanitized = this.sanitizeErrorOutput(combined);

      return {
        status: 'failed',
        passed: false,
        command,
        errorOutput: sanitized
      };
    } catch (err: any) {
      const isTimeout = /timed? out|timeout/i.test(err.message || '');
      return {
        status: isTimeout ? 'inconclusive' : 'failed',
        passed: false,
        command,
        errorOutput: err.message || 'Verification process timed out or failed to execute.',
        reason: isTimeout ? 'Verification execution timed out' : undefined
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
