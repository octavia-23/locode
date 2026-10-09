import chalk from 'chalk';
import ora, { Ora } from 'ora';
import { createTwoFilesPatch } from 'diff';
import { marked } from 'marked';
import MarkedTerminal from 'marked-terminal';
import path from 'node:path';

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
    const ctxVal = (numCtx || hardwareProfile?.selectedCtx || hardwareProfile?.recommendedCtx || 32768).toLocaleString();
    const modeStr = autoApprove ? 'auto-pilot' : 'safe-mode';

    console.log();
    console.log(`  ${theme.strong('locode')}  ${theme.muted('0.1.0')} ${theme.faint('·')} ${theme.secondary(model)} ${theme.muted(`(${provDisplay})`)} ${theme.faint('·')} ${theme.accent(`${ctxVal} ctx`)}`);

    if (hardwareProfile) {
      const vramStr = hardwareProfile.totalVramMb > 0
        ? `${(hardwareProfile.totalVramMb / 1024).toFixed(1)} GB VRAM`
        : `${(hardwareProfile.totalRamMb / 1024).toFixed(1)} GB RAM`;
      const offloadBadge = hardwareProfile.measuredGpuOffloadVerified
        ? 'gpu 100%'
        : (hardwareProfile.estimatedFullOffload7B ? 'gpu offload' : 'hybrid moe');

      console.log(`  ${theme.muted('hw')}      ${theme.secondary(hardwareProfile.deviceName)} ${theme.muted(`[${vramStr}]`)} ${theme.faint('·')} ${theme.muted(offloadBadge)} ${theme.faint('·')} ${theme.accent(modeStr)}`);
    } else {
      console.log(`  ${theme.muted('mode')}    ${theme.accent(modeStr)}`);
    }

    const shortCwd = cwd.length > 55 ? '...' + cwd.slice(-52) : cwd;
    console.log(`  ${theme.muted('dir')}     ${theme.secondary(shortCwd)}`);
    console.log(`  ${theme.faint('type /help for commands · /auto for permissions')}`);
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
    const verb = this.getToolVerb(name);

    if (name === 'view_file') {
      const p = args.path || '';
      const range = args.start_line ? ` (${args.start_line}–${args.end_line || ''})` : '';
      console.log(`  ${theme.bullet} ${theme.muted(verb)} ${theme.path(p)}${theme.muted(range)}`);
    } else if (name === 'write_file' || name === 'edit_file') {
      const p = args.path || args.target_file || '';
      console.log(`  ${theme.bullet} ${theme.accent(verb)} ${theme.path(p)}`);
    } else if (name === 'batch_read_files') {
      const count = Array.isArray(args.paths) ? args.paths.length : 0;
      console.log(`  ${theme.bullet} ${theme.muted(verb)} ${theme.path(`${count} files`)}`);
    } else if (name === 'run_command') {
      console.log(`  ${theme.bullet} ${theme.accent(verb)} ${theme.code(args.command)}`);
    } else if (name === 'search_code') {
      console.log(`  ${theme.bullet} ${theme.muted(verb)} "${theme.code(args.pattern || args.query)}"`);
    } else if (name === 'list_dir') {
      console.log(`  ${theme.bullet} ${theme.muted(verb)} ${theme.path(args.path || '.')}`);
    } else {
      console.log(`  ${theme.bullet} ${theme.muted(name)} ${theme.dim(JSON.stringify(args))}`);
    }
  }

  private getToolVerb(name: string): string {
    switch (name) {
      case 'edit_file': return 'edit  ';
      case 'write_file': return 'write ';
      case 'view_file': return 'read  ';
      case 'batch_read_files': return 'read  ';
      case 'run_command': return 'run   ';
      case 'search_code': return 'find  ';
      case 'list_dir': return 'ls    ';
      default: return name;
    }
  }

  printDiff(filePath: string, oldContent: string, newContent: string) {
    this.stopSpinner();
    const patch = createTwoFilesPatch(filePath, filePath, oldContent, newContent, 'old', 'new');
    console.log(`\n  ${theme.muted('diff')} ${theme.path(filePath)}`);

    const lines = patch.split('\n').slice(4); // Skip headers
    for (const line of lines) {
      if (line.startsWith('+')) {
        console.log(`  ${theme.diffAdd(line)}`);
      } else if (line.startsWith('-')) {
        console.log(`  ${theme.diffDel(line)}`);
      } else if (line.startsWith('@')) {
        console.log(`  ${theme.diffHunk(line)}`);
      } else {
        console.log(`  ${theme.diffContext(line)}`);
      }
    }
    console.log();
  }

  printToolResult(name: string, result: string, isError: boolean = false) {
    this.stopSpinner();
    const lines = result.trim().split('\n');
    const firstLine = lines[0] || '';

    if (isError) {
      console.log(`  ${theme.cross} ${theme.error(firstLine)}`);
      if (lines.length > 1) {
        lines.slice(1, 5).forEach(l => console.log(`    ${theme.muted(l)}`));
      }
    } else {
      console.log(`  ${theme.check} ${theme.secondary(firstLine)}`);
      if (lines.length > 1 && lines.length <= 8) {
        lines.slice(1).forEach(l => console.log(`    ${theme.muted(l)}`));
      } else if (lines.length > 8) {
        lines.slice(1, 5).forEach(l => console.log(`    ${theme.muted(l)}`));
        console.log(`    ${theme.faint(`... [${lines.length - 5} more lines in context]`)}`);
      }
    }
    console.log();
  }

  printAssistantMessage(content: string) {
    this.stopSpinner();
    if (!content.trim()) return;
    console.log('\n' + this.renderMarkdown(content) + '\n');
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
    parts.push(`${usage.completionTokens || usage.totalTokens} tokens`);
    parts.push(`${sec}s`);

    if (contextInfo && contextInfo.maxTokens > 0) {
      const pct = Math.min(100, Math.round((contextInfo.usedTokens / contextInfo.maxTokens) * 100));
      const usedK = (contextInfo.usedTokens / 1024).toFixed(1);
      const maxK = (contextInfo.maxTokens / 1024).toFixed(1);
      parts.push(`ctx: ${usedK}k/${maxK}k (${pct}%)`);
    }

    if (contextInfo?.cacheHitRate !== undefined && contextInfo.cacheHitRate > 0) {
      parts.push(`cache: ${contextInfo.cacheHitRate}%`);
    }

    const line = parts.join(` ${theme.faint('·')} `);
    console.log(`  ${theme.muted(line)}\n`);
  }
}
