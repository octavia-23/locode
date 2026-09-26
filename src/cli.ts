import path from 'node:path';
import { Command } from 'commander';
import { input } from '@inquirer/prompts';
import chalk from 'chalk';
import { AgentContext } from './types.js';
import { AgentLoop } from './agent/loop.js';
import { TerminalRenderer } from './ui/renderer.js';
import { handleSlashCommand } from './ui/commands.js';

const program = new Command();

program
  .name('locode')
  .description('Local-First AI Developer CLI (Node.js & Local LLM)')
  .version('0.2.0')
  .argument('[prompt...]', 'Initial coding instruction to execute')
  .option('-m, --model <name>', 'Model to use', 'qwen2.5-coder:7b')
  .option('-p, --provider <type>', 'Provider: ollama | openai | lmstudio | vllm', 'ollama')
  .option('--api-base <url>', 'Base URL for OpenAI-compatible provider (e.g. http://localhost:1234/v1)')
  .option('--api-key <key>', 'API key for OpenAI-compatible provider', 'not-needed')
  .option('-y, --yes', 'Automatically approve all tool executions without prompting', false)
  .option('-d, --dir <path>', 'Workspace directory', process.cwd())
  .option('--host <url>', 'Ollama API host URL', 'http://127.0.0.1:11434');

program.parse(process.argv);

const options = program.opts();
const promptArgs = program.args.join(' ').trim();

const targetCwd = path.resolve(options.dir);

const context: AgentContext = {
  cwd: targetCwd,
  autoApprove: options.yes,
  model: options.model,
  ollamaHost: options.host,
  provider: options.provider,
  apiBase: options.apiBase,
  apiKey: options.apiKey
};

const renderer = new TerminalRenderer();
const agent = new AgentLoop(context, renderer);
const provider = agent.getProvider();

async function main() {
  await agent.init();

  // Check Provider health
  const isHealthy = await provider.isHealthy();
  if (!isHealthy) {
    renderer.printError(
      `Unable to connect to ${context.provider || 'Ollama'} at ${context.apiBase || context.ollamaHost}.\n` +
      `  Please ensure your local LLM server is running.`
    );
  }

  // If one-shot prompt was passed via CLI: e.g. locode "check git status and test"
  if (promptArgs) {
    renderer.printHeader(context.model, context.cwd, context.autoApprove);
    console.log(chalk.bold.green(`Task: `) + chalk.white(promptArgs) + '\n');
    await agent.run(promptArgs);
    renderer.stopSpinner();
    return;
  }

  // Interactive REPL Mode
  renderer.printHeader(context.model, context.cwd, context.autoApprove);

  while (true) {
    try {
      const userInput = await input({
        message: chalk.bold.cyan('locode >'),
      });

      const trimmed = userInput.trim();
      if (!trimmed) continue;

      if (trimmed.startsWith('/')) {
        const handled = await handleSlashCommand(trimmed, agent, provider, renderer, context.cwd);
        if (handled) continue;
      }

      await agent.run(trimmed);
      console.log(); // Blank line for spacing
    } catch (err: any) {
      if (err.name === 'ExitPromptError' || err.message?.includes('force closed')) {
        console.log(chalk.cyan('\nExiting Locode.'));
        process.exit(0);
      }
      renderer.printError(`Unexpected error: ${err.message}`);
    }
  }
}

main().catch(err => {
  renderer.printError(`Fatal error: ${err.message}`);
  process.exit(1);
});
