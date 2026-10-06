import path from 'node:path';
import { Command } from 'commander';
import { input } from '@inquirer/prompts';
import chalk from 'chalk';
import { AgentContext } from './types.js';
import { AgentLoop } from './agent/loop.js';
import { TerminalRenderer } from './ui/renderer.js';
import { handleSlashCommand } from './ui/commands.js';
import { HardwareDetector } from './hardware/detector.js';
import {
  DEFAULT_QWEN_MODEL_PATH,
  DEFAULT_QWEN_MODEL_ALIAS,
  INFERENCE_PROFILES,
  InferenceProfileName
} from './runtime/profiles.js';
import { RuntimeDetector } from './runtime/detector.js';
import { getSharedLlamaRuntime } from './providers/factory.js';

const program = new Command();

program
  .name('locode')
  .description('Local-First AI Developer CLI (Node.js & Local LLM)')
  .version('0.4.0')
  .argument('[prompt...]', 'Initial coding instruction to execute')
  .option('-m, --model <name>', 'Model to use (or alias for local TurboQuant model)')
  .option('-p, --provider <type>', 'Provider: llamacpp | ollama | openai | lmstudio | vllm')
  .option('-c, --ctx <number_or_size>', 'Context window size (e.g. 32768, 65536, 32k, 64k)')
  .option('--profile <name>', 'Inference profile: performance | large-context | balanced', 'performance')
  .option('--model-path <path>', 'Absolute path to local .gguf model file')
  .option('--llama-server <path>', 'Path to llama-server.exe')
  .option('--port <number>', 'Port for local model server (default: 8081 or auto-selected)')
  .option('--no-auto-start', 'Disable automatic start of llama-server')
  .option('--api-base <url>', 'Base URL for OpenAI-compatible provider (e.g. http://localhost:1234/v1)')
  .option('--api-key <key>', 'API key for OpenAI-compatible provider', 'not-needed')
  .option('-y, --yes', 'Automatically approve all tool executions without prompting', false)
  .option('--auto', 'Run in Autonomous Mode (alias for -y, --yes)', false)
  .option('-d, --dir <path>', 'Workspace directory', process.cwd())
  .option('--architect <model>', 'Secondary deep reasoning / architect model for complex bug escalation')
  .option('--mode <type>', 'Initial execution mode: worker | architect', 'worker')
  .option('--host <url>', 'Ollama API host URL', 'http://127.0.0.1:11434');

program.parse(process.argv);

const options = program.opts();
const promptArgs = program.args.join(' ').trim();
const targetCwd = path.resolve(options.dir);

const renderer = new TerminalRenderer();

function parseContextOption(ctxOpt?: string): number | undefined {
  if (!ctxOpt) return undefined;
  const lower = ctxOpt.toLowerCase().trim();
  if (lower === '8k') return 8192;
  if (lower === '16k') return 16384;
  if (lower === '32k') return 32768;
  if (lower === '64k') return 65536;
  if (lower === '128k') return 131072;
  const num = parseInt(lower, 10);
  return isNaN(num) ? undefined : num;
}

async function main() {
  // 1. Detect Host Hardware Architecture & Specs
  const hardwareProfile = await HardwareDetector.getProfile();

  // 2. Check for local TurboQuant Qwen model presence
  const configuredModelPath =
    options.modelPath || process.env.LOCODE_LOCAL_MODEL_PATH || DEFAULT_QWEN_MODEL_PATH;
  const isLocalModelPresent = await RuntimeDetector.isExecutableValid(configuredModelPath);

  // 3. Determine Provider:
  // If provider explicitly specified on CLI or env: use it.
  // Otherwise, if local TurboQuant Qwen model is available: default to 'llamacpp'.
  // Otherwise fallback to 'ollama'.
  let chosenProvider = options.provider || process.env.LOCODE_PROVIDER;
  if (!chosenProvider) {
    if (isLocalModelPresent) {
      chosenProvider = 'llamacpp';
    } else {
      chosenProvider = 'ollama';
    }
  }

  // 4. Determine Context Window & Inference Profile
  const profileName: InferenceProfileName =
    (options.profile as InferenceProfileName) ||
    (process.env.LOCODE_INFERENCE_PROFILE as InferenceProfileName) ||
    'performance';

  const cliCtx = parseContextOption(options.ctx) || parseContextOption(process.env.LOCODE_LOCAL_MODEL_CONTEXT);

  let numCtx: number;
  if (cliCtx) {
    numCtx = cliCtx;
  } else if (chosenProvider === 'llamacpp') {
    numCtx = profileName === 'large-context' ? 65536 : 32768;
  } else {
    numCtx = hardwareProfile.recommendedCtx;
  }

  // Determine active model name / alias
  let modelName = options.model;
  if (!modelName) {
    if (chosenProvider === 'llamacpp') {
      modelName = DEFAULT_QWEN_MODEL_ALIAS;
    } else {
      modelName = 'qwen2.5-coder:7b';
    }
  }

  const llamaConfig = {
    profileName,
    modelPath: configuredModelPath,
    modelAlias: modelName,
    serverPath: options.llamaServer || process.env.LOCODE_LLAMA_SERVER_PATH,
    port: options.port ? parseInt(options.port, 10) : (process.env.LOCODE_LOCAL_MODEL_PORT ? parseInt(process.env.LOCODE_LOCAL_MODEL_PORT, 10) : 8081),
    autoStart: options.autoStart !== false && process.env.LOCODE_LOCAL_MODEL_AUTO_START !== 'false',
    ...(INFERENCE_PROFILES[profileName] || INFERENCE_PROFILES.performance),
    contextSize: numCtx // Explicitly ensure user-configured numCtx overrides profile default!
  };

  const isAutoMode = Boolean(options.yes || (options as any).auto);

  const context: AgentContext = {
    cwd: targetCwd,
    autoApprove: isAutoMode,
    model: modelName,
    ollamaHost: options.host,
    provider: chosenProvider as any,
    apiBase: options.apiBase,
    apiKey: options.apiKey,
    numCtx,
    hardwareProfile,
    architectModel: options.architect,
    mode: (options.mode as 'worker' | 'architect') || 'worker',
    llamaConfig
  };

  // If using llamacpp provider and auto-start is enabled, ensure server readiness first
  if (context.provider === 'llamacpp' && llamaConfig.autoStart) {
    console.log(chalk.cyan.bold('\n🚀 Initializing Local TurboQuant LLM Server...'));
    console.log(chalk.gray(`  GPU Detected:        ${chalk.white(hardwareProfile.deviceName)} (${(hardwareProfile.totalVramMb / 1024).toFixed(1)} GB VRAM)`));
    console.log(chalk.gray(`  System RAM:          ${chalk.white((hardwareProfile.totalRamMb / 1024).toFixed(1) + ' GB')}`));
    console.log(chalk.gray(`  CPU Threads:         ${chalk.white(hardwareProfile.cpuThreads || 12)} threads`));
    console.log(chalk.gray(`  Inference Profile:   ${chalk.green.bold(profileName)} [Context: ${chalk.cyan(numCtx.toLocaleString() + ' tokens')}]`));
    console.log(chalk.gray(`  Model:               ${chalk.yellow('Qwen3.6-35B-A3B (IQ2_M TurboQuant)')}`));

    const runtime = getSharedLlamaRuntime(context);
    try {
      renderer.startSpinner('Starting llama-server and loading model weights into VRAM/RAM...');
      const readyResult = await runtime.ensureReady((msg) => {
        renderer.startSpinner(msg);
      });
      renderer.stopSpinner();
      context.apiBase = readyResult.apiBase;
      // Synchronize context.numCtx with actual server context!
      const activeCtx = runtime.getConfig().contextSize;
      if (activeCtx) {
        context.numCtx = activeCtx;
        llamaConfig.contextSize = activeCtx;
      }
      renderer.printSuccess(`Model loaded & ready at ${readyResult.apiBase} (context: ${context.numCtx.toLocaleString()} tokens)`);
    } catch (err: any) {
      renderer.stopSpinner();
      renderer.printError(`Failed to initialize local model runtime:\n${err.message}`);
      process.exit(1);
    }
  }

  const agent = new AgentLoop(context, renderer);
  const provider = agent.getProvider();

  await agent.init();

  // Check Provider health
  const isHealthy = await provider.isHealthy();
  if (!isHealthy) {
    const provName = context.provider === 'llamacpp' ? 'TurboQuant llama-server' : (context.provider || 'Ollama');
    renderer.printError(
      `Unable to connect to ${provName} at ${context.apiBase || context.ollamaHost}.\n` +
      `  Please ensure your local LLM server is running.`
    );
  }

  // If one-shot prompt was passed via CLI: e.g. locode "check git status and test"
  if (promptArgs) {
    renderer.printHeader(context.model, context.cwd, context.autoApprove, context.hardwareProfile, context.numCtx, context.provider);
    console.log(chalk.bold.green(`Task: `) + chalk.white(promptArgs) + '\n');
    await agent.run(promptArgs);
    renderer.stopSpinner();
    return;
  }

  // Interactive REPL Mode
  renderer.printHeader(context.model, context.cwd, context.autoApprove, context.hardwareProfile, context.numCtx, context.provider);

  while (true) {
    try {
      const modeTag = context.autoApprove
        ? chalk.hex('#e5c07b')('⚡auto')
        : chalk.hex('#5c6370')('safe');

      const userInput = await input({
        message: `${chalk.bold.hex('#61afef')('❯')} ${chalk.hex('#5c6370')(`[${modeTag}]`)} `,
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
