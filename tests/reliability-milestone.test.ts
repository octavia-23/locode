import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { resolveSafePath, isSsrfSafeUrl, validateSsrfSafeUrl } from '../src/tools/security.js';
import { PermissionEngine } from '../src/engine/permission-engine.js';
import { ToolDispatcher } from '../src/engine/tool-dispatcher.js';
import { MCPManager } from '../src/mcp/manager.js';
import { allTools, toolRegistry, registerDynamicTool, unregisterDynamicTool, unregisterDynamicTools } from '../src/tools/index.js';
import { createLLMProvider } from '../src/providers/factory.js';
import { redactSecrets } from '../src/utils/secret-redactor.js';
import { fetchWebTool } from '../src/tools/web.js';
import { CodeVerifier } from '../src/agent/verifier.js';
import { ContextEngine } from '../src/agent/context.js';
import { LlamaCppRuntime } from '../src/runtime/manager.js';
import { RecoveryController } from '../src/engine/recovery-controller.js';
import { ToolDefinition, AgentContext } from '../src/types.js';

// ============================================================================
// 1. Filesystem Containment: Symlinks & Outside Writes
// ============================================================================
test('Milestone 1 - Filesystem Containment: blocks directory symlinks / junctions pointing outside workspace', async () => {
  const tmpWs = fsp.mkdtemp(path.join(os.tmpdir(), 'locode-ws-'));
  const tmpOutside = fsp.mkdtemp(path.join(os.tmpdir(), 'locode-outside-'));
  const [ws, outside] = await Promise.all([tmpWs, tmpOutside]);

  try {
    const secretFile = path.join(outside, 'secret.txt');
    await fsp.writeFile(secretFile, 'super-secret', 'utf8');

    // Create a junction / directory symlink inside ws pointing to outside
    const linkDir = path.join(ws, 'linked-outside');
    fs.symlinkSync(outside, linkDir, 'junction');

    // Attempt to access outside secret through directory symlink
    assert.throws(
      () => resolveSafePath(path.join('linked-outside', 'secret.txt'), ws),
      /Security Violation.*outside the allowed workspace/i
    );

    // Attempt to write non-existent file inside directory symlink
    assert.throws(
      () => resolveSafePath(path.join('linked-outside', 'newfile.txt'), ws),
      /Security Violation.*outside the allowed workspace/i
    );
  } finally {
    await Promise.all([
      fsp.rm(ws, { recursive: true, force: true }),
      fsp.rm(outside, { recursive: true, force: true })
    ]);
  }
});

test('Milestone 1 - Filesystem Containment: PermissionEngine checks all paths in multi-path arguments', () => {
  const ws = path.resolve('test-ws');
  const permEngine = new PermissionEngine({ allowOutsideWorkspace: false });

  const dummyTool: ToolDefinition = {
    name: 'batch_read_files',
    description: 'batch read',
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ result: 'ok' })
  };

  const context: AgentContext = {
    cwd: ws,
    autoApprove: true,
    model: 'test',
    ollamaHost: 'http://localhost'
  };

  // args.paths has a safe first file, but unsafe second file
  const evaluation = permEngine.evaluate(
    dummyTool,
    { paths: ['safe.txt', '../../outside.txt'] },
    context
  );

  assert.equal(evaluation.allowed, false, 'Multi-path tool with unsafe second path must be blocked');
  assert.match(evaluation.reason || '', /Security Violation|containment/i);
});

// ============================================================================
// 2. Permission Engine: Fails closed when approval is required but unavailable
// ============================================================================
test('Milestone 2 - Fail Closed: ToolDispatcher blocks execution if approval is required but promptHandler is missing', async () => {
  const permEngine = new PermissionEngine({ autoApprove: false });
  // Dispatcher initialized WITHOUT PromptHandler
  const dispatcher = new ToolDispatcher(permEngine);

  const mutatingTool: ToolDefinition = {
    name: 'write_file',
    description: 'write file',
    parameters: { type: 'object', properties: {} },
    needsApproval: true,
    execute: async () => ({ result: 'Executed write_file' })
  };

  const context: AgentContext = {
    cwd: process.cwd(),
    autoApprove: false,
    model: 'test',
    ollamaHost: 'http://localhost'
  };

  const result = await dispatcher.dispatch(mutatingTool, { path: 'test.txt', content: 'test' }, context);

  assert.equal(result.status, 'permission_denied');
  assert.equal(result.isError, true);
  assert.match(result.output, /Permission Denied.*requires.*approval.*unavailable/i);
});

test('Milestone 2 - Fail Closed: PermissionEngine blocks when approval is required but interactive context is false', () => {
  const permEngine = new PermissionEngine({ autoApprove: false });
  const mutatingTool: ToolDefinition = {
    name: 'write_file',
    description: 'write file',
    parameters: { type: 'object', properties: {} },
    needsApproval: true,
    execute: async () => ({ result: 'Executed write_file' })
  };

  const context: AgentContext = {
    cwd: process.cwd(),
    autoApprove: false,
    interactive: false, // Headless/non-interactive
    model: 'test',
    ollamaHost: 'http://localhost'
  };

  const evaluation = permEngine.evaluate(mutatingTool, { path: 'test.txt' }, context);
  assert.equal(evaluation.allowed, false);
  assert.match(evaluation.reason || '', /Permission Denied.*requires.*approval/i);
});

// ============================================================================
// 3. MCP Explicit Trust & Session Cleanup
// ============================================================================
test('Milestone 3 - MCP Trust: blocks project MCP server when explicit trust is not granted', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'locode-mcp-trust-'));
  try {
    const mcpConfig = {
      mcpServers: {
        untrustedServer: {
          command: 'node',
          args: ['-e', 'console.log("untrusted command executed")']
        }
      }
    };
    await fsp.writeFile(path.join(tmpDir, '.mcp.json'), JSON.stringify(mcpConfig), 'utf8');

    // Initialize MCPManager without trust
    const manager = new MCPManager(tmpDir, { trusted: false });
    const tools = await manager.init();

    assert.equal(tools.length, 0, 'No tools should be loaded from untrusted project MCP configuration');
    assert.deepEqual(manager.getActiveServers(), [], 'No server should be active without explicit trust');
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
});

test('Milestone 3 - MCP Cleanup: session cleanup unregisters all associated tools from tool registry', async () => {
  const fakeToolName = 'mcp_testserver_query';
  const fakeTool: ToolDefinition = {
    name: fakeToolName,
    description: 'test mcp tool',
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ result: 'ok' })
  };

  registerDynamicTool(fakeTool);
  assert.ok(toolRegistry.has(fakeToolName));
  assert.ok(allTools.some(t => t.name === fakeToolName));

  // Unregister via dynamic unregister
  unregisterDynamicTools([fakeToolName]);
  assert.equal(toolRegistry.has(fakeToolName), false, 'Tool must be removed from toolRegistry on cleanup');
  assert.equal(allTools.some(t => t.name === fakeToolName), false, 'Tool must be removed from allTools on cleanup');
});

// ============================================================================
// 4. Provider Switching: Isolation of Keys and Endpoints
// ============================================================================
test('Milestone 4 - Provider Switching: switching provider does not carry over foreign API key or endpoint', () => {
  const origEnv = { ...process.env };
  try {
    process.env.GEMINI_API_KEY = 'valid-gemini-key';
    delete process.env.ANTHROPIC_API_KEY;

    // Context that had OpenAI credentials
    const dummyOpenAiKey = ['sk', 'proj', 'dummy', 'openai', 'secret'].join('-');
    const openAiContext: AgentContext = {
      cwd: process.cwd(),
      autoApprove: true,
      provider: 'openai',
      model: 'gpt-4o',
      apiKey: dummyOpenAiKey,
      apiBase: 'https://api.openai.com/v1',
      numCtx: 128000
    };

    // Switch to Gemini, passing the old context but specifying target provider
    // The factory must NOT use the OpenAI key or endpoint for Gemini!
    const geminiContext: AgentContext = {
      ...openAiContext,
      provider: 'gemini',
      model: 'gemini-3.8-flash',
      apiKey: undefined, // Cleared on switch
      apiBase: undefined // Cleared on switch
    };

    const provider = createLLMProvider(geminiContext);
    assert.equal(provider.getModel(), 'gemini-3.8-flash');
    // Provider must resolve Gemini key and default Gemini base, NOT openai base
    const anyProv = provider as any;
    assert.notEqual(anyProv.apiBase, 'https://api.openai.com/v1');
    assert.notEqual(anyProv.apiKey, dummyOpenAiKey);
  } finally {
    process.env = origEnv;
  }
});

// ============================================================================
// 5. Cloud Privacy & Secret Redaction
// ============================================================================
test('Milestone 5 - Secret Redaction: redacts API keys, private keys, and auth tokens', () => {
  // Construct synthetic test tokens dynamically to prevent false-positive GitHub secret scanner alerts
  const mockAnthropicKey = ['sk', 'ant', 'api03', 'dummytesttoken1234567890abcdef'].join('-');
  const mockOpenAiKey = ['sk', 'proj', 'dummytesttoken1234567890abcdef'].join('-');
  const mockGeminiKey = ['AIza', 'SyDummyTestToken1234567890abcdefXYZ'].join('');
  const mockBearer = 'my-super-secret-bearer-token-123456';
  const mockRsaBody = 'MIIEowIBAAKCAQEA0Y1234567890abcdefghijklmnopqrstuvwxyz';
  const mockPassword = 'SuperSecret123!';

  const sensitiveText = [
    'Here are the secrets:',
    `Anthropic: ${mockAnthropicKey}`,
    `OpenAI: ${mockOpenAiKey}`,
    `Gemini: ${mockGeminiKey}`,
    `Authorization: Bearer ${mockBearer}`,
    'Private Key:',
    '-----BEGIN RSA PRIVATE KEY-----',
    mockRsaBody,
    '-----END RSA PRIVATE KEY-----',
    `Password: password = "${mockPassword}"`
  ].join('\n');

  const redacted = redactSecrets(sensitiveText);

  assert.ok(!redacted.includes(mockAnthropicKey));
  assert.ok(!redacted.includes(mockOpenAiKey));
  assert.ok(!redacted.includes(mockGeminiKey));
  assert.ok(!redacted.includes(mockBearer));
  assert.ok(!redacted.includes(mockRsaBody));
  assert.ok(!redacted.includes(mockPassword));
  assert.ok(redacted.includes('[REDACTED_SECRET]'));
});

// ============================================================================
// 6. SSRF Validation: Checks Redirects & Actual Network Destination
// ============================================================================
test('Milestone 6 - SSRF: validateSsrfSafeUrl blocks loopback, link-local, and private DNS destinations', async () => {
  // Direct loopback IP
  const res1 = await validateSsrfSafeUrl('http://127.0.0.1:8080');
  assert.equal(res1.safe, false);

  // Link-local / Cloud metadata IP
  const res2 = await validateSsrfSafeUrl('http://169.254.169.254/latest/meta-data');
  assert.equal(res2.safe, false);

  // Localhost hostname
  const res3 = await validateSsrfSafeUrl('http://localhost:3000');
  assert.equal(res3.safe, false);
});

// ============================================================================
// 7. Verification Semantics: passed, failed, not-run, inconclusive
// ============================================================================
test('Milestone 7 - Verification Semantics: consistently represented across CodeVerifier and ContextEngine', async () => {
  const contextEngine = new ContextEngine(process.cwd());

  // 1. Not Run
  contextEngine.recordVerificationResult(false, 'npm test', undefined, 'not-run');
  assert.equal(contextEngine.getTaskState().lastVerification?.status, 'not-run');
  assert.equal(contextEngine.getTaskState().lastVerification?.passed, false);
  assert.match(contextEngine.getTaskState().lastVerification?.summary || '', /NOT RUN/i);

  // 2. Inconclusive
  contextEngine.recordVerificationResult(false, 'npm test', 'Timed out', 'inconclusive');
  assert.equal(contextEngine.getTaskState().lastVerification?.status, 'inconclusive');
  assert.equal(contextEngine.getTaskState().lastVerification?.passed, false);
  assert.match(contextEngine.getTaskState().lastVerification?.summary || '', /INCONCLUSIVE/i);

  // 3. Failed
  contextEngine.recordVerificationResult(false, 'npm test', 'Error: test failed', 'failed');
  assert.equal(contextEngine.getTaskState().lastVerification?.status, 'failed');
  assert.equal(contextEngine.getTaskState().lastVerification?.passed, false);
  assert.match(contextEngine.getTaskState().lastVerification?.summary || '', /FAILED/i);

  // 4. Passed
  contextEngine.recordVerificationResult(true, 'npm test', 'All tests passed', 'passed');
  assert.equal(contextEngine.getTaskState().lastVerification?.status, 'passed');
  assert.equal(contextEngine.getTaskState().lastVerification?.passed, true);
  assert.match(contextEngine.getTaskState().lastVerification?.summary || '', /PASSED/i);
});

// ============================================================================
// 8. Runtime Configuration: Effective Server & No Unowned Termination
// ============================================================================
test('Milestone 8 - Process Management: never terminates an unowned process', async () => {
  const runtime = new LlamaCppRuntime({ autoPort: true });
  // Calling stop on unowned runtime must not attempt to kill any process
  assert.doesNotThrow(() => {
    runtime.stop();
  });
  const status = runtime.getStatus();
  assert.equal(status.isRunning, false, 'Unstarted unowned runtime must report isRunning=false');
});

// ============================================================================
// 9. Authoritative Recovery Controller
// ============================================================================
test('Milestone 9 - Recovery Controller: authoritatively detects tool cycles and handles empty responses', () => {
  const controller = new RecoveryController();

  // Test empty response handling
  const action1 = controller.handleEmptyResponse('fix bugs');
  assert.equal(action1.type, 'warn');
  assert.equal(action1.recoveryAttempts, 1);

  const action2 = controller.handleEmptyResponse('fix bugs');
  assert.equal(action2.type, 'warn');
  assert.equal(action2.recoveryAttempts, 2);

  const action3 = controller.handleEmptyResponse('fix bugs');
  assert.equal(action3.type, 'warn');
  assert.equal(action3.recoveryAttempts, 3);

  const action4 = controller.handleEmptyResponse('fix bugs');
  assert.equal(action4.type, 'halt', 'Persistent empty responses must trigger halt');

  // Test tool cycle detection
  const signatures = [
    'list_dir:{"path":"."}',
    'search_code:{"query":"foo"}',
    'list_dir:{"path":"."}',
    'search_code:{"query":"foo"}',
    'list_dir:{"path":"."}',
    'search_code:{"query":"foo"}'
  ];
  const cycle = RecoveryController.detectToolCycle(signatures);
  assert.equal(cycle.detected, true);
  assert.equal(cycle.period, 2);
});
