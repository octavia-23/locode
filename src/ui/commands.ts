import chalk from 'chalk';
import { execa } from 'execa';
import { AgentLoop } from '../agent/loop.js';
import { ILLMProvider } from '../providers/types.js';
import { allTools } from '../tools/index.js';
import { TerminalRenderer } from './renderer.js';

export async function handleSlashCommand(
  input: string,
  agent: AgentLoop,
  provider: ILLMProvider,
  renderer: TerminalRenderer,
  cwd: string
): Promise<boolean> {
  const parts = input.trim().split(/\s+/);
  const command = parts[0].toLowerCase();
  const arg = parts.slice(1).join(' ');

  switch (command) {
    case '/help':
      console.log(`\n${chalk.bold.cyan('Available Slash Commands:')}`);
      console.log(`  ${chalk.yellow('/undo')}          - ⏪ Rollback workspace to state before the last agent turn`);
      console.log(`  ${chalk.yellow('/commit [msg]')}  - 🤖 Auto-generate or apply a git commit for current changes`);
      console.log(`  ${chalk.yellow('/diff')}          - 📝 Show git status and pending changes in workspace`);
      console.log(`  ${chalk.yellow('/stats')}         - 📊 Display session token metrics and speed`);
      console.log(`  ${chalk.yellow('/model [name]')}  - 🔄 View current model or switch on the fly`);
      console.log(`  ${chalk.yellow('/clear')}         - 🧹 Clear conversation memory and reset context`);
      console.log(`  ${chalk.yellow('/tools')}         - 🛠️ List all registered agent tools`);
      console.log(`  ${chalk.yellow('/exit')}          - 🚪 Exit Locode CLI\n`);
      return true;

    case '/undo': {
      renderer.startSpinner('Rolling back to previous checkpoint...');
      const result = await agent.undo();
      renderer.stopSpinner();
      if (result.success) {
        renderer.printSuccess(result.message);
      } else {
        renderer.printError(result.message);
      }
      return true;
    }

    case '/commit': {
      try {
        const diffRes = await execa('git diff HEAD', { cwd, shell: true });
        const statusRes = await execa('git status -s', { cwd, shell: true });

        if (!statusRes.stdout.trim()) {
          console.log(chalk.gray('\nNo changes to commit (clean working tree).\n'));
          return true;
        }

        let commitMsg = arg;
        if (!commitMsg) {
          renderer.startSpinner('Generating Conventional Commit message with local LLM...');
          commitMsg = await agent.generateCommitMessage(diffRes.stdout || statusRes.stdout);
          renderer.stopSpinner();
        }

        console.log(chalk.cyan(`\nProposed Commit Message: "${chalk.white.bold(commitMsg)}"`));

        // Stage all and commit
        await execa('git add .', { cwd, shell: true });
        await execa(`git commit -m "${commitMsg.replace(/"/g, '\\"')}"`, { cwd, shell: true });
        renderer.printSuccess(`Committed changes: "${commitMsg}"\n`);
      } catch (err: any) {
        renderer.printError(`Commit failed: ${err.message}`);
      }
      return true;
    }

    case '/stats': {
      const stats = agent.getStats();
      const avgTps = stats.totalDurationMs > 0
        ? (stats.completionTokens / (stats.totalDurationMs / 1000)).toFixed(1)
        : '0.0';
      const sec = (stats.totalDurationMs / 1000).toFixed(1);

      console.log(`\n${chalk.bold.cyan('📊 Locode Session Statistics:')}`);
      console.log(`  • Turns completed:     ${chalk.yellow(stats.turns)}`);
      console.log(`  • Total tokens:        ${chalk.yellow(stats.totalTokens.toLocaleString())}`);
      console.log(`  • Prompt tokens:       ${chalk.gray(stats.promptTokens.toLocaleString())}`);
      console.log(`  • Generated tokens:    ${chalk.green(stats.completionTokens.toLocaleString())}`);
      console.log(`  • Total runtime:       ${chalk.cyan(`${sec}s`)}`);
      console.log(`  • Average speed:       ${chalk.magenta(`${avgTps} tok/s`)}\n`);
      return true;
    }

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
      await agent.clearHistory();
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
