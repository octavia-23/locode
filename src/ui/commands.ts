import chalk from 'chalk';
import { execa } from 'execa';
import { AgentLoop } from '../agent/loop.js';
import { OllamaProvider } from '../providers/ollama.js';
import { allTools } from '../tools/index.js';
import { TerminalRenderer } from './renderer.js';

export async function handleSlashCommand(
  input: string,
  agent: AgentLoop,
  provider: OllamaProvider,
  renderer: TerminalRenderer,
  cwd: string
): Promise<boolean> {
  const parts = input.trim().split(/\s+/);
  const command = parts[0].toLowerCase();
  const arg = parts.slice(1).join(' ');

  switch (command) {
    case '/help':
      console.log(`\n${chalk.bold.cyan('Available Slash Commands:')}`);
      console.log(`  ${chalk.yellow('/model [name]')}  - View current model or switch (e.g. /model qwen2.5-coder:7b)`);
      console.log(`  ${chalk.yellow('/clear')}         - Clear conversation memory and reset context`);
      console.log(`  ${chalk.yellow('/diff')}          - Show current git status and changes in workspace`);
      console.log(`  ${chalk.yellow('/tools')}         - List all registered agent tools`);
      console.log(`  ${chalk.yellow('/exit')}          - Exit Locode CLI\n`);
      return true;

    case '/tools':
      console.log(`\n${chalk.bold.cyan('Registered Developer Tools:')}`);
      for (const t of allTools) {
        console.log(`  • ${chalk.green.bold(t.name)}: ${chalk.gray(t.description)}`);
      }
      console.log();
      return true;

    case '/model':
      if (!arg) {
        const current = provider.getModel();
        const available = await provider.getAvailableModels();
        console.log(`\n${chalk.bold('Current Model:')} ${chalk.cyan(current)}`);
        console.log(`${chalk.bold('Available Local Models:')}`);
        for (const m of available) {
          console.log(`  ${m === current ? chalk.green('✔ ' + m) : '  ' + chalk.gray(m)}`);
        }
        console.log(chalk.dim(`\nSwitch with: /model <name>\n`));
      } else {
        provider.setModel(arg);
        agent.setContext({ model: arg });
        renderer.printSuccess(`Model switched to ${chalk.cyan(arg)}`);
      }
      return true;

    case '/clear':
      agent.clearHistory();
      renderer.printSuccess('Conversation context reset.');
      return true;

    case '/diff':
      try {
        const status = await execa('git status -s', { cwd, shell: true });
        const diff = await execa('git diff', { cwd, shell: true });
        console.log(chalk.bold.yellow('\nGit Status:'));
        console.log(status.stdout || chalk.gray('(clean workspace)'));
        if (diff.stdout) {
          console.log(chalk.bold.yellow('\nGit Diff:'));
          console.log(chalk.gray(diff.stdout));
        }
      } catch (err: any) {
        renderer.printError(`Failed to run git diff: ${err.message}`);
      }
      return true;

    case '/exit':
    case '/quit':
      console.log(chalk.cyan('Goodbye! Happy coding!'));
      process.exit(0);

    default:
      if (command.startsWith('/')) {
        renderer.printError(`Unknown slash command: "${command}". Type /help for options.`);
        return true;
      }
      return false;
  }
}
