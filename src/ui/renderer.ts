import chalk from 'chalk';
import ora, { Ora } from 'ora';
import { createTwoFilesPatch } from 'diff';
import { marked } from 'marked';
import MarkedTerminal from 'marked-terminal';

import { HardwareProfile } from '../hardware/detector.js';

// Setup marked for terminal
marked.setOptions({
  renderer: new (MarkedTerminal as any)({
    tab: 2,
    code: chalk.yellow,
    blockquote: chalk.gray.italic,
    heading: chalk.bold.cyan,
    firstHeading: chalk.bold.magenta.underline,
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

  printHeader(model: string, cwd: string, autoApprove: boolean, hardwareProfile?: HardwareProfile, numCtx?: number, providerName?: string) {
    const provDisplay = providerName === 'llamacpp' ? 'TurboQuant (llama.cpp)' : (providerName || 'Ollama');
    const ctxVal = (numCtx || hardwareProfile?.selectedCtx || hardwareProfile?.recommendedCtx || 32768).toLocaleString();
    
    // Sleek mode badge
    const modeBadge = autoApprove 
      ? chalk.bgHex('#d19a66').hex('#1e1e2e').bold(' ⚡ AUTO-PILOT ') 
      : chalk.bgHex('#98c379').hex('#1e1e2e').bold(' 🛡 SAFE-MODE ');

    const topBorder    = chalk.hex('#3b4252')('╭────────────────────────────────────────────────────────────────────────╮');
    const bottomBorder = chalk.hex('#3b4252')('╰────────────────────────────────────────────────────────────────────────╯');
    const sideBorder   = chalk.hex('#3b4252')('│');

    console.log();
    console.log(topBorder);
    console.log(`${sideBorder}  ${chalk.bold.hex('#61afef')('✦ LOCODE')} ${chalk.hex('#5c6370')('│')} ${chalk.hex('#abb2bf')('Local-First Autonomous AI Engineer')}             ${sideBorder}`);
    console.log(chalk.hex('#3b4252')('├────────────────────────────────────────────────────────────────────────┤'));
    console.log(`${sideBorder}  ${chalk.dim('model')}      ${chalk.bold.whiteBright(model)} ${chalk.hex('#5c6370')(`(${provDisplay})`)}`);
    
    if (hardwareProfile) {
      const memStr = hardwareProfile.totalVramMb > 0
        ? `${(hardwareProfile.totalVramMb / 1024).toFixed(1)} GB VRAM`
        : `${(hardwareProfile.totalRamMb / 1024).toFixed(1)} GB RAM`;
      const offloadBadge = hardwareProfile.measuredGpuOffloadVerified
        ? chalk.hex('#98c379')('● 100% GPU')
        : (hardwareProfile.estimatedFullOffload7B
          ? chalk.hex('#61afef')('● GPU Offload')
          : chalk.hex('#e5c07b')('● Hybrid MoE'));
      console.log(`${sideBorder}  ${chalk.dim('hardware')}   ${chalk.hex('#abb2bf')(hardwareProfile.deviceName)} ${chalk.hex('#e06c75')(`[${memStr}]`)} ${offloadBadge}`);
    }

    console.log(`${sideBorder}  ${chalk.dim('context')}    ${chalk.hex('#61afef')(`${ctxVal} tokens`)} · ${modeBadge}`);
    console.log(`${sideBorder}  ${chalk.dim('workspace')}  ${chalk.hex('#d19a66')(cwd)}`);
    console.log(bottomBorder);
    console.log(chalk.hex('#5c6370')(`  Type ${chalk.yellow('/help')} for commands · ${chalk.yellow('/auto')} to toggle permissionless mode\n`));
  }

  startSpinner(text: string) {
    if (!this.spinner) {
      this.spinner = ora({
        text: chalk.hex('#abb2bf')(text),
        color: 'magenta',
        spinner: 'dots12'
      }).start();
    } else {
      this.spinner.text = chalk.hex('#abb2bf')(text);
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
    const toolBadge = chalk.bgHex('#61afef').hex('#1e1e2e').bold(` ⚙ ${name.toUpperCase()} `);
    console.log(`\n${toolBadge}`);
    
    if (name === 'view_file' || name === 'write_file' || name === 'edit_file') {
      const p = args.path || args.target_file || args.file_path;
      console.log(`  ${chalk.hex('#5c6370')('↳')} ${chalk.dim('target')}   ${chalk.whiteBright.bold(p)}`);
    } else if (name === 'run_command') {
      console.log(`  ${chalk.hex('#5c6370')('↳')} ${chalk.dim('command')}  ${chalk.hex('#98c379').bold(args.command)}`);
    } else if (name === 'search_code') {
      console.log(`  ${chalk.hex('#5c6370')('↳')} ${chalk.dim('query')}    "${chalk.hex('#e5c07b')(args.pattern || args.query)}"`);
    } else if (name === 'list_dir') {
      console.log(`  ${chalk.hex('#5c6370')('↳')} ${chalk.dim('dir')}      ${chalk.hex('#d19a66')(args.path || '.')}`);
    } else {
      const summary = JSON.stringify(args, null, 2)
        .split('\n')
        .slice(0, 5)
        .map(line => `  ${chalk.hex('#5c6370')(line)}`)
        .join('\n');
      console.log(summary);
    }
  }

  printDiff(filePath: string, oldContent: string, newContent: string) {
    this.stopSpinner();
    const patch = createTwoFilesPatch(filePath, filePath, oldContent, newContent, 'Original', 'Modified');
    console.log(chalk.hex('#e5c07b').bold(`\n📝 Proposed Changes: ${chalk.whiteBright(filePath)}`));
    
    const lines = patch.split('\n').slice(4); // Skip diff headers
    for (const line of lines) {
      if (line.startsWith('+')) {
        console.log(chalk.hex('#98c379')(line));
      } else if (line.startsWith('-')) {
        console.log(chalk.hex('#e06c75')(line));
      } else if (line.startsWith('@')) {
        console.log(chalk.hex('#61afef')(line));
      } else {
        console.log(chalk.hex('#5c6370')(line));
      }
    }
    console.log();
  }

  printToolResult(name: string, result: string, isError: boolean = false) {
    this.stopSpinner();
    const tag = isError 
      ? chalk.bgHex('#e06c75').hex('#1e1e2e').bold(' FAIL ') 
      : chalk.bgHex('#98c379').hex('#1e1e2e').bold(' DONE ');
    console.log(`  ${chalk.hex('#5c6370')('↳')} ${tag} ${chalk.hex('#5c6370')(name)}`);
    
    // Truncate long results for clean console display
    const lines = result.trim().split('\n');
    if (lines.length > 20) {
      const preview = lines.slice(0, 15).map(l => `    ${chalk.hex('#5c6370')(l)}`).join('\n');
      console.log(preview);
      console.log(chalk.hex('#e5c07b')(`    ... [${lines.length - 15} more lines hidden, processed in context] ...\n`));
    } else {
      const formatted = lines.map(l => `    ${chalk.hex('#abb2bf')(l)}`).join('\n');
      console.log(formatted ? formatted + '\n' : '    (empty output)\n');
    }
  }

  printAssistantMessage(content: string) {
    this.stopSpinner();
    if (!content.trim()) return;
    console.log(chalk.hex('#3b4252')('─'.repeat(72)));
    console.log(this.renderMarkdown(content));
    console.log(chalk.hex('#3b4252')('─'.repeat(72)));
  }

  printError(message: string) {
    this.stopSpinner();
    console.log(chalk.hex('#e06c75').bold(`\n✖ ${message}`));
  }

  printWarning(message: string) {
    this.stopSpinner();
    console.log(chalk.hex('#e5c07b')(`\n⚠ ${message}`));
  }

  printSuccess(message: string) {
    this.stopSpinner();
    console.log(chalk.hex('#98c379').bold(`\n✔ ${message}`));
  }

  printMentionedFiles(files: string[]) {
    if (files.length === 0) return;
    const formatted = files.map(f => chalk.hex('#61afef').bold(`@${f}`)).join(', ');
    console.log(chalk.dim(`📎 Injected context: ${formatted}\n`));
  }

  printTelemetry(
    usage?: { totalTokens: number; durationMs: number; tokensPerSecond: number; completionTokens: number },
    contextInfo?: { usedTokens: number; maxTokens: number; cacheHitRate?: number }
  ) {
    if (!usage) return;
    const sec = (usage.durationMs / 1000).toFixed(1);
    const tps = usage.tokensPerSecond > 0 ? `${usage.tokensPerSecond} tok/s` : '';
    
    // Format Reika-style pills
    const speedPill = tps ? chalk.hex('#98c379').bold(`⚡ ${tps}`) : '';
    const turnTokens = chalk.hex('#61afef')(`${usage.completionTokens || usage.totalTokens} tok`);
    const duration = chalk.hex('#5c6370')(`${sec}s`);

    let contextGauge = '';
    if (contextInfo && contextInfo.maxTokens > 0) {
      const pct = Math.min(100, Math.round((contextInfo.usedTokens / contextInfo.maxTokens) * 100));
      const usedK = (contextInfo.usedTokens / 1024).toFixed(1);
      const maxK = (contextInfo.maxTokens / 1024).toFixed(1);
      
      // Mini visual progress bar [████░░░░░░]
      const totalBars = 8;
      const filledBars = Math.min(totalBars, Math.round((pct / 100) * totalBars));
      const barStr = '█'.repeat(filledBars) + '░'.repeat(totalBars - filledBars);
      
      const barColor = pct > 80 ? chalk.hex('#e06c75') : pct > 60 ? chalk.hex('#e5c07b') : chalk.hex('#61afef');
      contextGauge = `ctx [${barColor(barStr)}] ${pct}% · ${usedK}k/${maxK}k`;
    }

    const hitPill = contextInfo?.cacheHitRate !== undefined 
      ? chalk.hex('#98c379')(`cache ${contextInfo.cacheHitRate}%`)
      : '';

    const telemetryItems = [
      speedPill,
      turnTokens,
      duration,
      contextGauge ? chalk.hex('#5c6370')(contextGauge) : '',
      hitPill
    ].filter(Boolean).join(chalk.hex('#3b4252')(' │ '));

    console.log(`\n  ${telemetryItems}\n`);
  }
}
