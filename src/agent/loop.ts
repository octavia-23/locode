import fs from 'node:fs/promises';
import path from 'node:path';
import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import { AgentContext, ChatMessage } from '../types.js';
import { allTools, toolRegistry } from '../tools/index.js';
import { ILLMProvider } from '../providers/types.js';
import { createLLMProvider } from '../providers/factory.js';
import { ContextManager } from './context.js';
import { TerminalRenderer } from '../ui/renderer.js';
import { buildSystemPrompt } from './prompt.js';
import { CheckpointManager } from '../git/checkpoint.js';
import { resolveFileMentions } from './mentions.js';
import { MCPManager } from '../mcp/manager.js';

export interface SessionStats {
  turns: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  totalDurationMs: number;
}

export class AgentLoop {
  private messages: ChatMessage[] = [];
  private provider: ILLMProvider;
  private renderer: TerminalRenderer;
  private contextManager: ContextManager;
  private context: AgentContext;
  private checkpointManager: CheckpointManager;
  private stats: SessionStats = {
    turns: 0,
    totalTokens: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalDurationMs: 0
  };

  constructor(context: AgentContext, renderer: TerminalRenderer) {
    this.context = context;
    this.renderer = renderer;
    this.provider = createLLMProvider(context);
    this.contextManager = new ContextManager(16384);
    this.checkpointManager = new CheckpointManager(context.cwd);
    this.mcpManager = new MCPManager(context.cwd);
  }

  private mcpManager: MCPManager;

  async init() {
    this.messages = [{
      role: 'system',
      content: await buildSystemPrompt(this.context.cwd)
    }];

    // Connect MCP servers if configured
    const mcpTools = await this.mcpManager.init();
    for (const tool of mcpTools) {
      toolRegistry.set(tool.name, tool);
      if (!allTools.some(t => t.name === tool.name)) {
        allTools.push(tool);
      }
    }

    if (mcpTools.length > 0) {
      const servers = this.mcpManager.getActiveServers().join(', ');
      this.renderer.printSuccess(`Connected to MCP servers [${servers}] with ${mcpTools.length} tools`);
    }
  }

  getMCPManager(): MCPManager {
    return this.mcpManager;
  }

  async close() {
    await this.mcpManager.closeAll();
  }

  setContext(context: Partial<AgentContext>) {
    this.context = { ...this.context, ...context };
    if (context.model) {
      this.provider.setModel(context.model);
    }
  }

  getProvider(): ILLMProvider {
    return this.provider;
  }

  getStats(): SessionStats {
    return this.stats;
  }

  async clearHistory() {
    this.messages = [{
      role: 'system',
      content: await buildSystemPrompt(this.context.cwd)
    }];
  }

  getMessages(): ChatMessage[] {
    return this.messages;
  }

  async undo(): Promise<{ success: boolean; message: string }> {
    return await this.checkpointManager.undo();
  }

  /**
   * Generates a clean Conventional Commit message based on git diff
   */
  async generateCommitMessage(diffText: string): Promise<string> {
    const prompt = `Based on the following git diff, generate a concise Conventional Commit message (e.g. "feat: add user auth" or "fix(parser): handle empty strings"). Output ONLY the commit message without any quotes or explanations.\n\nGit diff:\n${diffText.slice(0, 4000)}`;

    try {
      const res = await this.provider.chat([
        { role: 'user', content: prompt }
      ], []);
      return res.content.trim().replace(/^["']|["']$/g, '');
    } catch {
      return 'chore: update project files';
    }
  }

  async run(userInput: string) {
    if (this.messages.length === 0) {
      await this.init();
    }

    // 1. Create a git checkpoint prior to making any modifications
    await this.checkpointManager.createCheckpoint();

    // 2. Resolve any @file references in user prompt
    const { processedPrompt, injectedFiles } = await resolveFileMentions(userInput, this.context.cwd);
    if (injectedFiles.length > 0) {
      this.renderer.printMentionedFiles(injectedFiles);
    }

    this.messages.push({
      role: 'user',
      content: processedPrompt
    });

    const maxSteps = 25;
    let stepCount = 0;

    while (stepCount < maxSteps) {
      stepCount++;

      // Compact context if history grows large
      const compacted = this.contextManager.compactMessages(this.messages);

      this.renderer.startSpinner(`Thinking with ${chalk.cyan(this.context.model)}...`);

      let response;
      try {
        response = await this.provider.chat(compacted, allTools);
      } catch (err: any) {
        this.renderer.printError(`Model request failed: ${err.message}`);
        break;
      }

      this.renderer.stopSpinner();

      // Accumulate telemetry
      if (response.usage) {
        this.stats.turns++;
        this.stats.totalTokens += response.usage.totalTokens;
        this.stats.promptTokens += response.usage.promptTokens;
        this.stats.completionTokens += response.usage.completionTokens;
        this.stats.totalDurationMs += response.usage.durationMs;
      }

      const { content, tool_calls } = response;

      // If the model spoke some thoughts (and not just raw tool JSON), display them
      const trimmedContent = content ? content.trim() : '';
      const isJustJson = (trimmedContent.startsWith('{') && trimmedContent.endsWith('}')) ||
                         (trimmedContent.startsWith('<tool_call>') && trimmedContent.endsWith('</tool_call>'));

      if (trimmedContent && (!tool_calls || tool_calls.length === 0 || !isJustJson)) {
        this.renderer.printAssistantMessage(trimmedContent);
      }

      // If no tool calls were requested, display telemetry and finish turn
      if (!tool_calls || tool_calls.length === 0) {
        this.messages.push({
          role: 'assistant',
          content: content || ''
        });
        this.renderer.printTelemetry(response.usage);
        break;
      }

      // Add the assistant's action to message history
      this.messages.push({
        role: 'assistant',
        content: content || '',
        tool_calls: tool_calls
      });

      // Execute each tool call sequentially
      for (const call of tool_calls) {
        const toolName = call.function.name;
        let toolArgs = call.function.arguments;

        if (typeof toolArgs === 'string') {
          try {
            toolArgs = JSON.parse(toolArgs);
          } catch {
            toolArgs = {};
          }
        }

        const tool = toolRegistry.get(toolName);
        if (!tool) {
          const errMsg = `Tool "${toolName}" is not registered. Available tools: ${Array.from(toolRegistry.keys()).join(', ')}`;
          this.renderer.printError(errMsg);
          this.messages.push({
            role: 'tool',
            name: toolName,
            content: errMsg
          });
          continue;
        }

        this.renderer.printToolCall(toolName, toolArgs);

        // Previews for file edits
        if (toolName === 'edit_file' && toolArgs.path && toolArgs.target_content && toolArgs.replacement_content) {
          try {
            const targetPath = path.resolve(this.context.cwd, toolArgs.path);
            const currentContent = await fs.readFile(targetPath, 'utf8');
            const target = toolArgs.target_content;
            const replacement = toolArgs.replacement_content;
            const previewNew = currentContent.replace(target, replacement);
            this.renderer.printDiff(toolArgs.path, currentContent, previewNew);
          } catch {}
        } else if (toolName === 'write_file' && toolArgs.path) {
          try {
            const targetPath = path.resolve(this.context.cwd, toolArgs.path);
            let currentContent = '';
            try {
              currentContent = await fs.readFile(targetPath, 'utf8');
              this.renderer.printDiff(toolArgs.path, currentContent, toolArgs.content);
            } catch {
              console.log(chalk.green(`  (New file: ${toolArgs.path})`));
            }
          } catch {}
        }

        // Approval Check
        let isApproved = true;
        const needsApproval = typeof tool.needsApproval === 'function'
          ? tool.needsApproval(toolArgs)
          : tool.needsApproval;

        if (needsApproval && !this.context.autoApprove) {
          try {
            isApproved = await confirm({
              message: `Approve execution of ${chalk.bold.yellow(toolName)}?`,
              default: true
            });
          } catch {
            isApproved = false;
          }
        }

        if (!isApproved) {
          const rejectedMsg = `Execution of "${toolName}" was rejected by the user.`;
          this.renderer.printError(rejectedMsg);
          this.messages.push({
            role: 'tool',
            name: toolName,
            content: rejectedMsg
          });
          continue;
        }

        // Execute tool
        this.renderer.startSpinner(`Executing ${toolName}...`);
        const executionResult = await tool.execute(toolArgs, this.context);
        this.renderer.stopSpinner();

        this.renderer.printToolResult(toolName, executionResult.result, executionResult.isError);

        this.messages.push({
          role: 'tool',
          name: toolName,
          content: executionResult.result
        });
      }
    }

    if (stepCount >= maxSteps) {
      this.renderer.printError(`Reached maximum reasoning steps (${maxSteps}) for this turn.`);
    }
  }
}
