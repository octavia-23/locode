import { execSync } from 'node:child_process';
import chalk from 'chalk';
import ora, { Ora } from 'ora';
import { createTwoFilesPatch } from 'diff';
import { marked } from 'marked';
import MarkedTerminal from 'marked-terminal';

import { HardwareProfile } from '../hardware/detector.js';
import { theme } from './theme.js';

// Setup marked for terminal with clean, muted typography
marked.setOptions({
  renderer: new (MarkedTerminal as any)({
    tab: 2,
    code: (code: string) => theme.code(code),
    blockquote: (quote: string) => theme.muted(quote.trim()),
    heading: (text: string) => theme.strong(text),
    firstHeading: (text: string) => theme.strong(text),
    showPrefix: false
  })
});

function stripAnsi(str: string): string {
  return str.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
}

function getGitBranch(cwd: string): string {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000
    }).trim();
    if (!branch) return '';
    let isDirty = false;
    try {
      const status = execSync('git status --porcelain', {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 1000
      }).trim();
      isDirty = Boolean(status);
    } catch {}
    return isDirty ? `${branch}*` : branch;
  } catch {
    return '';
  }
}

export class TerminalRenderer {
  private spinner: Ora | null = null;

  renderMarkdown(text: string): string {
    try {
      return (marked(text) as string).trimEnd();
    } catch {
      return text;
    }
  }

  printHeader(
    model: string,
    cwd: string,
    autoApprove: boolean,
    hardwareProfile?: HardwareProfile,
    numCtx?: number,
    providerName?: string
  ) {
    const provDisplay = providerName === 'llamacpp' ? 'llama.cpp' : (providerName || 'ollama');
    const ctxVal = (numCtx || hardwareProfile?.selectedCtx || hardwareProfile?.recommendedCtx || 32768);
    const modeStr = autoApprove ? 'autonomous' : 'interactive';
    const branch = getGitBranch(cwd);

    const termWidth = process.stdout.columns || 80;
    const cardWidth = Math.max(66, Math.min(termWidth - 4, 74));
    const innerWidth = cardWidth - 4; // Minus 2 borders and 2 inner margin spaces

    const renderRow = (content: string) => {
      const visibleLen = stripAnsi(content).length;
      const pad = Math.max(0, innerWidth - visibleLen);
      console.log(`${theme.faint(theme.boxV)}  ${content}${' '.repeat(pad)}  ${theme.faint(theme.boxV)}`);
    };

    const topBorder = `${theme.faint(theme.boxTl + theme.boxH.repeat(cardWidth - 2) + theme.boxTr)}`;
    const botBorder = `${theme.faint(theme.boxBl + theme.boxH.repeat(cardWidth - 2) + theme.boxBr)}`;
    const emptyRow = `${theme.faint(theme.boxV)}${' '.repeat(cardWidth - 2)}${theme.faint(theme.boxV)}`;

    console.log();
    console.log(topBorder);

    // Title line
    const titleLeft = `${theme.diamond} ${theme.strong('locode')} ${theme.muted('v0.4.0')}`;
    const titleRight = `${theme.dim('local-first coding agent')}`;
    const titlePad = Math.max(1, innerWidth - stripAnsi(titleLeft).length - stripAnsi(titleRight).length);
    renderRow(`${titleLeft}${' '.repeat(titlePad)}${titleRight}`);

    console.log(emptyRow);

    // Metadata lines
    const labelPad = 11;
    renderRow(`${theme.muted('model'.padEnd(labelPad))} ${theme.text(model)} ${theme.dim(`(${provDisplay})`)}`);
    renderRow(`${theme.muted('context'.padEnd(labelPad))} ${theme.accent(`${ctxVal.toLocaleString()} tokens`)} ${theme.faint('·')} ${theme.tag(modeStr)}`);

    if (hardwareProfile) {
      const vramStr = hardwareProfile.totalVramMb > 0
        ? `${(hardwareProfile.totalVramMb / 1024).toFixed(1)} GB VRAM`
        : `${(hardwareProfile.totalRamMb / 1024).toFixed(1)} GB RAM`;
      const offloadBadge = hardwareProfile.measuredGpuOffloadVerified
        ? '100% offload'
        : (hardwareProfile.estimatedFullOffload7B ? 'gpu offload' : 'hybrid moe');

      renderRow(`${theme.muted('device'.padEnd(labelPad))} ${theme.secondary(hardwareProfile.deviceName)} ${theme.dim(`[${vramStr}]`)} ${theme.faint('·')} ${theme.dim(offloadBadge)}`);
    }

    const shortCwd = cwd.length > 42 ? '...' + cwd.slice(-39) : cwd;
    const branchDisplay = branch ? ` ${theme.dim(`(${branch})`)}` : '';
    renderRow(`${theme.muted('workspace'.padEnd(labelPad))} ${theme.secondary(shortCwd)}${branchDisplay}`);

    console.log(emptyRow);
    renderRow(`${theme.faint('enter prompt or /help · /undo · /verify · /diff · /stats · /clear')}`);

    console.log(botBorder);
    console.log();
  }

  startSpinner(text: string) {
    if (!this.spinner) {
      this.spinner = ora({
        text: theme.secondary(text),
        color: 'gray',
        spinner: 'dots'
      }).start();
    } else {
      this.spinner.text = theme.secondary(text);
    }
  }

  stopSpinner() {
    if (this.spinner) {
      this.spinner.stop();
      this.spinner = null;
    }
  }

  printToolCall(name: string, args: Record<string, any>) {
    this.stopSpinner();

    if (name === 'view_file') {
      const p = args.path || '';
      const range = args.start_line ? ` (lines ${args.start_line}–${args.end_line || ''})` : '';
      console.log(`${theme.actionDot} Read ${theme.path(p)}${theme.muted(range)}`);
    } else if (name === 'edit_file') {
      const p = args.path || args.target_file || '';
      console.log(`${theme.actionDot} Update ${theme.path(p)}`);
    } else if (name === 'write_file') {
      const p = args.path || '';
      console.log(`${theme.actionDot} Write ${theme.path(p)}`);
    } else if (name === 'batch_read_files') {
      const count = Array.isArray(args.paths) ? args.paths.length : 0;
      console.log(`${theme.actionDot} Read ${theme.path(`${count} files`)}`);
    } else if (name === 'run_command') {
      console.log(`${theme.actionDot} Bash ${theme.code(args.command)}`);
    } else if (name === 'search_code') {
      console.log(`${theme.actionDot} Search ${theme.code(`"${args.pattern || args.query}"`)}`);
    } else if (name === 'list_dir') {
      console.log(`${theme.actionDot} List ${theme.path(args.path || '.')}`);
    } else {
      console.log(`${theme.actionDot} ${name} ${theme.dim(JSON.stringify(args))}`);
    }
  }

  printDiff(filePath: string, oldContent: string, newContent: string) {
    this.stopSpinner();
    const patch = createTwoFilesPatch(filePath, filePath, oldContent, newContent, 'old', 'new');
    const rawLines = patch.split('\n').slice(4); // Skip patch file headers

    console.log(`${theme.branch}Changes in ${theme.path(filePath)}:`);

    let oldLine = 1;
    let newLine = 1;
    const hunks: Array<{ lineNo: number; type: 'add' | 'del' | 'ctx'; text: string }> = [];

    for (const line of rawLines) {
      if (line.startsWith('@@')) {
        const match = line.match(/^@@ -(\d+).*?\+(\d+)/);
        if (match) {
          oldLine = parseInt(match[1], 10);
          newLine = parseInt(match[2], 10);
        }
        continue;
      }
      if (line.startsWith('+')) {
        hunks.push({ lineNo: newLine++, type: 'add', text: line.slice(1) });
      } else if (line.startsWith('-')) {
        hunks.push({ lineNo: oldLine++, type: 'del', text: line.slice(1) });
      } else if (line.startsWith(' ') || line === '') {
        hunks.push({ lineNo: newLine++, type: 'ctx', text: line.startsWith(' ') ? line.slice(1) : line });
        oldLine++;
      }
    }

    const maxDisplay = 10;
    const changesOnly = hunks.filter(h => h.type === 'add' || h.type === 'del');
    const displayItems = hunks.length <= maxDisplay ? hunks : hunks.filter((h, idx) => {
      const isChange = h.type !== 'ctx';
      const prevChange = hunks[idx - 1] && hunks[idx - 1].type !== 'ctx';
      const nextChange = hunks[idx + 1] && hunks[idx + 1].type !== 'ctx';
      return isChange || prevChange || nextChange;
    }).slice(0, maxDisplay);

    for (const h of displayItems) {
      const gutterStr = theme.gutter(h.lineNo, 4);
      if (h.type === 'add') {
        console.log(`     ${gutterStr}${theme.diffAdd('+ ' + h.text)}`);
      } else if (h.type === 'del') {
        console.log(`     ${gutterStr}${theme.diffDel('- ' + h.text)}`);
      } else {
        console.log(`     ${gutterStr}${theme.diffContext('  ' + h.text)}`);
      }
    }

    const omitted = changesOnly.length - displayItems.filter(h => h.type !== 'ctx').length;
    if (omitted > 0) {
      console.log(`     ${theme.gutter('...', 4)}${theme.muted(`[${omitted} more changed lines]`)}`);
    }
  }

  printToolResult(name: string, result: string, isError: boolean = false) {
    this.stopSpinner();
    const lines = result.trim().split('\n');
    const firstLine = lines[0] || '';

    if (isError) {
      console.log(`${theme.branch}${theme.cross} ${theme.error(firstLine)}`);
      if (lines.length > 1) {
        lines.slice(1, 5).forEach(l => console.log(`${theme.branchSub}${theme.error(l)}`));
      }
    } else {
      console.log(`${theme.branch}${theme.check} ${theme.secondary(firstLine)}`);
      if (lines.length > 1 && lines.length <= 6) {
        lines.slice(1).forEach(l => console.log(`${theme.branchSub}${theme.muted(l)}`));
      } else if (lines.length > 6) {
        lines.slice(1, 4).forEach(l => console.log(`${theme.branchSub}${theme.muted(l)}`));
        console.log(`${theme.branchSub}${theme.faint(`... [${lines.length - 4} more lines in context]`)}`);
      }
    }
    console.log();
  }

  printAssistantMessage(content: string) {
    this.stopSpinner();
    if (!content.trim()) return;

    const thinkMatch = content.match(/<think>([\s\S]*?)<\/think>/i);
    if (thinkMatch) {
      const thought = thinkMatch[1].trim();
      const remaining = content.replace(/<think>[\s\S]*?<\/think>/i, '').trim();
      if (thought) {
        console.log(`\n  ${chalk.hex('#52525b')('│')} ${theme.dim('Thinking:')}`);
        for (const tLine of thought.split('\n')) {
          if (tLine.trim()) {
            console.log(`  ${chalk.hex('#3f3f46')('│')} ${theme.muted(tLine)}`);
          }
        }
      }
      if (remaining) {
        console.log('\n' + this.renderMarkdown(remaining) + '\n');
      }
    } else {
      console.log('\n' + this.renderMarkdown(content) + '\n');
    }
  }

  printError(message: string) {
    this.stopSpinner();
    console.log(`\n  ${theme.cross} ${theme.error(message)}\n`);
  }

  printWarning(message: string) {
    this.stopSpinner();
    console.log(`\n  ${theme.alert} ${theme.warning(message)}\n`);
  }

  printSuccess(message: string) {
    this.stopSpinner();
    console.log(`\n  ${theme.check} ${theme.success(message)}\n`);
  }

  printMentionedFiles(files: string[]) {
    if (files.length === 0) return;
    const formatted = files.map(f => theme.accent(`@${f}`)).join(' ');
    console.log(`  ${theme.arrow} context: ${formatted}\n`);
  }

  printTelemetry(
    usage?: { totalTokens: number; durationMs: number; tokensPerSecond: number; completionTokens: number },
    contextInfo?: { usedTokens: number; maxTokens: number; cacheHitRate?: number }
  ) {
    if (!usage) return;
    const sec = (usage.durationMs / 1000).toFixed(1);
    const tps = usage.tokensPerSecond > 0 ? `${usage.tokensPerSecond} tok/s` : '';

    const parts: string[] = [];
    if (tps) parts.push(tps);
    parts.push(`${(usage.completionTokens || usage.totalTokens).toLocaleString()} tok`);
    parts.push(`${sec}s`);

    if (contextInfo && contextInfo.maxTokens > 0) {
      const pct = Math.min(100, Math.round((contextInfo.usedTokens / contextInfo.maxTokens) * 100));
      const usedK = (contextInfo.usedTokens / 1024).toFixed(1);
      const maxK = (contextInfo.maxTokens / 1024).toFixed(1);
      const gaugeBar = theme.gauge(pct, 7);
      parts.push(`ctx ${gaugeBar} ${pct}% (${usedK}k/${maxK}k)`);
    }

    if (contextInfo?.cacheHitRate !== undefined && contextInfo.cacheHitRate > 0) {
      parts.push(`cache ${contextInfo.cacheHitRate}%`);
    }

    parts.push(theme.dim('$0.00 local'));

    const line = parts.join(` ${theme.faint('·')} `);
    console.log(`  ${theme.faint('──')} ${theme.muted(line)}\n`);
  }
}
