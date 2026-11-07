import path from 'node:path';
import fs from 'node:fs/promises';
import { execa } from 'execa';
import chalk from 'chalk';
import { select } from '@inquirer/prompts';
import { theme } from './theme.js';
import { TerminalRenderer } from './renderer.js';

export type FileDiffStatus = 'modified' | 'added' | 'deleted' | 'untracked' | 'renamed' | 'copied';

export interface FileDiffStat {
  file: string;
  status: FileDiffStatus;
  statusRaw: string;
  insertions: number;
  deletions: number;
  staged: boolean;
}

export interface WorkspaceDiffSummary {
  files: FileDiffStat[];
  totalInsertions: number;
  totalDeletions: number;
  isClean: boolean;
}

/**
 * Inspects pending workspace modifications via git porcelain and numstat.
 */
export async function getWorkspaceDiffStats(cwd: string): Promise<WorkspaceDiffSummary> {
  let statusOutput = '';
  try {
    const statusRes = await execa('git status --porcelain', { cwd, shell: true });
    statusOutput = statusRes.stdout.trim();
  } catch {
    return { files: [], totalInsertions: 0, totalDeletions: 0, isClean: true };
  }

  if (!statusOutput) {
    return { files: [], totalInsertions: 0, totalDeletions: 0, isClean: true };
  }

  // Parse numstat for unstaged & staged changes
  const numstatMap = new Map<string, { ins: number; del: number }>();

  try {
    const [unstagedRes, stagedRes] = await Promise.all([
      execa('git diff --numstat', { cwd, shell: true }).catch(() => ({ stdout: '' })),
      execa('git diff --cached --numstat', { cwd, shell: true }).catch(() => ({ stdout: '' }))
    ]);

    const parseNumstat = (out: string) => {
      for (const line of out.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const [insStr, delStr, ...fileParts] = trimmed.split(/\s+/);
        const fileName = fileParts.join(' ');
        const ins = insStr === '-' ? 0 : parseInt(insStr, 10) || 0;
        const del = delStr === '-' ? 0 : parseInt(delStr, 10) || 0;
        const existing = numstatMap.get(fileName) || { ins: 0, del: 0 };
        numstatMap.set(fileName, { ins: existing.ins + ins, del: existing.del + del });
      }
    };

    parseNumstat(unstagedRes.stdout);
    parseNumstat(stagedRes.stdout);
  } catch {}

  const files: FileDiffStat[] = [];
  let totalInsertions = 0;
  let totalDeletions = 0;

  for (const line of statusOutput.split('\n')) {
    const trimmed = line.trimEnd();
    if (!trimmed) continue;

    const statusX = trimmed.charAt(0);
    const statusY = trimmed.charAt(1);
    const statusRaw = trimmed.substring(0, 2).trim();
    const rawFile = trimmed.substring(3).trim();
    // Handle renamed format: orig -> new
    const filePath = rawFile.includes(' -> ') ? rawFile.split(' -> ')[1] : rawFile;

    let status: FileDiffStatus = 'modified';
    let staged = statusX !== ' ' && statusX !== '?' && statusX !== '!';

    if (statusRaw === '??') {
      status = 'untracked';
    } else if (statusX === 'A' || statusY === 'A') {
      status = 'added';
    } else if (statusX === 'D' || statusY === 'D') {
      status = 'deleted';
    } else if (statusX === 'R' || statusY === 'R') {
      status = 'renamed';
    } else if (statusX === 'C' || statusY === 'C') {
      status = 'copied';
    }

    let ins = numstatMap.get(filePath)?.ins || 0;
    let del = numstatMap.get(filePath)?.del || 0;

    // For untracked files, approximate insertions by line count
    if (status === 'untracked') {
      try {
        const fullPath = path.resolve(cwd, filePath);
        const content = await fs.readFile(fullPath, 'utf8');
        ins = content.split('\n').length;
      } catch {
        ins = 0;
      }
    }

    totalInsertions += ins;
    totalDeletions += del;

    files.push({
      file: filePath,
      status,
      statusRaw,
      insertions: ins,
      deletions: del,
      staged
    });
  }

  return {
    files,
    totalInsertions,
    totalDeletions,
    isClean: files.length === 0
  };
}

/**
 * Renders a compact, high-legibility visual summary of changed files.
 */
export function renderDiffSummary(summary: WorkspaceDiffSummary): string {
  if (summary.isClean || summary.files.length === 0) {
    return `  ${theme.muted('workspace is clean (0 pending modifications)')}\n`;
  }

  const lines: string[] = [];
  lines.push(`\n  ${theme.diamond} ${theme.strong('Pending Workspace Changes')} ${theme.dim(`(${summary.files.length} files)`)}\n`);

  const maxFileLen = Math.min(50, Math.max(...summary.files.map(f => f.file.length)));

  for (const f of summary.files) {
    let badge = 'M ';
    let badgeColor = chalk.yellow;

    switch (f.status) {
      case 'added':
        badge = '+ ';
        badgeColor = chalk.green;
        break;
      case 'deleted':
        badge = '- ';
        badgeColor = chalk.red;
        break;
      case 'untracked':
        badge = '? ';
        badgeColor = chalk.magenta;
        break;
      case 'renamed':
        badge = 'R ';
        badgeColor = chalk.blue;
        break;
    }

    const badgeStr = badgeColor(badge.padEnd(3));
    const paddedFile = f.file.length > maxFileLen ? `...${f.file.slice(-maxFileLen + 3)}` : f.file.padEnd(maxFileLen);
    const insStr = f.insertions > 0 ? chalk.green(`+${f.insertions}`) : chalk.gray(' 0');
    const delStr = f.deletions > 0 ? chalk.red(`-${f.deletions}`) : chalk.gray(' 0');
    const stagedStr = f.staged ? chalk.cyan(' [staged]') : '';

    lines.push(`    ${badgeStr} ${theme.secondary(paddedFile)}  ${insStr.padStart(6)} ${delStr.padStart(6)}${stagedStr}`);
  }

  lines.push(`\n    ${theme.muted('total:')} ${theme.accent(`${summary.files.length} changed`)} ${theme.dim('(')}${chalk.green(`+${summary.totalInsertions}`)}${theme.dim(', ')}${chalk.red(`-${summary.totalDeletions}`)}${theme.dim(')')}\n`);

  return lines.join('\n');
}

/**
 * Retrieves the raw diff string for a specific file or the entire workspace.
 */
export async function getFileDiff(cwd: string, targetFile?: string): Promise<string> {
  try {
    if (targetFile) {
      // Check if untracked
      const statusRes = await execa(`git status --porcelain -- "${targetFile}"`, { cwd, shell: true }).catch(() => ({ stdout: '' }));
      if (statusRes.stdout.trim().startsWith('??')) {
        const fullPath = path.resolve(cwd, targetFile);
        const content = await fs.readFile(fullPath, 'utf8');
        const contentLines = content.split('\n');
        return [
          `diff --git a/${targetFile} b/${targetFile}`,
          `new file mode 100644`,
          `--- /dev/null`,
          `+++ b/${targetFile}`,
          `@@ -0,0 +1,${contentLines.length} @@`,
          ...contentLines.map(l => `+${l}`)
        ].join('\n');
      }

      // Check working tree & staged
      const [unstaged, staged] = await Promise.all([
        execa(`git diff -- "${targetFile}"`, { cwd, shell: true }).catch(() => ({ stdout: '' })),
        execa(`git diff --cached -- "${targetFile}"`, { cwd, shell: true }).catch(() => ({ stdout: '' }))
      ]);

      const parts = [staged.stdout.trim(), unstaged.stdout.trim()].filter(Boolean);
      return parts.join('\n\n');
    }

    const [unstaged, staged] = await Promise.all([
      execa('git diff', { cwd, shell: true }).catch(() => ({ stdout: '' })),
      execa('git diff --cached', { cwd, shell: true }).catch(() => ({ stdout: '' }))
    ]);

    const parts = [staged.stdout.trim(), unstaged.stdout.trim()].filter(Boolean);
    return parts.join('\n\n');
  } catch (err: any) {
    return `Error generating diff: ${err.message}`;
  }
}

/**
 * Highlights a raw unified diff with syntax coloring and line truncation.
 */
export function colorizeDiff(rawDiff: string, maxLines: number = 300): string {
  if (!rawDiff.trim()) {
    return theme.muted('  (no diff content)');
  }

  const lines = rawDiff.split('\n');
  const rendered: string[] = [];

  const displayLines = lines.slice(0, maxLines);
  for (const line of displayLines) {
    if (line.startsWith('diff --git')) {
      rendered.push(chalk.bold.white(`\n  ${line}`));
    } else if (line.startsWith('index ') || line.startsWith('new file ') || line.startsWith('deleted file ')) {
      rendered.push(chalk.dim(`  ${line}`));
    } else if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      rendered.push(chalk.dim.cyan(`  ${line}`));
    } else if (line.startsWith('@@')) {
      rendered.push(chalk.cyan(`  ${line}`));
    } else if (line.startsWith('+')) {
      rendered.push(chalk.green(`  ${line}`));
    } else if (line.startsWith('-')) {
      rendered.push(chalk.red(`  ${line}`));
    } else {
      rendered.push(chalk.gray(`  ${line}`));
    }
  }

  if (lines.length > maxLines) {
    rendered.push(chalk.yellow(`\n  ... [${lines.length - maxLines} diff lines omitted. Use /diff <file> to view full file diff] ...\n`));
  }

  return rendered.join('\n');
}

/**
 * Interactive or direct diff command handler.
 */
export async function showDiffTUI(
  cwd: string,
  targetFileArg?: string,
  renderer?: TerminalRenderer
): Promise<void> {
  const summary = await getWorkspaceDiffStats(cwd);

  if (targetFileArg) {
    const rawDiff = await getFileDiff(cwd, targetFileArg.trim());
    console.log(`\n  ${theme.diamond} ${theme.strong(`Diff: ${targetFileArg}`)}\n`);
    console.log(colorizeDiff(rawDiff));
    console.log();
    return;
  }

  console.log(renderDiffSummary(summary));

  if (summary.isClean || summary.files.length === 0) {
    return;
  }

  // Interactive selection in TTY
  if (process.stdin.isTTY) {
    try {
      const choices = [
        { name: '📖 View all diffs', value: '__ALL__' },
        ...summary.files.map(f => ({
          name: `${f.file.padEnd(35)} (+${f.insertions}, -${f.deletions})`,
          value: f.file
        })),
        { name: '✕ Close', value: '__EXIT__' }
      ];

      const selected = await select({
        message: 'Select file to inspect diff:',
        choices
      });

      if (selected === '__EXIT__') {
        return;
      }

      if (selected === '__ALL__') {
        const fullDiff = await getFileDiff(cwd);
        console.log(colorizeDiff(fullDiff));
        console.log();
        return;
      }

      const fileDiff = await getFileDiff(cwd, selected);
      console.log(`\n  ${theme.diamond} ${theme.strong(`Diff: ${selected}`)}\n`);
      console.log(colorizeDiff(fileDiff));
      console.log();
    } catch {
      // User cancelled prompt
    }
  } else {
    // Non-interactive fallback: output full colorized diff
    const fullDiff = await getFileDiff(cwd);
    if (fullDiff.trim()) {
      console.log(colorizeDiff(fullDiff));
      console.log();
    }
  }
}
