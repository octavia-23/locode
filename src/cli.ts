import path from 'node:path';
import fs from 'node:fs/promises';
import { Agent, setGlobalDispatcher } from 'undici';
import { Command } from 'commander';

// Remove Node.js default 300s fetch headers timeout for large-context local LLM prefill & generations
try {
  setGlobalDispatcher(
    new Agent({
      headersTimeout: 0,
      bodyTimeout: 0,
      connectTimeout: 60000,
      keepAliveTimeout: 300000,
      keepAliveMaxTimeout: 600000
    })
  );
} catch {}
import { readInteractivePrompt } from './ui/prompt.js';
import chalk from 'chalk';
import { theme } from './ui/theme.js';
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
  .option('-c, --ctx <number_or_size>', 'Context window size (e.g. 32k, 64k, 128k, 262k)')
  .option('--profile <name>', 'Inference profile: ultra-context | performance | large-context | balanced', 'ultra-context')
  .option('--model-path <path>', 'Absolute path to local .gguf model file')
  .option('--llama-server <path>', 'Path to llama-server.exe')
  .option('--port <number>', 'Port for local model server (default: 8081 or auto-selected)')
  .option('--no-auto-start', 'Disable automatic start of llama-server')
  .option('--api-base <url>', 'Base URL for OpenAI-compatible provider (e.g. http://localhost:1234/v1)')
  .option('--api-key <key>', 'API key for OpenAI-compatible provider', 'not-needed')
  .option('-y, --yes', 'Automatically approve all tool executions without prompting', false)
  .option('--auto', 'Run in Autonomous Mode (alias for -y, --yes)', false)
  .option('-f, --file <path>', 'Load prompt from a text/markdown file')
  .option('-d, --dir <path>', 'Workspace directory', process.cwd())
  .option('--architect <model>', 'Secondary deep reasoning / architect model for complex bug escalation')
  .option('--mode <type>', 'Initial execution mode: worker | architect', 'worker')
  .option('--host <url>', 'Ollama API host URL', 'http://127.0.0.1:11434');

program.parse(process.argv);

const options = program.opts();
let promptArgs = program.args.join(' ').trim();
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
  if (lower === '192k') return 196608;
  if (lower === '256k' || lower === '262k') return 262144;
  const num = parseInt(lower, 10);
  return isNaN(num) ? undefined : num;
}

async function main() {
  if (options.file) {
    try {
      const filePath = path.resolve(process.cwd(), options.file);
      promptArgs = (await fs.readFile(filePath, 'utf8')).trim();
    } catch (err: any) {
      renderer.printError(`Failed to load prompt file "${options.file}": ${err.message}`);
      process.exit(1);
    }
  }

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
    (chosenProvider === 'llamacpp' ? 'ultra-context' : 'performance');

  const cliCtx = parseContextOption(options.ctx) || parseContextOption(process.env.LOCODE_LOCAL_MODEL_CONTEXT);

  let numCtx: number;
  if (cliCtx) {
    numCtx = cliCtx;
  } else if (chosenProvider === 'llamacpp') {
    if (profileName === 'ultra-context') {
      numCtx = 262144;
    } else if (profileName === 'large-context') {
      numCtx = 65536;
    } else if (profileName === 'performance') {
      numCtx = 32768;
    } else {
      numCtx = hardwareProfile.recommendedCtx;
    }
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
    console.log(`\n  ${theme.strong('starting local model runtime')}`);
    console.log(`  ${theme.muted('gpu')}      ${theme.secondary(hardwareProfile.deviceName)} ${theme.muted(`[${(hardwareProfile.totalVramMb / 1024).toFixed(1)} GB VRAM]`)}`);
    console.log(`  ${theme.muted('profile')}  ${theme.accent(profileName)} ${theme.faint('·')} ${theme.muted(`${numCtx.toLocaleString()} tokens`)}`);
    console.log(`  ${theme.muted('model')}    ${theme.secondary(modelName)}`);

    const runtime = getSharedLlamaRuntime(context);
    try {
      renderer.startSpinner('loading model weights into memory...');
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
      renderer.printSuccess(`model ready at ${readyResult.apiBase} (${(context.numCtx || 262144).toLocaleString()} ctx)`);
    } catch (err: any) {
      renderer.stopSpinner();
      renderer.printError(`failed to initialize local runtime: ${err.message}`);
      process.exit(1);
    }
  }

  const agent = new AgentLoop(context, renderer);
  const provider = agent.getProvider();

  await agent.init();

  // Check Provider health
  const isHealthy = await provider.isHealthy();
  if (!isHealthy) {
    const provName = context.provider === 'llamacpp' ? 'llama-server' : (context.provider || 'ollama');
    renderer.printError(
      `unable to connect to ${provName} at ${context.apiBase || context.ollamaHost}.\n` +
      `  ensure local LLM backend is running.`
    );
  }

  // If one-shot prompt was passed via CLI: e.g. locode "check git status and test"
  if (promptArgs) {
    renderer.printHeader(context.model, context.cwd, context.autoApprove, context.hardwareProfile, context.numCtx, context.provider);
    console.log(`  ${theme.arrow} ${theme.strong(promptArgs)}\n`);
    await agent.run(promptArgs);
    renderer.stopSpinner();
    return;
  }

  // Interactive REPL Mode
  renderer.printHeader(context.model, context.cwd, context.autoApprove, context.hardwareProfile, context.numCtx, context.provider);

  while (true) {
    try {
      const modeTag = context.autoApprove
        ? theme.accent('auto')
        : theme.muted('safe');

      const promptPrefix = `${theme.muted('locode')} ${theme.faint('·')} ${modeTag} ${theme.secondary('›')} `;
      const userInput = await readInteractivePrompt(promptPrefix);

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
