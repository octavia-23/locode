import chalk from 'chalk';
import ora, { Ora } from 'ora';
import { createTwoFilesPatch } from 'diff';
import { marked } from 'marked';
import MarkedTerminal from 'marked-terminal';

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

  printHeader(model: string, cwd: string, autoApprove: boolean) {
    const title = chalk.bold.hex('#61afef')('╔═══════════════════════════════════════════════════════╗');
    const name  = chalk.bold.hex('#61afef')('║   🤖 LOCODE - Local-First AI Developer CLI (Node.js)  ║');
    const foot  = chalk.bold.hex('#61afef')('╚═══════════════════════════════════════════════════════╝');
    console.log(`\n${title}\n${name}\n${foot}`);
    console.log(chalk.gray(`  Model:     ${chalk.cyan(model)} (via Ollama)`));
    console.log(chalk.gray(`  Workspace: ${chalk.white(cwd)}`));
    console.log(chalk.gray(`  Approvals: ${autoApprove ? chalk.yellow('Auto-approve (Danger mode enabled)') : chalk.green('Interactive (Safe mode)')}`));
    console.log(chalk.gray(`  Commands:  Type ${chalk.yellow('/help')} for options, or type your goal.\n`));
  }

  startSpinner(text: string) {
    if (!this.spinner) {
      this.spinner = ora({
        text: chalk.dim(text),
        color: 'cyan'
      }).start();
    } else {
      this.spinner.text = chalk.dim(text);
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
    const badge = chalk.bgCyan.black.bold(` TOOL `);
    const toolName = chalk.cyan.bold(name);
    console.log(`\n${badge} ${toolName}`);
    
    // Highlight specific tool arguments cleanly
    if (name === 'view_file' || name === 'write_file' || name === 'edit_file') {
      console.log(chalk.dim(`  Path: ${chalk.whiteBright(args.path || args.target_file || args.file_path)}`));
    } else if (name === 'run_command') {
      console.log(chalk.dim(`  Command: ${chalk.greenBright(args.command)}`));
    } else if (name === 'search_code') {
      console.log(chalk.dim(`  Query: "${chalk.yellow(args.pattern || args.query)}"`));
    } else {
      const summary = JSON.stringify(args, null, 2)
        .split('\n')
        .slice(0, 5)
        .map(line => `  ${chalk.dim(line)}`)
        .join('\n');
      console.log(summary);
    }
  }

  printDiff(filePath: string, oldContent: string, newContent: string) {
    this.stopSpinner();
    const patch = createTwoFilesPatch(filePath, filePath, oldContent, newContent, 'Original', 'Modified');
    console.log(chalk.bold.yellow(`\n📝 Proposed Changes for: ${filePath}`));
    
    const lines = patch.split('\n').slice(4); // Skip diff headers
    for (const line of lines) {
      if (line.startsWith('+')) {
        console.log(chalk.green(line));
      } else if (line.startsWith('-')) {
        console.log(chalk.red(line));
      } else if (line.startsWith('@')) {
        console.log(chalk.cyan(line));
      } else {
        console.log(chalk.gray(line));
      }
    }
    console.log();
  }

  printToolResult(name: string, result: string, isError: boolean = false) {
    this.stopSpinner();
    const tag = isError ? chalk.bgRed.white.bold(' ERROR ') : chalk.bgGreen.black.bold(' RESULT ');
    console.log(`${tag} ${chalk.dim(name)}`);
    
    // Truncate long results for console display
    const lines = result.trim().split('\n');
    if (lines.length > 20) {
      const preview = lines.slice(0, 15).join('\n');
      console.log(chalk.gray(preview));
      console.log(chalk.yellow(`  ... [${lines.length - 15} more lines hidden, passed to LLM] ...\n`));
    } else {
      console.log(chalk.gray(result.trim() ? result.trim() : '(empty output)') + '\n');
    }
  }

  printAssistantMessage(content: string) {
    this.stopSpinner();
    if (!content.trim()) return;
    console.log(chalk.dim('─'.repeat(60)));
    console.log(this.renderMarkdown(content));
    console.log(chalk.dim('─'.repeat(60)));
  }

  printError(message: string) {
    this.stopSpinner();
    console.log(chalk.red(`\n✖ ${message}`));
  }

  printSuccess(message: string) {
    this.stopSpinner();
    console.log(chalk.green(`\n✔ ${message}`));
  }

  printMentionedFiles(files: string[]) {
    if (files.length === 0) return;
    const formatted = files.map(f => chalk.cyan(`@${f}`)).join(', ');
    console.log(chalk.dim(`📎 Injected context: ${formatted}\n`));
  }

  printTelemetry(usage?: { totalTokens: number; durationMs: number; tokensPerSecond: number; completionTokens: number }) {
    if (!usage) return;
    const sec = (usage.durationMs / 1000).toFixed(1);
    const tps = usage.tokensPerSecond > 0 ? `${usage.tokensPerSecond} tok/s` : '';
    const stats = [
      `${usage.totalTokens} tokens`,
      tps,
      `${sec}s`
    ].filter(Boolean).join(' · ');

    console.log(chalk.dim(`\n  ⚡ [${stats}]`));
  }
}
