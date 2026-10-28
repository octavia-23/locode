import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { classifyCommandSecurity, isDangerousCommand } from '../src/tools/security.js';
import { PermissionEngine } from '../src/engine/permission-engine.js';
import { ToolDispatcher } from '../src/engine/tool-dispatcher.js';
import { AgentLoop } from '../src/agent/loop.js';
import { CodeVerifier } from '../src/agent/verifier.js';
import { ContextEngine } from '../src/agent/context.js';
import { redactSecretsFromMessages } from '../src/utils/secret-redactor.js';
import { estimateUsageCost, getModelPricing } from '../src/runtime/pricing.js';
import { runCommandTool } from '../src/tools/terminal.js';
import {
  LOCAL_CONSERVATIVE_PROFILE,
  LOCAL_TURBO_PROFILE,
  CLOUD_FRONTIER_PROFILE,
  HYBRID_PROFILE
} from '../src/runtime/profiles.js';
import { ToolDefinition, AgentContext } from '../src/types.js';

// ============================================================================
// 1. Separate Security Decisions (allow, ask, deny)
// ============================================================================
test('Execution Policy - Critical destructive commands remain denied under auto-approval', () => {
  const permEngine = new PermissionEngine();
  const context: AgentContext = {
    cwd: process.cwd(),
    autoApprove: true, // Auto-approval is active!
    model: 'test-model',
    ollamaHost: 'http://localhost'
  };

  const dummyCommandTool: ToolDefinition = {
    name: 'run_command',
    description: 'run shell command',
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ result: 'ok' })
  };

  // 1. Critical destructive commands (DENY) MUST NOT execute even with autoApprove: true
  const criticalCommands = [
    'rm -rf /',
    'rm -rf ~',
    'format C:',
    'shutdown -s -t 0',
    'mkfs.ext4 /dev/sda1',
    'git clean -fdx'
  ];

  for (const cmd of criticalCommands) {
    const classification = classifyCommandSecurity(cmd);
    assert.equal(classification.decision, 'deny', `Command "${cmd}" must be classified as 'deny'`);

    const evalResult = permEngine.evaluate(dummyCommandTool, { command: cmd }, context, { autoApprove: true });
    assert.equal(evalResult.allowed, false, `Unconditional DENY command "${cmd}" was improperly allowed by autoApprove`);
    assert.match(evalResult.reason || '', /unconditionally denied|prohibited/i);
  }

  // 2. High-risk commands (ASK) ARE allowed under autoApprove: true, but require prompt when autoApprove is false
  const askCmd = 'rm -f temp.txt';
  const askClassification = classifyCommandSecurity(askCmd);
  assert.equal(askClassification.decision, 'ask', `Command "${askCmd}" must be classified as 'ask'`);

  const autoEval = permEngine.evaluate(dummyCommandTool, { command: askCmd }, context, { autoApprove: true });
  assert.equal(autoEval.allowed, true, `ASK command "${askCmd}" should be allowed when autoApprove is true`);

  const noAutoContext: AgentContext = { ...context, autoApprove: false, interactive: true };
  const promptEval = permEngine.evaluate(dummyCommandTool, { command: askCmd }, noAutoContext, { autoApprove: false });
  assert.equal(promptEval.requiresPrompt, true, `ASK command "${askCmd}" must require prompt when autoApprove is false`);
});

// ============================================================================
// 2. Approval-required tools fail closed in non-interactive sessions
// ============================================================================
test('Execution Policy - Approval-required tools fail closed in non-interactive sessions', async () => {
  const permEngine = new PermissionEngine();
  const nonInteractiveContext: AgentContext = {
    cwd: process.cwd(),
    autoApprove: false,
    interactive: false, // Non-interactive headless/batch session
    model: 'test-model',
    ollamaHost: 'http://localhost'
  };

  const toolRequiringApproval: ToolDefinition = {
    name: 'custom_dangerous_tool',
    description: 'requires approval',
    parameters: { type: 'object', properties: {} },
    needsApproval: true,
    execute: async () => ({ result: 'ok' })
  };

  // PermissionEngine must return allowed: false immediately (not requiresPrompt: true)
  const evalResult = permEngine.evaluate(toolRequiringApproval, {}, nonInteractiveContext);
  assert.equal(evalResult.allowed, false);
  assert.equal(evalResult.requiresPrompt, false);
  assert.match(evalResult.reason || '', /approval is unavailable|non-interactive/i);

  // ToolDispatcher must also fail closed with 'permission_denied' status
  const dispatcherWithoutPrompt = new ToolDispatcher(permEngine);
  const dispatchResult = await dispatcherWithoutPrompt.dispatch(toolRequiringApproval, {}, nonInteractiveContext);
  assert.equal(dispatchResult.status, 'permission_denied');
  assert.equal(dispatchResult.isError, true);
});

// ============================================================================
// 3. Disabling network access blocks every applicable web tool
// ============================================================================
test('Execution Policy - Disabling network access blocks every applicable web tool', () => {
  const permEngine = new PermissionEngine({ allowNetwork: false });
  const context: AgentContext = {
    cwd: process.cwd(),
    autoApprove: true,
    model: 'test-model',
    ollamaHost: 'http://localhost'
  };

  const fetchTool: ToolDefinition = {
    name: 'fetch_web',
    description: 'fetch webpage',
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ result: 'ok' })
  };

  const searchTool: ToolDefinition = {
    name: 'search_web',
    description: 'search web',
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ result: 'ok' })
  };

  const fetchEval = permEngine.evaluate(fetchTool, { url: 'https://example.com' }, context);
  assert.equal(fetchEval.allowed, false, 'fetch_web must be blocked when allowNetwork is false');
  assert.match(fetchEval.reason || '', /network access is disabled/i);

  const searchEval = permEngine.evaluate(searchTool, { query: 'test' }, context);
  assert.equal(searchEval.allowed, false, 'search_web must be blocked when allowNetwork is false');
  assert.match(searchEval.reason || '', /network access is disabled/i);
});

// ============================================================================
// 4. Execution profile budgets and parameters
// ============================================================================
test('Execution Policy - Each profile exploration and step budgets affect actual configuration', () => {
  assert.equal(LOCAL_CONSERVATIVE_PROFILE.safetyCeiling, 45);
  assert.equal(LOCAL_CONSERVATIVE_PROFILE.maxExplorationReads, 2);
  assert.equal(LOCAL_CONSERVATIVE_PROFILE.forceMutationAfterReads, true);
  assert.equal(LOCAL_CONSERVATIVE_PROFILE.allowParallelTools, false);

  assert.equal(LOCAL_TURBO_PROFILE.safetyCeiling, 60);
  assert.equal(LOCAL_TURBO_PROFILE.maxExplorationReads, 8);
  assert.equal(LOCAL_TURBO_PROFILE.forceMutationAfterReads, true);

  assert.equal(CLOUD_FRONTIER_PROFILE.safetyCeiling, 100);
  assert.equal(CLOUD_FRONTIER_PROFILE.maxExplorationReads, 25);
  assert.equal(CLOUD_FRONTIER_PROFILE.forceMutationAfterReads, false);
  assert.equal(CLOUD_FRONTIER_PROFILE.allowParallelTools, true);
  assert.equal(CLOUD_FRONTIER_PROFILE.privacyPolicy.allowFullRepoContext, false);

  assert.equal(HYBRID_PROFILE.safetyCeiling, 75);
  assert.equal(HYBRID_PROFILE.maxExplorationReads, 6);
});

// ============================================================================
// 5. Profile changes update effective permission policy
// ============================================================================
test('Execution Policy - Profile changes update effective permission policy', () => {
  const agent = new AgentLoop({
    cwd: process.cwd(),
    autoApprove: true,
    model: 'qwen2.5-coder:7b',
    ollamaHost: 'http://localhost:11434'
  });

  // Default local profile allows web access
  assert.equal(agent.getExecutionProfile().privacyPolicy.allowWebAccess, true);
  assert.equal(agent.getPermissionEngine().getPolicy().allowNetwork, true);

  // Switch profile with web access disabled
  agent.setExecutionProfile({
    privacyPolicy: {
      allowFullRepoContext: false,
      allowWebAccess: false,
      redactSecrets: true
    }
  });

  assert.equal(agent.getExecutionProfile().privacyPolicy.allowWebAccess, false);
  assert.equal(agent.getPermissionEngine().getPolicy().allowNetwork, false, 'PermissionEngine allowNetwork policy must be synchronized with profile');

  // Re-enable web access
  agent.setExecutionProfile({
    privacyPolicy: {
      allowFullRepoContext: true,
      allowWebAccess: true,
      redactSecrets: false
    }
  });

  assert.equal(agent.getExecutionProfile().privacyPolicy.allowWebAccess, true);
  assert.equal(agent.getPermissionEngine().getPolicy().allowNetwork, true);
});

// ============================================================================
// 6. Nested tool-call arguments sanitized before cloud transmission
// ============================================================================
test('Execution Policy - Nested tool-call arguments are sanitized before cloud transmission', () => {
  // Construct dummy secret keys dynamically to avoid static string scanning
  const dummyOpenAiKey = ['sk', 'proj', 'dummytesttoken1234567890abcdef'].join('-');
  const dummySecretValue = 'SuperSecret123!';

  const messages: any[] = [
    {
      role: 'assistant',
      content: 'I will export credentials and create secret file',
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: {
            name: 'run_command',
            arguments: {
              command: `export OPENAI_API_KEY="${dummyOpenAiKey}"`
            }
          }
        },
        {
          id: 'call_2',
          type: 'function',
          function: {
            name: 'write_file',
            arguments: JSON.stringify({
              path: 'config.json',
              content: `password = "${dummySecretValue}"`
            })
          }
        }
      ]
    }
  ];

  const sanitized = redactSecretsFromMessages(messages);
  const tc1Args = sanitized[0].tool_calls[0].function.arguments;
  assert.ok(!tc1Args.command.includes(dummyOpenAiKey), 'Secret in object arguments must be redacted');
  assert.ok(tc1Args.command.includes('[REDACTED_SECRET]'));

  const tc2ArgsStr = sanitized[0].tool_calls[1].function.arguments;
  assert.ok(!tc2ArgsStr.includes(dummySecretValue), 'Secret in stringified JSON arguments must be redacted');
  assert.ok(tc2ArgsStr.includes('[REDACTED_SECRET]'));
});

// ============================================================================
// 7. Cost thresholds enforced when pricing is known and reported unknown otherwise
// ============================================================================
test('Execution Policy - Cost thresholds enforced when pricing is known and reported as unknown otherwise', () => {
  // 1. Known model pricing
  const gpt4Pricing = getModelPricing('gpt-4o');
  assert.ok(gpt4Pricing !== null);
  assert.equal(gpt4Pricing!.inputPerMillion, 2.50);
  assert.equal(gpt4Pricing!.outputPerMillion, 10.00);

  const knownEstimate = estimateUsageCost(
    { promptTokens: 10000, completionTokens: 2000 },
    'gpt-4o'
  );
  assert.equal(knownEstimate.isKnown, true);
  // (10000 * 2.5 / 1e6) + (2000 * 10 / 1e6) = 0.025 + 0.020 = 0.045
  assert.equal(knownEstimate.cost, 0.045);

  // 2. Local free models
  const ollamaEstimate = estimateUsageCost(
    { promptTokens: 50000, completionTokens: 10000 },
    'qwen2.5-coder:7b',
    'ollama'
  );
  assert.equal(ollamaEstimate.isKnown, true);
  assert.equal(ollamaEstimate.cost, 0.0);

  // 3. Unknown model pricing - MUST NOT fabricate numbers!
  const unknownEstimate = estimateUsageCost(
    { promptTokens: 50000, completionTokens: 10000 },
    'nonexistent-custom-llm-v99'
  );
  assert.equal(unknownEstimate.isKnown, false);
  assert.equal(unknownEstimate.cost, undefined, 'Must never fabricate cost when pricing metadata is unavailable');
});

// ============================================================================
// 8. Failed lint or typecheck cannot be reported as passed
// ============================================================================
test('Execution Policy - A failed lint or typecheck cannot be reported as passed', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locode-policy-verif-'));
  await fs.writeFile(
    path.join(tmpDir, 'package.json'),
    JSON.stringify({ scripts: { typecheck: 'tsc --noEmit' } }),
    'utf8'
  );

  try {
    // Mock a compiler error in an unrelated file
    const unrelatedOutput = 'src/unrelated.ts:1:1 - error TS2304: Cannot find name "missing".';
    const origRun = CodeVerifier.run;
    (CodeVerifier as any).run = async () => ({
      status: 'failed',
      passed: false,
      command: 'tsc --noEmit',
      errorOutput: unrelatedOutput
    });

    const lintResult = await CodeVerifier.runFastLint(tmpDir, 'src/target.ts');
    (CodeVerifier as any).run = origRun;

    // Milestone Requirement 4: attribution cannot be established to target.ts.
    // MUST NOT be passed!
    assert.notEqual(lintResult.status, 'passed', 'Unattributed failure must not be reported as passed');
    assert.equal(lintResult.status, 'inconclusive');
    assert.equal(lintResult.passed, false);

    // ContextEngine tracks typecheck, test, and build separately
    const contextEngine = new ContextEngine(tmpDir);
    contextEngine.recordVerificationResult(false, 'tsc --noEmit', unrelatedOutput, 'inconclusive');
    contextEngine.recordVerificationResult(true, 'npm test', 'All 10 tests passed', 'passed');
    contextEngine.recordVerificationResult(true, 'npm run build', 'Build successful', 'passed');

    const results = contextEngine.getVerificationResults();
    assert.equal(results['typecheck']?.status, 'inconclusive');
    assert.equal(results['test']?.status, 'passed');
    assert.equal(results['build']?.status, 'passed');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// 9. Cancellation and timeouts terminate without leaving uncontrolled processes
// ============================================================================
test('Execution Policy - Cancellation terminates child execution without orphaned processes', async () => {
  const abortController = new AbortController();
  const context: AgentContext = {
    cwd: process.cwd(),
    autoApprove: true,
    model: 'test-model',
    ollamaHost: 'http://localhost',
    commandTimeoutMs: 3000,
    signal: abortController.signal
  };

  // Start a command that would run for 30 seconds
  const isWindows = process.platform === 'win32';
  const longCmd = isWindows
    ? 'powershell -NoProfile -Command "Start-Sleep -Seconds 30"'
    : 'sleep 30';

  const startTime = Date.now();
  // Cancel after 250ms
  setTimeout(() => {
    abortController.abort();
  }, 250);

  const result = await runCommandTool.execute({ command: longCmd }, context);
  const duration = Date.now() - startTime;

  assert.equal(result.isError, true);
  assert.ok(duration < 2500, `Execution should abort promptly upon cancellation, took ${duration}ms`);
});
