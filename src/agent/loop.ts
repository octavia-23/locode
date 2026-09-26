import fs from 'node:fs/promises';
import path from 'node:path';
import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import { AgentContext, ChatMessage } from '../types.js';
import { allTools, toolRegistry } from '../tools/index.js';
import { OllamaProvider } from '../providers/ollama.js';
import { ContextManager } from './context.js';
import { TerminalRenderer } from '../ui/renderer.js';
import { buildSystemPrompt } from './prompt.js';

export class AgentLoop {
  private messages: ChatMessage[] = [];
  private provider: OllamaProvider;
  private renderer: TerminalRenderer;
  private contextManager: ContextManager;
  private context: AgentContext;

  constructor(context: AgentContext, renderer: TerminalRenderer) {
    this.context = context;
    this.renderer = renderer;
    this.provider = new OllamaProvider(context.model, context.ollamaHost);
    this.contextManager = new ContextManager(16384);

    // Initialize system message
    this.messages.push({
      role: 'system',
      content: buildSystemPrompt(context.cwd)
    });
  }

  setContext(context: Partial<AgentContext>) {
    this.context = { ...this.context, ...context };
    if (context.model) {
      this.provider.setModel(context.model);
    }
  }

  clearHistory() {
    this.messages = [{
      role: 'system',
      content: buildSystemPrompt(this.context.cwd)
    }];
  }

  getMessages(): ChatMessage[] {
    return this.messages;
  }

  async run(userInput: string) {
    this.messages.push({
      role: 'user',
      content: userInput
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
        this.renderer.printError(`Ollama request failed: ${err.message}`);
        break;
      }

      this.renderer.stopSpinner();

      const { content, tool_calls } = response;

      // If the model spoke some thoughts (and not just raw tool JSON), display them
      const trimmedContent = content ? content.trim() : '';
      const isJustJson = (trimmedContent.startsWith('{') && trimmedContent.endsWith('}')) ||
                         (trimmedContent.startsWith('<tool_call>') && trimmedContent.endsWith('</tool_call>'));

      if (trimmedContent && (!tool_calls || tool_calls.length === 0 || !isJustJson)) {
        this.renderer.printAssistantMessage(trimmedContent);
      }

      // If no tool calls were requested, the model finished its response!
      if (!tool_calls || tool_calls.length === 0) {
        this.messages.push({
          role: 'assistant',
          content: content || ''
        });
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
