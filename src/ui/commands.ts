import path from 'node:path';
import fs from 'node:fs/promises';
import { execa } from 'execa';
import { AgentLoop } from '../agent/loop.js';
import { ILLMProvider } from '../providers/types.js';
import { allTools } from '../tools/index.js';
import { TerminalRenderer } from './renderer.js';
import { HardwareDetector } from '../hardware/detector.js';
import { CodeVerifier } from '../agent/verifier.js';
import { select, input as promptInput } from '@inquirer/prompts';
import {
  createLLMProvider,
  isCloudProvider,
  resolveProvider,
  SUPPORTED_PROVIDERS,
  getDefaultModelForProvider,
  getDefaultContextForProvider
} from '../providers/factory.js';
import {
  getApiKeyForProvider,
  getEnvKeyNameForProvider,
  saveApiKeyToGlobalEnv,
  getGlobalEnvPath,
  identifyProviderFromApiKey,
  maskApiKey
} from '../utils/config.js';
import { ProviderType, AgentContext } from '../types.js';
import { theme, setActiveTheme, getActiveTheme, getAvailableThemes } from './theme.js';
import { JournalRecoveryManager } from '../journal/recovery.js';
import { showDiffTUI } from './diff-viewer.js';

async function listWorkspaceFiles(cwd: string, query?: string): Promise<string[]> {
  try {
    const res = await execa('git ls-files', { cwd, shell: true });
    let files = res.stdout.split('\n').map(f => f.trim()).filter(Boolean);
    if (query) {
      const q = query.toLowerCase();
      files = files.filter(f => f.toLowerCase().includes(q));
    }
    return files.slice(0, 100);
  } catch {
    return [];
  }
}

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
    case '/help': {
      console.log(`\n  ${theme.diamond} ${theme.strong('Commands')}\n`);
      const cmdColWidth = 18;
      const cmds: [string, string][] = [
        ['/undo', 'Rollback workspace to checkpoint before last turn'],
        ['/verify [cmd]', 'Run linter & automated test suite'],
        ['/commit [msg]', 'Stage and commit workspace changes with git'],
        ['/diff [file]', 'Inspect colored diff and pending modifications'],
        ['/find [query]', 'Interactive workspace file search & preview'],
        ['/fork [name]', 'Fork conversation into an independent session branch'],
        ['/sessions', 'List and switch between saved conversation sessions'],
        ['/session <cmd>', 'Manage sessions (switch, list, delete)'],
        ['/theme [name]', 'Switch UI color palette (terracotta, nord, monokai...)'],
        ['/menu', 'Open interactive command palette'],
        ['/stats', 'Display session token count and generation speed'],
        ['/key [key]', 'Configure API key with auto-detection & model discovery'],
        ['/provider [name]', 'Switch active provider (gemini, anthropic, openai, llamacpp, ollama)'],
        ['/hardware', 'Inspect GPU, VRAM, and offload telemetry'],
        ['/mcp', 'List connected MCP servers and external tools'],
        ['/model [name]', 'Switch active LLM on the fly'],
        ['/context [sz]', 'Switch context window (16k, 32k, 64k, 262k)'],
        ['/profile [p]', 'Switch inference profile (ultra-context, performance)'],
        ['/mode [type]', 'Toggle worker vs architect lane'],
        ['/auto', 'Toggle autonomous zero-confirmation mode'],
        ['/file [path]', 'Execute prompt from a text/markdown file'],
        ['/memory', 'View persisted project session memory'],
        ['/clear', 'Reset conversation memory'],
        ['/resume', 'Resume interrupted task from durable execution journal'],
        ['/journal', 'Inspect durable execution journal status'],
        ['/tools', 'List registered agent tools'],
        ['/exit', 'Exit locode']
      ];
      for (const [cmd, desc] of cmds) {
        console.log(`    ${theme.accent(cmd.padEnd(cmdColWidth))} ${theme.muted(desc)}`);
      }
      console.log();
      return true;
    }

    case '/f':
    case '/file': {
      if (!arg) {
        console.log(`  ${theme.muted('usage: /file <path-to-prompt.txt>')}`);
        return true;
      }
      try {
        const filePath = path.resolve(cwd, arg);
        const content = (await fs.readFile(filePath, 'utf8')).trim();
        console.log(`  ${theme.arrow} task loaded from ${theme.path(arg)} ${theme.muted(`(${content.length} chars)`)}\n`);
        await agent.run(content);
      } catch (err: any) {
        renderer.printError(`failed to read prompt file: ${err.message}`);
      }
      return true;
    }

    case '/mcp': {
      const mcp = agent.getMCPManager();
      const servers = mcp.getActiveServers();
      const tools = mcp.getLoadedTools();

      console.log(`\n  ${theme.strong('mcp servers')}`);
      if (servers.length === 0) {
        console.log(`  ${theme.muted('no active mcp servers connected')}`);
        console.log(`  ${theme.faint('create a .mcp.json file to connect servers (e.g. sqlite, github, fetch)\n')}`);
      } else {
        console.log(`  active: ${theme.secondary(servers.join(', '))}`);
        console.log(`  tools (${tools.length}):`);
        for (const t of tools) {
          console.log(`    ${theme.bullet} ${theme.secondary(t.name)} ${theme.faint(t.description)}`);
        }
        console.log();
      }
      return true;
    }

    case '/hardware': {
      const hw = await HardwareDetector.getProfile();
      const ctx = agent.getContext();
      const activeCtx = ctx.numCtx || hw.recommendedCtx;

      console.log(`\n  ${theme.diamond} ${theme.strong('Hardware & Telemetry')}\n`);
      console.log(`    ${theme.muted('device'.padEnd(12))} ${theme.secondary(hw.deviceName)} ${theme.dim(`[${hw.type}]`)}`);
      if (hw.totalVramMb > 0) {
        const usedVram = Math.max(0, hw.totalVramMb - hw.freeVramMb);
        console.log(`    ${theme.muted('vram'.padEnd(12))} ${theme.secondary(`${(hw.totalVramMb / 1024).toFixed(1)} GB`)} ${theme.dim(`(free: ${(hw.freeVramMb / 1024).toFixed(1)} GB, used: ${(usedVram / 1024).toFixed(1)} GB)`)}`);
      }
      console.log(`    ${theme.muted('ram'.padEnd(12))} ${theme.secondary(`${(hw.totalRamMb / 1024).toFixed(1)} GB`)} ${theme.dim(`(free: ${(hw.freeRamMb / 1024).toFixed(1)} GB)`)}`);
      console.log(`    ${theme.muted('backend'.padEnd(12))} ${theme.secondary(hw.backend)}`);
      console.log(`    ${theme.muted('model'.padEnd(12))} ${theme.secondary(ctx.model)}`);
      console.log(`    ${theme.muted('context'.padEnd(12))} ${theme.accent(`${activeCtx.toLocaleString()} tokens`)} ${theme.dim(`(recommended: ${hw.recommendedCtx.toLocaleString()})`)}`);

      const offloadStr = hw.measuredGpuOffloadVerified
        ? '100% gpu offload (verified)'
        : (hw.estimatedFullOffload7B ? 'gpu offload' : 'hybrid moe');
      console.log(`    ${theme.muted('offload'.padEnd(12))} ${theme.secondary(offloadStr)}`);

      if (hw.notes.length > 0) {
        console.log(`\n    ${theme.muted('notes:')}`);
        for (const note of hw.notes) {
          console.log(`      ${theme.bullet} ${theme.muted(note)}`);
        }
      }
      console.log();
      return true;
    }

    case '/undo': {
      renderer.startSpinner('rolling back to previous checkpoint...');
      const result = await agent.undo();
      renderer.stopSpinner();
      if (result.success) {
        renderer.printSuccess(result.message);
      } else {
        renderer.printError(result.message);
      }
      return true;
    }

    case '/verify': {
      renderer.startSpinner('running workspace verification...');
      const vResult = await CodeVerifier.run(cwd, arg || undefined);
      renderer.stopSpinner();

      if (!vResult.command) {
        console.log(`\n  ${theme.muted('no verification command detected in workspace')}\n`);
        return true;
      }

      console.log(`\n  ${theme.diamond} ${theme.strong('Verification Report')}\n`);
      console.log(`    ${theme.muted('command'.padEnd(12))} ${theme.code(vResult.command)}`);
      if (vResult.passed) {
        console.log(`    ${theme.muted('status'.padEnd(12))} ${theme.check} ${theme.success('passed (0 errors)')}\n`);
      } else {
        console.log(`    ${theme.muted('status'.padEnd(12))} ${theme.cross} ${theme.error('failed')}`);
        if (vResult.errorOutput) {
          console.log();
          for (const line of vResult.errorOutput.split('\n')) {
            console.log(`    ${theme.muted(line)}`);
          }
          console.log();
        }
      }
      return true;
    }

    case '/commit': {
      try {
        const diffRes = await execa('git diff HEAD', { cwd, shell: true });
        const statusRes = await execa('git status -s', { cwd, shell: true });

        if (!statusRes.stdout.trim()) {
          console.log(`\n  ${theme.muted('clean working tree, nothing to commit')}\n`);
          return true;
        }

        let commitMsg = arg;
        if (!commitMsg) {
          renderer.startSpinner('generating commit message...');
          commitMsg = await agent.generateCommitMessage(diffRes.stdout || statusRes.stdout);
          renderer.stopSpinner();
        }

        console.log(`\n  ${theme.muted('commit message:')} ${theme.strong(commitMsg)}`);

        // Stage all and commit
        await execa('git add .', { cwd, shell: true });
        await execa(`git commit -m "${commitMsg.replace(/"/g, '\\"')}"`, { cwd, shell: true });
        renderer.printSuccess(`committed: "${commitMsg}"\n`);
      } catch (err: any) {
        renderer.printError(`commit failed: ${err.message}`);
      }
      return true;
    }

    case '/stats': {
      const stats = agent.getStats();
      const ctx = agent.getContext();
      const ctxEngine = agent.getContextEngine();
      const ctxStats = ctxEngine.getStats();
      const isCloud = isCloudProvider(ctx.provider);
      const avgTps = stats.totalDurationMs > 0
        ? (stats.completionTokens / (stats.totalDurationMs / 1000)).toFixed(1)
        : '0.0';
      const sec = (stats.totalDurationMs / 1000).toFixed(1);

      console.log(`\n  ${theme.diamond} ${theme.strong('Session Telemetry & Dashboard')}\n`);
      console.log(`    ${theme.muted('provider'.padEnd(16))} ${theme.accent(ctx.provider || 'auto')} ${theme.dim(`[${isCloud ? '☁ Cloud Frontier' : '💻 Local Quantized'}]`)}`);
      console.log(`    ${theme.muted('model'.padEnd(16))} ${theme.secondary(ctx.model)}`);
      console.log(`    ${theme.muted('turns'.padEnd(16))} ${theme.text(String(stats.turns))}`);
      console.log(`    ${theme.muted('model calls'.padEnd(16))} ${theme.text(String(stats.modelCalls))}`);

      // Tool success rate
      const totalTools = stats.toolCalls;
      const toolSuccessPct = totalTools > 0 ? Math.round((stats.successfulToolCalls / totalTools) * 100) : 100;
      const toolGauge = theme.gauge(toolSuccessPct, 6);
      console.log(`    ${theme.muted('tool calls'.padEnd(16))} ${theme.text(String(totalTools))} ${theme.dim(`(${stats.successfulToolCalls} ok, ${stats.failedToolCalls} fail)`)} ${toolGauge} ${theme.dim(`${toolSuccessPct}%`)}`);

      // Tokens breakdown
      console.log(`    ${theme.muted('total tokens'.padEnd(16))} ${theme.text(stats.totalTokens.toLocaleString())}`);
      console.log(`    ${theme.muted('prompt tok'.padEnd(16))} ${theme.dim(stats.promptTokens.toLocaleString())}`);
      console.log(`    ${theme.muted('output tok'.padEnd(16))} ${theme.secondary(stats.completionTokens.toLocaleString())}`);

      // Context efficiency & compaction
      const activeCtx = ctx.numCtx || 32768;
      const estTokens = ctxStats.totalTokensEstimated || 0;
      const ctxPct = Math.min(100, Math.round((estTokens / activeCtx) * 100));
      const ctxGauge = theme.gauge(ctxPct, 8);
      console.log(`    ${theme.muted('active context'.padEnd(16))} ${ctxGauge} ${theme.accent(`${ctxPct}%`)} ${theme.dim(`(${estTokens.toLocaleString()} / ${activeCtx.toLocaleString()} tokens)`)}`);

      const savedTokens = (stats.tokensSavedByCompression || 0) + (ctxStats.tokensSavedByCompression || 0);
      const dedupeTokens = (stats.tokensAvoidedByDeduplication || 0) + (ctxStats.tokensAvoidedByDeduplication || 0);
      if (savedTokens > 0 || dedupeTokens > 0) {
        console.log(`    ${theme.muted('budget savings'.padEnd(16))} ${theme.success(`+${(savedTokens + dedupeTokens).toLocaleString()} tokens saved`)} ${theme.dim(`(${savedTokens.toLocaleString()} compacted, ${dedupeTokens.toLocaleString()} deduped)`)}`);
      }

      console.log(`    ${theme.muted('duration'.padEnd(16))} ${theme.secondary(`${sec}s`)}`);
      console.log(`    ${theme.muted('avg speed'.padEnd(16))} ${theme.accent(`${avgTps} tok/s`)}\n`);
      return true;
    }

    case '/key':
    case '/apikey':
    case '/auth': {
      let keyToSet = arg.trim();

      if (!keyToSet) {
        if (!process.stdin.isTTY) {
          renderer.printError('usage: /key <api-key>');
          return true;
        }
        try {
          keyToSet = await promptInput({
            message: 'Enter your API key:',
            validate: (val: string) => val.trim().length > 0 || 'API key cannot be empty'
          });
          keyToSet = keyToSet.trim();
        } catch {
          return true;
        }
      }

      if (!keyToSet) return true;

      // Automatically identify provider from API key format
      let detectedProvider = identifyProviderFromApiKey(keyToSet);
      if (!detectedProvider) {
        if (process.stdin.isTTY) {
          try {
            detectedProvider = await select<ProviderType>({
              message: 'Could not automatically identify provider from key format. Select provider for this key:',
              choices: [
                { name: 'Gemini (Google AI)', value: 'gemini' },
                { name: 'Anthropic (Claude)', value: 'anthropic' },
                { name: 'APINex (https://apinex.bond)', value: 'apinex' },
                { name: 'OpenAI', value: 'openai' },
                { name: 'Groq', value: 'groq' },
                { name: 'OpenRouter', value: 'openrouter' },
                { name: 'NVIDIA NIM', value: 'nim' }
              ]
            });
          } catch {
            return true;
          }
        } else {
          detectedProvider = 'openai';
        }
      }

      const envVarName = getEnvKeyNameForProvider(detectedProvider);
      saveApiKeyToGlobalEnv(envVarName, keyToSet);
      process.env[envVarName] = keyToSet;

      console.log(`\n  ${theme.strong('✓')} Identified provider: ${theme.accent(detectedProvider)} ${theme.muted(`(${envVarName} = ${maskApiKey(keyToSet)})`)}`);
      console.log(`  ${theme.strong('✓')} Saved credentials to ${theme.secondary(getGlobalEnvPath())}\n`);

      // Automatically load models for this provider
      const defaultModel = getDefaultModelForProvider(detectedProvider);
      const defaultCtx = getDefaultContextForProvider(detectedProvider);

      const newContext: AgentContext = {
        ...agent.getContext(),
        provider: detectedProvider,
        model: defaultModel,
        apiKey: keyToSet,
        apiBase: undefined,
        numCtx: defaultCtx
      };

      const newProvider = createLLMProvider(newContext);

      renderer.startSpinner(`querying available models for ${detectedProvider}...`);
      let availableModels: string[] = [];
      try {
        availableModels = await newProvider.getAvailableModels();
      } catch {
        availableModels = [defaultModel];
      } finally {
        renderer.stopSpinner();
      }

      if (!availableModels || availableModels.length === 0) {
        availableModels = [defaultModel];
      }

      let selectedModel = defaultModel;
      if (process.stdin.isTTY && availableModels.length > 0) {
        try {
          selectedModel = await select({
            message: `Select a model for ${detectedProvider}:`,
            default: availableModels.includes(defaultModel) ? defaultModel : availableModels[0],
            choices: availableModels.map(m => ({
              name: m === defaultModel ? `${m} (recommended)` : m,
              value: m
            }))
          });
        } catch {
          selectedModel = defaultModel;
        }
      }

      newProvider.setModel(selectedModel);
      newContext.model = selectedModel;

      agent.setProvider(newProvider, detectedProvider);
      agent.setContext(newContext);

      const cloudBadge = isCloudProvider(detectedProvider) ? '☁ Cloud Frontier' : '💻 Local Quantized';
      renderer.printSuccess(`active provider is now ${detectedProvider} [${cloudBadge}] (model: ${selectedModel}, ctx: ${defaultCtx.toLocaleString()}, ${availableModels.length} models detected)`);
      return true;
    }

    case '/provider': {
      const ctx = agent.getContext();
      const activeProvider = ctx.provider || 'ollama';

      let targetProvider: ProviderType | undefined;

      if (!arg) {
        if (!process.stdin.isTTY) {
          console.log(`\n  ${theme.diamond} ${theme.strong('LLM Providers')}\n`);
          console.log(`    ${theme.muted('active:')} ${theme.accent(activeProvider)} ${theme.dim(`[${isCloudProvider(activeProvider) ? '☁ Cloud' : '💻 Local'}]`)}\n`);
          console.log(`    ${theme.muted('available providers:')}`);
          for (const p of SUPPORTED_PROVIDERS) {
            const isAct = p.name === activeProvider;
            const marker = isAct ? theme.check : ' ';
            const tag = p.type === 'cloud' ? theme.dim('(cloud)') : theme.dim('(local)');
            const label = isAct ? theme.strong(p.name) : theme.secondary(p.name);
            console.log(`    ${marker} ${label.padEnd(14)} ${tag.padEnd(10)} ${theme.muted(`default: ${p.defaultModel}`)}`);
          }
          console.log(`\n  ${theme.faint('switch with: /provider <name> (e.g. /provider gemini)\n')}`);
          return true;
        }

        try {
          targetProvider = await select<ProviderType>({
            message: 'Select an LLM Provider:',
            default: activeProvider,
            choices: SUPPORTED_PROVIDERS.map(p => ({
              name: `${p.name.padEnd(12)} ${p.type === 'cloud' ? '☁ Cloud' : '💻 Local'}  (default: ${p.defaultModel})`,
              value: p.name,
              description: `Switch active provider to ${p.name}`
            }))
          });
        } catch {
          return true;
        }
      } else {
        const requested = arg.trim().toLowerCase() as ProviderType;
        const target = SUPPORTED_PROVIDERS.find(p => p.name === requested);
        if (!target) {
          renderer.printError(`unknown provider "${arg}". Choose: ${SUPPORTED_PROVIDERS.map(p => p.name).join(', ')}`);
          return true;
        }
        targetProvider = requested;
      }

      if (!targetProvider) return true;

      const target = SUPPORTED_PROVIDERS.find(p => p.name === targetProvider)!;

      // Check for required API key if cloud provider
      let targetApiKey = isCloudProvider(targetProvider) ? getApiKeyForProvider(targetProvider) : undefined;
      if (isCloudProvider(targetProvider) && !targetApiKey) {
        const envVar = getEnvKeyNameForProvider(targetProvider);
        if (process.stdin.isTTY) {
          console.log(`\n  ${theme.diamond} ${theme.strong(`Setup ${targetProvider.toUpperCase()} API Key`)}`);
          console.log(`  ${theme.muted(`No active ${envVar} detected in environment or ${getGlobalEnvPath()}.`)}\n`);
          try {
            const entered = await promptInput({
              message: `Enter ${envVar}:`,
              validate: (val: string) => val.trim().length > 0 || 'API key cannot be empty'
            });
            const trimmedKey = entered ? entered.trim() : '';
            if (trimmedKey) {
              targetApiKey = trimmedKey;
              saveApiKeyToGlobalEnv(envVar, trimmedKey);
              console.log(`  ${theme.strong('✓')} Saved ${theme.accent(envVar)} to ${theme.secondary(getGlobalEnvPath())}\n`);
            }
          } catch {
            return true;
          }
        }
        if (!targetApiKey) {
          renderer.printError(`API key for ${targetProvider} is required. Set ${envVar} or use /key`);
          return true;
        }
      }

      try {
        const newNumCtx = getDefaultContextForProvider(targetProvider);
        let selectedModel = target.defaultModel;

        const newContext: AgentContext = {
          ...ctx,
          provider: targetProvider,
          model: target.defaultModel,
          apiKey: targetApiKey,
          apiBase: undefined,
          numCtx: newNumCtx
        };

        const newProvider = createLLMProvider(newContext);

        // Fetch available models
        let availableModels: string[] = [];
        try {
          renderer.startSpinner(`querying available models for ${targetProvider}...`);
          availableModels = await newProvider.getAvailableModels();
        } catch {
          availableModels = [target.defaultModel];
        } finally {
          renderer.stopSpinner();
        }

        if (!availableModels || availableModels.length === 0) {
          availableModels = [target.defaultModel];
        }

        // Give user option to just use arrow buttons to select a model within the given options
        if (process.stdin.isTTY && availableModels.length > 0) {
          try {
            selectedModel = await select({
              message: `Select a model for ${targetProvider}:`,
              default: availableModels.includes(target.defaultModel) ? target.defaultModel : availableModels[0],
              choices: availableModels.map(m => ({
                name: m === target.defaultModel ? `${m} (recommended)` : m,
                value: m
              }))
            });
          } catch {
            selectedModel = target.defaultModel;
          }
        }

        newProvider.setModel(selectedModel);
        newContext.model = selectedModel;

        agent.setProvider(newProvider, targetProvider);
        agent.setContext(newContext);

        const cloudBadge = isCloudProvider(targetProvider) ? '☁ Cloud Frontier' : '💻 Local Quantized';
        renderer.printSuccess(`provider switched to ${targetProvider} [${cloudBadge}] (model: ${selectedModel}, ctx: ${newNumCtx.toLocaleString()})`);
      } catch (err: any) {
        renderer.printError(`failed to switch provider: ${err.message}`);
      }
      return true;
    }

    case '/tools':
      console.log(`\n  ${theme.strong('available tools')}`);
      for (const t of allTools) {
        console.log(`  ${theme.bullet} ${theme.secondary(t.name)} ${theme.muted(`- ${t.description}`)}`);
      }
      console.log();
      return true;

    case '/model':
      if (!arg) {
        const current = provider.getModel();
        let available: string[] = [];
        try {
          renderer.startSpinner('fetching available models...');
          available = await provider.getAvailableModels();
        } catch {
          available = [current];
        } finally {
          renderer.stopSpinner();
        }

        if (process.stdin.isTTY && available.length > 0) {
          try {
            const chosen = await select({
              message: 'Select a model:',
              default: current,
              choices: available.map(m => ({
                name: m === current ? `${m} (active)` : m,
                value: m
              }))
            });
            provider.setModel(chosen);
            agent.setContext({ model: chosen });
            renderer.printSuccess(`model switched to ${chosen}`);
          } catch {
            // Cancelled
          }
          return true;
        }

        console.log(`\n  ${theme.strong('models')}`);
        console.log(`  ${theme.muted('active:')} ${theme.accent(current)}`);
        console.log(`  ${theme.muted('available:')}`);
        for (const m of available) {
          const isAct = m === current;
          console.log(`    ${isAct ? theme.check : ' '} ${isAct ? theme.strong(m) : theme.muted(m)}`);
        }
        console.log(`\n  ${theme.faint('switch with: /model <name>\n')}`);
      } else {
        provider.setModel(arg);
        agent.setContext({ model: arg });
        renderer.printSuccess(`model switched to ${arg}`);
      }
      return true;

    case '/context':
    case '/ctx': {
      const currentCtx = agent.getContext().numCtx || 262144;
      if (!arg) {
        console.log(`\n  ${theme.strong('context window')}`);
        console.log(`  ${theme.muted('active:')} ${theme.accent(currentCtx.toLocaleString())} tokens`);
        console.log(`  ${theme.muted('presets:')}`);
        console.log(`  ${theme.bullet} ${theme.secondary('/context 16k')}  ${theme.muted('(16,384 tokens)')}`);
        console.log(`  ${theme.bullet} ${theme.secondary('/context 32k')}  ${theme.muted('(32,768 tokens - performance)')}`);
        console.log(`  ${theme.bullet} ${theme.secondary('/context 64k')}  ${theme.muted('(65,536 tokens - large context)')}`);
        console.log(`  ${theme.bullet} ${theme.secondary('/context 128k')} ${theme.muted('(131,072 tokens)')}`);
        console.log(`  ${theme.bullet} ${theme.secondary('/context 262k')} ${theme.muted('(262,144 tokens - ultra-context)')}\n`);
        return true;
      }

      let parsed = parseInt(arg.toLowerCase().replace(/k$/, '000').replace(/kb$/, '000'), 10);
      if (arg.toLowerCase() === '8k') parsed = 8192;
      else if (arg.toLowerCase() === '16k') parsed = 16384;
      else if (arg.toLowerCase() === '32k') parsed = 32768;
      else if (arg.toLowerCase() === '64k') parsed = 65536;
      else if (arg.toLowerCase() === '128k') parsed = 131072;
      else if (arg.toLowerCase() === '192k') parsed = 196608;
      else if (arg.toLowerCase() === '256k' || arg.toLowerCase() === '262k') parsed = 262144;

      if (!parsed || isNaN(parsed) || parsed < 1024) {
        renderer.printError(`invalid context size "${arg}". Choose 8k, 16k, 32k, 64k, 128k, or 262k.`);
        return true;
      }

      agent.setContext({ numCtx: parsed });
      renderer.printSuccess(`context window switched to ${parsed.toLocaleString()} tokens.`);
      return true;
    }

    case '/profile': {
      const ctx = agent.getContext();
      const currentProfile = (ctx.llamaConfig as any)?.profileName || 'ultra-context';
      if (!arg) {
        console.log(`\n  ${theme.strong('inference profiles')}`);
        console.log(`  ${theme.muted('active:')} ${theme.accent(currentProfile)}`);
        console.log(`  ${theme.bullet} ${theme.secondary('ultra-context')} ${theme.muted('262K context, MoE 34 (RTX 4050 6GB baseline)')}`);
        console.log(`  ${theme.bullet} ${theme.secondary('performance')}   ${theme.muted('32K context, MoE 24 (peak speed ~35 tok/s)')}`);
        console.log(`  ${theme.bullet} ${theme.secondary('large-context')} ${theme.muted('64K context, MoE 24')}`);
        console.log(`  ${theme.bullet} ${theme.secondary('balanced')}      ${theme.muted('16K context, MoE 28')}\n`);
        return true;
      }

      const pName = arg.trim().toLowerCase();
      if (pName === 'ultra-context' || pName === '262k') {
        agent.setContext({ numCtx: 262144, llamaConfig: { profileName: 'ultra-context', contextSize: 262144, nCpuMoe: 34 } });
        renderer.printSuccess(`switched to ultra-context profile (262K context)`);
      } else if (pName === 'performance') {
        agent.setContext({ numCtx: 32768, llamaConfig: { profileName: 'performance', contextSize: 32768, nCpuMoe: 24 } });
        renderer.printSuccess(`switched to performance profile (32K context)`);
      } else if (pName === 'large-context' || pName === '64k') {
        agent.setContext({ numCtx: 65536, llamaConfig: { profileName: 'large-context', contextSize: 65536, nCpuMoe: 24 } });
        renderer.printSuccess(`switched to large-context profile (64K context)`);
      } else if (pName === 'balanced') {
        agent.setContext({ numCtx: 16384, llamaConfig: { profileName: 'balanced', contextSize: 16384, nCpuMoe: 28 } });
        renderer.printSuccess(`switched to balanced profile (16K context)`);
      } else {
        renderer.printError(`unknown profile "${arg}". Choose: ultra-context, performance, large-context, balanced.`);
      }
      return true;
    }

    case '/mode': {
      const currentMode = agent.getContext().mode || 'worker';
      const architectModel = agent.getContext().architectModel || agent.getContext().model;

      if (!arg) {
        console.log(`\n  ${theme.strong('execution mode')}`);
        console.log(`  ${theme.muted('mode:')}      ${theme.accent(currentMode)}`);
        console.log(`  ${theme.muted('worker:')}    ${theme.secondary(agent.getContext().model)}`);
        console.log(`  ${theme.muted('architect:')} ${theme.secondary(architectModel)}`);
        console.log(`  ${theme.faint('switch with: /mode worker or /mode architect [model]\n')}`);
        return true;
      }

      const modeLower = arg.toLowerCase().split(' ')[0];
      const modelArg = arg.split(' ')[1];

      if (modeLower === 'architect' || modeLower === 'deep') {
        agent.setContext({
          mode: 'architect',
          ...(modelArg ? { architectModel: modelArg } : {})
        });
        renderer.printSuccess(`switched to architect mode`);
      } else if (modeLower === 'worker' || modeLower === 'fast') {
        agent.setContext({ mode: 'worker' });
        renderer.printSuccess(`switched to worker mode`);
      } else {
        renderer.printError(`unknown mode "${arg}". Choose 'worker' or 'architect'.`);
      }
      return true;
    }

    case '/auto':
    case '/yes': {
      const currentAuto = Boolean(agent.getContext().autoApprove);
      let newAuto: boolean;

      if (!arg) {
        newAuto = !currentAuto;
      } else {
        const val = arg.trim().toLowerCase();
        newAuto = val === 'on' || val === 'true' || val === '1' || val === 'yes';
      }

      agent.setContext({ autoApprove: newAuto });
      if (newAuto) {
        renderer.printSuccess(`autonomous mode active (permissionless tool execution)`);
      } else {
        renderer.printSuccess(`interactive mode active (confirmation required)`);
      }
      return true;
    }

    case '/clear': {
      await agent.clearHistory();
      renderer.printSuccess('conversation memory reset');
      return true;
    }

    case '/memory': {
      const mem = agent.getSessionMemory();
      const has = await mem.hasPreviousSession();
      if (!has) {
        console.log(`\n  ${theme.muted('no saved session memory in .locode/session.json')}\n`);
        return true;
      }
      const data = await mem.loadSession();
      if (!data) {
        console.log(`\n  ${theme.muted('session memory file is empty or invalid')}\n`);
        return true;
      }

      console.log(`\n  ${theme.strong('persisted memory')}`);
      console.log(`  ${theme.muted('updated:')}  ${theme.secondary(data.updatedAt)}`);
      console.log(`  ${theme.muted('model:')}    ${theme.secondary(data.model)}`);
      console.log(`  ${theme.muted('messages:')} ${theme.secondary(data.messages.length)}`);
      if (data.recentFiles && data.recentFiles.length > 0) {
        console.log(`  ${theme.muted('files:')}    ${theme.secondary(data.recentFiles.join(', '))}`);
      }
      if (data.lastDecisions && data.lastDecisions.length > 0) {
        console.log(`  ${theme.muted('decisions:')}`);
        for (const d of data.lastDecisions) {
          console.log(`    ${theme.bullet} ${theme.muted(d)}`);
        }
      }
      console.log();
      return true;
    }

    case '/fork': {
      try {
        const forked = await agent.forkSession(arg || undefined);
        renderer.printSuccess(`forked session into "${forked.name}" (${theme.secondary(forked.id)})`);
        console.log(`  ${theme.muted('active conversation branched. You can switch back anytime with /sessions')}\n`);
      } catch (err: any) {
        renderer.printError(`failed to fork session: ${err.message}`);
      }
      return true;
    }

    case '/sessions': {
      try {
        const sessions = await agent.listSessions();
        const activeId = agent.getSessionMemory().getActiveSessionId();

        if (sessions.length === 0) {
          console.log(`\n  ${theme.muted('no saved sessions found in .locode/sessions')}\n`);
          return true;
        }

        console.log(`\n  ${theme.diamond} ${theme.strong('Conversation Sessions')} ${theme.dim(`(${sessions.length})`)}\n`);

        for (const s of sessions) {
          const isActive = s.id === activeId;
          const marker = isActive ? theme.check : ' ';
          const nameStr = isActive ? theme.strong(s.name) : theme.secondary(s.name);
          const turnsStr = `${s.turns} turns`;
          const modelStr = theme.dim(`[${s.model}]`);
          const timeStr = theme.muted(new Date(s.updatedAt).toLocaleString());
          const forkStr = s.forkedFrom ? theme.dim(`(forked from ${s.forkedFrom})`) : '';

          console.log(`    ${marker} ${theme.accent(s.id.padEnd(20))} ${nameStr.padEnd(28)} ${theme.muted(turnsStr.padEnd(10))} ${modelStr} ${timeStr} ${forkStr}`);
        }
        console.log();

        if (process.stdin.isTTY) {
          try {
            const choices = [
              ...sessions.map(s => ({
                name: `${s.id === activeId ? '● ' : '  '}${s.name.padEnd(25)} (${s.id}, ${s.turns} turns, ${s.model})`,
                value: s.id
              })),
              { name: '✕ Close', value: '__EXIT__' }
            ];

            const chosen = await select({
              message: 'Switch active session:',
              default: activeId,
              choices
            });

            if (chosen !== '__EXIT__' && chosen !== activeId) {
              const res = await agent.switchSession(chosen);
              if (res.success) {
                renderer.printSuccess(res.message);
              } else {
                renderer.printError(res.message);
              }
            }
          } catch {
            // cancelled prompt
          }
        } else {
          console.log(`  ${theme.faint('switch session with: /session switch <id> or /resume <id>\n')}`);
        }
      } catch (err: any) {
        renderer.printError(`failed to list sessions: ${err.message}`);
      }
      return true;
    }

    case '/session': {
      const subParts = (arg || '').trim().split(/\s+/);
      const subCmd = subParts[0]?.toLowerCase();
      const subTarget = subParts.slice(1).join(' ');

      if (subCmd === 'switch' && subTarget) {
        const res = await agent.switchSession(subTarget);
        if (res.success) {
          renderer.printSuccess(res.message);
        } else {
          renderer.printError(res.message);
        }
        return true;
      } else if (subCmd === 'delete' && subTarget) {
        const ok = await agent.getSessionMemory().deleteSession(subTarget);
        if (ok) {
          renderer.printSuccess(`deleted session "${subTarget}"`);
        } else {
          renderer.printError(`could not find session "${subTarget}" to delete`);
        }
        return true;
      } else if (subCmd === 'fork') {
        const forked = await agent.forkSession(subTarget || undefined);
        renderer.printSuccess(`forked session into "${forked.name}" (${theme.secondary(forked.id)})`);
        return true;
      } else {
        return handleSlashCommand('/sessions', agent, provider, renderer, cwd);
      }
    }

    case '/resume': {
      if (arg) {
        const sessionRes = await agent.switchSession(arg);
        if (sessionRes.success) {
          renderer.printSuccess(sessionRes.message);
          return true;
        }
      }

      renderer.startSpinner('inspecting execution journal and workspace integrity...');
      const report = await agent.resumeTask();
      renderer.stopSpinner();
      if (!report.hasJournal) {
        console.log(`\n  ${theme.muted('no durable execution journal found in .locode/journal')}\n`);
      } else if (report.canSafelyResume) {
        console.log(`\n  ${theme.diamond} ${theme.strong('Durable Journal Resume')}\n`);
        console.log(`    ${theme.muted('task'.padEnd(14))} ${theme.secondary(report.snapshot?.objective || 'unspecified')}`);
        console.log(`    ${theme.muted('status'.padEnd(14))} ${theme.check} ${theme.success('resumed safely')}`);
        if (report.reconciledTools.length > 0) {
          console.log(`    ${theme.muted('reconciled'.padEnd(14))} ${theme.accent(`${report.reconciledTools.length} tool calls`)}`);
        }
        if (report.lastVerification) {
          console.log(`    ${theme.muted('verification'.padEnd(14))} ${report.lastVerification.isValid ? theme.check + ' ' + theme.success(report.lastVerification.status) : theme.cross + ' ' + theme.error(report.lastVerification.status + ' (' + report.lastVerification.invalidationReason + ')')}`);
        }
        console.log();
      } else {
        console.log(`\n  ${theme.diamond} ${theme.strong('Journal Recovery Blocked')}\n`);
        console.log(`    ${theme.muted('reason'.padEnd(14))} ${theme.error(report.reason || 'Uncertain state detected')}`);
        if (report.divergences.length > 0) {
          console.log(`    ${theme.muted('divergences:')}`);
          for (const d of report.divergences) {
            console.log(`      ${theme.bullet} ${theme.error(d)}`);
          }
        }
        if (report.reconciledTools.length > 0) {
          console.log(`    ${theme.muted('uncertain tools:')}`);
          for (const t of report.reconciledTools) {
            console.log(`      ${theme.bullet} ${theme.secondary(t.toolName)}: ${theme.muted(t.details)}`);
          }
        }
        console.log();
      }
      return true;
    }

    case '/journal': {
      const journalDir = path.join(cwd, '.locode', 'journal');
      const recoveryManager = new JournalRecoveryManager(cwd, journalDir);
      renderer.startSpinner('reading durable execution journal...');
      const report = await recoveryManager.inspectWorkspaceAndJournal();
      renderer.stopSpinner();

      if (!report.hasJournal) {
        console.log(`\n  ${theme.muted('no durable execution journal found in .locode/journal')}\n`);
        return true;
      }

      console.log(`\n  ${theme.diamond} ${theme.strong('Durable Execution Journal')}\n`);
      console.log(`    ${theme.muted('session id'.padEnd(16))} ${theme.secondary(report.sessionId || 'n/a')}`);
      console.log(`    ${theme.muted('task id'.padEnd(16))} ${theme.secondary(report.taskId || 'n/a')}`);
      console.log(`    ${theme.muted('task state'.padEnd(16))} ${theme.secondary(report.taskState || 'unknown')}`);
      console.log(`    ${theme.muted('objective'.padEnd(16))} ${theme.secondary(report.snapshot?.objective || 'none')}`);
      console.log(`    ${theme.muted('safe to resume'.padEnd(16))} ${report.canSafelyResume ? theme.check + ' ' + theme.success('yes') : theme.cross + ' ' + theme.error('no')}`);
      if (report.reason) {
        console.log(`    ${theme.muted('resume note'.padEnd(16))} ${theme.muted(report.reason)}`);
      }
      if (report.snapshot) {
        console.log(`    ${theme.muted('last sequence'.padEnd(16))} ${theme.secondary(String(report.snapshot.lastSeq))}`);
        console.log(`    ${theme.muted('recorded tools'.padEnd(16))} ${theme.secondary(String(Object.keys(report.snapshot.toolCalls).length))}`);
        console.log(`    ${theme.muted('tracked files'.padEnd(16))} ${theme.secondary(String(Object.keys(report.snapshot.fileHashes).length))}`);
      }
      if (report.lastVerification) {
        console.log(`    ${theme.muted('last verify'.padEnd(16))} ${theme.code(report.lastVerification.command)} -> ${report.lastVerification.status} (valid: ${report.lastVerification.isValid})`);
      }
      if (report.reconciledTools.length > 0) {
        console.log(`\n    ${theme.muted('tool reconciliations:')}`);
        for (const t of report.reconciledTools) {
          console.log(`      ${theme.bullet} ${theme.secondary(t.toolName)} (${t.toolCallId}): ${theme.muted(t.resolution)} - ${t.details}`);
        }
      }
      console.log();
      return true;
    }

    case '/theme':
    case '/palette': {
      const themes = getAvailableThemes();
      const current = getActiveTheme();

      if (arg) {
        const ok = setActiveTheme(arg);
        if (ok) {
          renderer.printSuccess(`switched theme to ${theme.accent(arg)}`);
        } else {
          renderer.printError(`unknown theme "${arg}". Choose: ${themes.map(t => t.name).join(', ')}`);
        }
        return true;
      }

      if (process.stdin.isTTY) {
        try {
          const chosen = await select({
            message: 'Select a UI Color Palette:',
            default: current.name,
            choices: themes.map(t => ({
              name: `${t.name.padEnd(12)} - ${t.label}`,
              value: t.name
            }))
          });
          setActiveTheme(chosen);
          renderer.printSuccess(`active theme is now ${theme.accent(chosen)}`);
        } catch {}
        return true;
      }

      console.log(`\n  ${theme.diamond} ${theme.strong('UI Themes')}\n`);
      console.log(`    ${theme.muted('active:')} ${theme.accent(current.name)} ${theme.dim(`(${current.label})`)}\n`);
      for (const t of themes) {
        const isAct = t.name === current.name;
        console.log(`    ${isAct ? theme.check : ' '} ${isAct ? theme.strong(t.name.padEnd(14)) : theme.secondary(t.name.padEnd(14))} ${theme.muted(t.label)}`);
      }
      console.log(`\n  ${theme.faint('switch with: /theme <name>\n')}`);
      return true;
    }

    case '/find':
    case '/browse': {
      try {
        const query = arg.trim();
        const files = await listWorkspaceFiles(cwd, query);
        if (files.length === 0) {
          console.log(`\n  ${theme.muted(query ? `no files matching "${query}" found` : 'no files found in workspace')}\n`);
          return true;
        }

        if (!process.stdin.isTTY) {
          console.log(`\n  ${theme.diamond} ${theme.strong('Workspace Files')} ${theme.dim(`(${files.length})`)}\n`);
          for (const f of files.slice(0, 30)) {
            console.log(`    ${theme.bullet} ${theme.secondary(f)}`);
          }
          if (files.length > 30) {
            console.log(`    ${theme.faint(`... and ${files.length - 30} more files`)}`);
          }
          console.log();
          return true;
        }

        const chosenFile = await select({
          message: `Select a file (${files.length} found):`,
          choices: [
            ...files.slice(0, 50).map(f => ({ name: f, value: f })),
            { name: '✕ Cancel', value: '__CANCEL__' }
          ]
        });

        if (chosenFile === '__CANCEL__') return true;

        const action = await select({
          message: `Action for ${chosenFile}:`,
          choices: [
            { name: '📖 Read & display file', value: 'read' },
            { name: '📝 Inspect git diff', value: 'diff' },
            { name: '✕ Done', value: 'done' }
          ]
        });

        if (action === 'diff') {
          await showDiffTUI(cwd, chosenFile, renderer);
        } else if (action === 'read') {
          const fullPath = path.resolve(cwd, chosenFile);
          const content = await fs.readFile(fullPath, 'utf8');
          const lines = content.split('\n');
          console.log(`\n  ${theme.diamond} ${theme.strong(chosenFile)} ${theme.dim(`(${lines.length} lines)`)}\n`);
          const maxPreview = Math.min(60, lines.length);
          for (let i = 0; i < maxPreview; i++) {
            console.log(`    ${theme.gutter(i + 1, 4)}${lines[i]}`);
          }
          if (lines.length > maxPreview) {
            console.log(`    ${theme.faint(`... [${lines.length - maxPreview} more lines omitted]`)}`);
          }
          console.log();
        }
      } catch (err: any) {
        renderer.printError(`failed to search files: ${err.message}`);
      }
      return true;
    }

    case '/':
    case '/menu': {
      if (!process.stdin.isTTY) {
        return handleSlashCommand('/help', agent, provider, renderer, cwd);
      }

      const choices = [
        // Workspace & Git
        { name: '📁 /diff [file]        Inspect colored diff and pending modifications', value: '/diff' },
        { name: '📁 /commit [msg]       Stage and commit workspace changes with git', value: '/commit' },
        { name: '📁 /verify [cmd]       Run linter & automated test suite', value: '/verify' },
        { name: '📁 /undo               Rollback workspace to checkpoint before last turn', value: '/undo' },
        // Sessions & Memory
        { name: '🌿 /fork [name]        Fork conversation into an independent session branch', value: '/fork' },
        { name: '🌿 /sessions           List and switch between saved conversation sessions', value: '/sessions' },
        { name: '🌿 /resume             Resume interrupted task from durable execution journal', value: '/resume' },
        { name: '🌿 /memory             View persisted project session memory', value: '/memory' },
        { name: '🌿 /clear              Reset conversation memory', value: '/clear' },
        // Model & Settings
        { name: '🤖 /model              Switch active LLM model on the fly', value: '/model' },
        { name: '🤖 /provider           Switch active provider (gemini, anthropic, llamacpp...)', value: '/provider' },
        { name: '🤖 /key                Configure API key with auto-detection', value: '/key' },
        { name: '🤖 /theme              Switch UI color palette (terracotta, nord, monokai...)', value: '/theme' },
        { name: '🤖 /context            Switch context window size (16k, 32k, 64k, 262k)', value: '/context' },
        { name: '🤖 /profile            Switch inference profile (ultra-context, performance...)', value: '/profile' },
        { name: '🤖 /mode               Toggle worker vs architect lane', value: '/mode' },
        { name: '🤖 /auto               Toggle autonomous zero-confirmation mode', value: '/auto' },
        // Tools & Inspection
        { name: '🔍 /find [query]       Interactive workspace file search & inspection', value: '/find' },
        { name: '🔍 /hardware           Inspect GPU, VRAM, and offload telemetry', value: '/hardware' },
        { name: '🔍 /stats              Display session token count and generation speed', value: '/stats' },
        { name: '🔍 /mcp                List connected MCP servers and external tools', value: '/mcp' },
        { name: '🔍 /tools              List registered agent tools', value: '/tools' },
        { name: '✕ Exit Menu', value: '__CANCEL__' }
      ];

      try {
        const chosen = await select({
          message: 'Locode Command Palette:',
          choices
        });
        if (chosen !== '__CANCEL__' && chosen) {
          return handleSlashCommand(chosen, agent, provider, renderer, cwd);
        }
      } catch {}
      return true;
    }

    case '/diff':
      try {
        await showDiffTUI(cwd, arg || undefined, renderer);
      } catch (err: any) {
        renderer.printError(`failed to run diff: ${err.message}`);
      }
      return true;

    case '/exit':
    case '/quit':
      console.log(`  ${theme.muted('bye')}`);
      process.exit(0);

    default:
      if (command === '/') {
        return handleSlashCommand('/menu', agent, provider, renderer, cwd);
      }
      if (command.startsWith('/')) {
        if (process.stdin.isTTY) {
          renderer.printWarning(`unknown command "${command}". Opening Command Palette...`);
          return handleSlashCommand('/menu', agent, provider, renderer, cwd);
        }
        renderer.printError(`unknown command "${command}". Type /help for options.`);
        return true;
      }
      return false;
  }
}
