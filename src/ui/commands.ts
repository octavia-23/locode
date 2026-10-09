import path from 'node:path';
import fs from 'node:fs/promises';
import { execa } from 'execa';
import { AgentLoop } from '../agent/loop.js';
import { ILLMProvider } from '../providers/types.js';
import { allTools } from '../tools/index.js';
import { TerminalRenderer } from './renderer.js';
import { HardwareDetector } from '../hardware/detector.js';
import { CodeVerifier } from '../agent/verifier.js';
import { theme } from './theme.js';

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
        ['/diff', 'Show pending workspace git modifications'],
        ['/stats', 'Display session token count and generation speed'],
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
      const avgTps = stats.totalDurationMs > 0
        ? (stats.completionTokens / (stats.totalDurationMs / 1000)).toFixed(1)
        : '0.0';
      const sec = (stats.totalDurationMs / 1000).toFixed(1);

      console.log(`\n  ${theme.diamond} ${theme.strong('Session Telemetry')}\n`);
      console.log(`    ${theme.muted('turns'.padEnd(14))} ${theme.text(String(stats.turns))}`);
      console.log(`    ${theme.muted('model calls'.padEnd(14))} ${theme.text(String(stats.modelCalls))}`);
      console.log(`    ${theme.muted('tool calls'.padEnd(14))} ${theme.text(String(stats.toolCalls))} ${theme.dim(`(${stats.successfulToolCalls} ok, ${stats.failedToolCalls} fail)`)}`);
      console.log(`    ${theme.muted('total tokens'.padEnd(14))} ${theme.text(stats.totalTokens.toLocaleString())}`);
      console.log(`    ${theme.muted('prompt tok'.padEnd(14))} ${theme.dim(stats.promptTokens.toLocaleString())}`);
      console.log(`  ${theme.muted('output tok')}   ${theme.secondary(stats.completionTokens.toLocaleString())}`);
      console.log(`  ${theme.muted('duration')}     ${theme.secondary(`${sec}s`)}`);
      console.log(`  ${theme.muted('avg speed')}    ${theme.accent(`${avgTps} tok/s`)}\n`);
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
        const available = await provider.getAvailableModels();
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

    case '/diff':
      try {
        const status = await execa('git status -s', { cwd, shell: true });
        const diff = await execa('git diff', { cwd, shell: true });
        console.log(`\n  ${theme.strong('git status')}`);
        console.log(status.stdout ? `  ${status.stdout.split('\n').join('\n  ')}` : `  ${theme.muted('clean workspace')}`);
        if (diff.stdout) {
          console.log(`\n  ${theme.strong('git diff')}`);
          console.log(theme.muted(diff.stdout));
        }
        console.log();
      } catch (err: any) {
        renderer.printError(`failed to run git diff: ${err.message}`);
      }
      return true;

    case '/exit':
    case '/quit':
      console.log(`  ${theme.muted('bye')}`);
      process.exit(0);

    default:
      if (command.startsWith('/')) {
        renderer.printError(`unknown command "${command}". Type /help for options.`);
        return true;
      }
      return false;
  }
}
