import path from 'node:path';
import fs from 'node:fs/promises';
import chalk from 'chalk';
import { execa } from 'execa';
import { AgentLoop } from '../agent/loop.js';
import { ILLMProvider } from '../providers/types.js';
import { allTools } from '../tools/index.js';
import { TerminalRenderer } from './renderer.js';
import { HardwareDetector } from '../hardware/detector.js';
import { CodeVerifier } from '../agent/verifier.js';

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
      console.log(`  ${chalk.yellow('/verify [cmd]')}   - 🧪 Run background typecheck & test suite to verify code health`);
      console.log(`  ${chalk.yellow('/commit [msg]')}  - 🤖 Auto-generate or apply a git commit for current changes`);
      console.log(`  ${chalk.yellow('/hardware')}      - ⚡ Inspect GPU, VRAM allocation, and layer offload stats`);
      console.log(`  ${chalk.yellow('/mcp')}           - 🔌 List connected Model Context Protocol (MCP) servers & tools`);
      console.log(`  ${chalk.yellow('/diff')}          - 📝 Show git status and pending changes in workspace`);
      console.log(`  ${chalk.yellow('/stats')}         - 📊 Display session token metrics and speed`);
      console.log(`  ${chalk.yellow('/model [name]')}  - 🔄 View current model or switch on the fly`);
      console.log(`  ${chalk.yellow('/context [size]')} - 📏 Switch context window (e.g. 32k, 64k, 16k)`);
      console.log(`  ${chalk.yellow('/profile [name]')} - ⚙️ Switch inference profile (performance, large-context, balanced)`);
      console.log(`  ${chalk.yellow('/mode [type]')}   - 🔀 Toggle execution mode ('worker' fast lane vs 'architect' deep lane)`);
      console.log(`  ${chalk.yellow('/auto')}          - 🚀 Toggle Autonomous Mode (run all tools without asking for permission)`);
      console.log(`  ${chalk.yellow('/clear')}         - 🧹 Clear conversation memory and reset context`);

      console.log(`  ${chalk.yellow('/file [path]')}   - 📄 Load and run prompt from a text/markdown file`);
      console.log(`  ${chalk.yellow('/tools')}         - 🛠️ List all registered agent tools`);
      console.log(`  ${chalk.yellow('/exit')}          - 🚪 Exit Locode CLI\n`);
      return true;

    case '/f':
    case '/file': {
      if (!arg) {
        console.log(chalk.yellow('Usage: /file <path-to-prompt.txt>'));
        return true;
      }
      try {
        const filePath = path.resolve(cwd, arg);
        const content = (await fs.readFile(filePath, 'utf8')).trim();
        console.log(chalk.bold.green(`Task loaded from ${arg} (${content.length} chars)\n`));
        await agent.run(content);
      } catch (err: any) {
        console.log(chalk.red(`Failed to read prompt file: ${err.message}`));
      }
      return true;
    }



    case '/mcp': {
      const mcp = agent.getMCPManager();
      const servers = mcp.getActiveServers();
      const tools = mcp.getLoadedTools();

      console.log(`\n${chalk.bold.cyan('🔌 Model Context Protocol (MCP) Integration:')}`);
      if (servers.length === 0) {
        console.log(chalk.gray('  No active MCP servers connected.'));
        console.log(chalk.dim('  Create a .mcp.json file in your project to connect servers (e.g. SQLite, GitHub, Fetch).\n'));
      } else {
        console.log(chalk.green(`  Active Servers (${servers.length}): ${servers.join(', ')}`));
        console.log(`  Loaded MCP Tools (${tools.length}):`);
        for (const t of tools) {
          console.log(`    • ${chalk.yellow(t.name)}: ${chalk.gray(t.description)}`);
        }
        console.log();
      }
      return true;
    }

    case '/hardware': {

      const hw = await HardwareDetector.getProfile();
      const ctx = agent.getContext();
      const activeCtx = ctx.numCtx || hw.recommendedCtx;

      console.log(`\n${chalk.bold.cyan('⚡ Hardware & Inference Architecture (Truthful Telemetry):')}`);
      console.log(`  • Compute Device:       ${chalk.white.bold(hw.deviceName)} [${chalk.magenta(hw.type.toUpperCase())}] (Detected)`);
      if (hw.totalVramMb > 0) {
        const usedVram = Math.max(0, hw.totalVramMb - hw.freeVramMb);
        console.log(`  • Dedicated VRAM:       ${chalk.yellow(`${hw.totalVramMb} MB`)} (Free: ${chalk.green(`${hw.freeVramMb} MB`)}, In-use: ${chalk.gray(`${usedVram} MB`)}) (Detected)`);
      }
      console.log(`  • System Memory:        ${chalk.yellow(`${hw.totalRamMb} MB`)} (Free: ${chalk.green(`${hw.freeRamMb} MB`)}) (Detected)`);
      console.log(`  • Inference Backend:    ${chalk.cyan(hw.backend)} (Configured)`);
      console.log(`  • Selected Model:       ${chalk.cyan(ctx.model)} (Runtime Selected)`);
      console.log(`  • Context Window:       ${chalk.cyan(activeCtx.toLocaleString())} tokens (Tuned: ${hw.recommendedCtx.toLocaleString()})`);

      const offloadStatus = hw.measuredGpuOffloadVerified
        ? chalk.green.bold('✔ Measured 100% GPU Offload (Verified via runtime telemetry)')
        : (hw.estimatedFullOffload7B
          ? chalk.blue.bold('ℹ Recommended Full GPU Offload (Heuristic memory budget calculation)')
          : chalk.yellow.bold('⚠ Hybrid Offload (Layers likely split across GPU & CPU)'));
      console.log(`  • Offload Status:       ${offloadStatus}`);
      console.log(`  • KV Cache Target:      ${chalk.gray(hw.recommendedKvCache)} (Recommended heuristic, runtime enforcement: ${hw.isKvCacheRuntimeEnforced ? 'active' : 'unsupported without custom Modelfile'})`);

      if (hw.notes.length > 0) {
        console.log(`\n${chalk.bold('Architecture Notes:')}`);
        for (const note of hw.notes) {
          console.log(`  ${chalk.dim('→')} ${chalk.gray(note)}`);
        }
      }
      console.log();
      return true;
    }

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

    case '/verify': {
      renderer.startSpinner('Detecting and running workspace health check...');
      const vResult = await CodeVerifier.run(cwd, arg || undefined);
      renderer.stopSpinner();

      if (!vResult.command) {
        console.log(chalk.gray('\nNo automated test or typecheck suite detected in current workspace.\n'));
        return true;
      }

      console.log(`\n${chalk.bold.cyan('🧪 Workspace Health & Verification Report:')}`);
      console.log(`  • Tool/Command: ${chalk.yellow(vResult.command)}`);
      if (vResult.passed) {
        console.log(`  • Status:       ${chalk.green.bold('✔ PASSED (0 errors, build clean)')}\n`);
      } else {
        console.log(`  • Status:       ${chalk.red.bold('✖ FAILED')}`);
        console.log(chalk.red(`\n${vResult.errorOutput}\n`));
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

      console.log(`\n${chalk.bold.cyan('📊 Locode Session Statistics & Context Efficiency:')}`);
      console.log(`  • User turns:          ${chalk.yellow(stats.turns)}`);
      console.log(`  • Model calls:         ${chalk.yellow(stats.modelCalls)}`);
      console.log(`  • Tool executions:     ${chalk.cyan(stats.toolCalls)} (${chalk.green(`${stats.successfulToolCalls} ok`)}, ${chalk.red(`${stats.failedToolCalls} fail`)})`);
      console.log(`  • Empty recoveries:    ${chalk.yellow(stats.recoveries)} (out of ${stats.emptyGenerations} empty gens)`);
      if (stats.progressLoopsDetected > 0) {
        console.log(`  • Progress loop traps: ${chalk.magenta(stats.progressLoopsDetected)}`);
      }
      if (stats.verificationRuns > 0) {
        console.log(`  • Verification runs:   ${chalk.green(stats.verificationRuns)}`);
      }
      console.log(`  • Total tokens:        ${chalk.yellow(stats.totalTokens.toLocaleString())}`);
      console.log(`  • Prompt tokens:       ${chalk.gray(stats.promptTokens.toLocaleString())}`);
      console.log(`  • Generated tokens:    ${chalk.green(stats.completionTokens.toLocaleString())}`);
      console.log(`  • Compressed tokens:   ${chalk.greenBright(`+${stats.tokensSavedByCompression.toLocaleString()} saved`)}`);
      console.log(`  • Avoided dedupe:      ${chalk.cyanBright(`+${stats.tokensAvoidedByDeduplication.toLocaleString()} saved`)}`);
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

    case '/context':
    case '/ctx': {
      const currentCtx = agent.getContext().numCtx || 262144;
      if (!arg) {
        console.log(`\n${chalk.bold.cyan('📏 Active Context Window:')} ${chalk.yellow(currentCtx.toLocaleString())} tokens`);
        console.log(chalk.gray(`  Switch context window on the fly:`));
        console.log(`  • ${chalk.yellow('/context 8k')}   (8,192 tokens)`);
        console.log(`  • ${chalk.yellow('/context 16k')}  (16,384 tokens)`);
        console.log(`  • ${chalk.yellow('/context 32k')}  (32,768 tokens - Peak Speed Benchmark Profile)`);
        console.log(`  • ${chalk.yellow('/context 64k')}  (65,536 tokens - Extended Context Profile)`);
        console.log(`  • ${chalk.yellow('/context 128k')} (131,072 tokens - TurboQuant 128K Profile)`);
        console.log(`  • ${chalk.yellow('/context 192k')} (196,608 tokens - TurboQuant 192K Profile)`);
        console.log(`  • ${chalk.yellow('/context 262k')} (262,144 tokens - Ultra-Context 262K Proven Profile)\n`);
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
        renderer.printError(`Invalid context size "${arg}". Choose 8k, 16k, 32k, 64k, 128k, 192k, or 262k.`);
        return true;
      }

      agent.setContext({ numCtx: parsed });
      renderer.printSuccess(`Context window switched to ${chalk.cyan(parsed.toLocaleString())} tokens.`);
      return true;
    }

    case '/profile': {
      const ctx = agent.getContext();
      const currentProfile = (ctx.llamaConfig as any)?.profileName || 'ultra-context';
      if (!arg) {
        console.log(`\n${chalk.bold.cyan('⚙️ Inference Profiles:')}`);
        console.log(`  Active: ${chalk.green.bold(currentProfile)}`);
        console.log(`  Available:`);
        console.log(`  • ${chalk.yellow('ultra-context')} - 262K context, MoE 34, Turbo4 K / Turbo3 V (Proven 262K Baseline on RTX 4050 6GB)`);
        console.log(`  • ${chalk.yellow('performance')}   - 32K context, MoE 24, Turbo4 KV (Peak Speed 35 tok/s)`);
        console.log(`  • ${chalk.yellow('large-context')} - 64K context, MoE 24, Turbo4 KV (Extended long-range)`);
        console.log(`  • ${chalk.yellow('balanced')}      - 16K context, MoE 28, safer RAM/VRAM footprint`);
        console.log(chalk.dim(`\nSwitch with: /profile <name>\n`));
        return true;
      }

      const pName = arg.trim().toLowerCase();
      if (pName === 'ultra-context' || pName === '262k') {
        agent.setContext({ numCtx: 262144, llamaConfig: { profileName: 'ultra-context', contextSize: 262144, nCpuMoe: 34 } });
        renderer.printSuccess(`Switched to Ultra-Context profile (262K context, Turbo4 K / Turbo3 V, 34 MoE layers).`);
      } else if (pName === 'performance') {
        agent.setContext({ numCtx: 32768, llamaConfig: { profileName: 'performance', contextSize: 32768, nCpuMoe: 24 } });
        renderer.printSuccess(`Switched to Performance profile (32K context, Turbo4 KV, 24 MoE layers).`);
      } else if (pName === 'large-context' || pName === '64k') {
        agent.setContext({ numCtx: 65536, llamaConfig: { profileName: 'large-context', contextSize: 65536, nCpuMoe: 24 } });
        renderer.printSuccess(`Switched to Large Context profile (64K context, Turbo4 KV).`);
      } else if (pName === 'balanced') {
        agent.setContext({ numCtx: 16384, llamaConfig: { profileName: 'balanced', contextSize: 16384, nCpuMoe: 28 } });
        renderer.printSuccess(`Switched to Balanced profile (16K context, 28 MoE layers).`);
      } else {
        renderer.printError(`Unknown profile "${arg}". Available: ultra-context, performance, large-context, balanced.`);
      }
      return true;
    }

    case '/mode': {
      const currentMode = agent.getContext().mode || 'worker';
      const architectModel = agent.getContext().architectModel || agent.getContext().model;

      if (!arg) {
        console.log(`\n${chalk.bold.cyan('🔀 Agent Execution Mode:')}`);
        console.log(`  • Active Mode:      ${currentMode === 'architect' ? chalk.magenta.bold('🏛️ ARCHITECT (Deep Reasoning & Contract Planning)') : chalk.green.bold('⚡ WORKER (Fast Lane @ ~50 tok/s)')}`);
        console.log(`  • Worker Model:     ${chalk.cyan(agent.getContext().model)}`);
        console.log(`  • Architect Model:  ${chalk.magenta(architectModel)}`);
        console.log(chalk.gray(`\n  Switch with: ${chalk.yellow('/mode worker')} or ${chalk.yellow('/mode architect [optional-model]')}\n`));
        return true;
      }

      const modeLower = arg.toLowerCase().split(' ')[0];
      const modelArg = arg.split(' ')[1];

      if (modeLower === 'architect' || modeLower === 'deep') {
        agent.setContext({
          mode: 'architect',
          ...(modelArg ? { architectModel: modelArg } : {})
        });
        renderer.printSuccess(`Switched to Architect Mode (Deep structural planning active).`);
      } else if (modeLower === 'worker' || modeLower === 'fast') {
        agent.setContext({ mode: 'worker' });
        renderer.printSuccess(`Switched to Worker Mode (Fast lane active @ ~50 tok/s).`);
      } else {
        renderer.printError(`Unknown mode "${arg}". Choose 'worker' or 'architect'.`);
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
        renderer.printSuccess(`Autonomous Mode ${chalk.bold.yellow('ACTIVATED')}: Locode will execute all tools without asking for permission.`);
      } else {
        renderer.printSuccess(`Interactive Mode ${chalk.bold.green('ACTIVATED')}: Locode will ask for permission before editing files or running commands.`);
      }
      return true;
    }

    case '/clear': {
      await agent.clearHistory();
      renderer.printSuccess('Conversation context & saved session memory reset.');
      return true;
    }

    case '/memory': {
      const mem = agent.getSessionMemory();
      const has = await mem.hasPreviousSession();
      if (!has) {
        console.log(chalk.gray('\nNo persisted session memory saved yet in .locode/session.json.\n'));
        return true;
      }
      const data = await mem.loadSession();
      if (!data) {
        console.log(chalk.gray('\nSession memory file is empty or invalid.\n'));
        return true;
      }

      console.log(`\n${chalk.bold.cyan('🧠 Persisted Session Memory (.locode/session.json):')}`);
      console.log(`  • Last updated:   ${chalk.yellow(data.updatedAt)}`);
      console.log(`  • Model:          ${chalk.green(data.model)}`);
      console.log(`  • Saved messages: ${chalk.white(data.messages.length)}`);
      if (data.recentFiles && data.recentFiles.length > 0) {
        console.log(`  • Tracked files:  ${chalk.cyan(data.recentFiles.join(', '))}`);
      }
      if (data.lastDecisions && data.lastDecisions.length > 0) {
        console.log(`  • Decisions:`);
        for (const d of data.lastDecisions) {
          console.log(`    - ${chalk.gray(d)}`);
        }
      }
      console.log(chalk.dim('\n  Use /clear to purge persisted memory.\n'));
      return true;
    }


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
