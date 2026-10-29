import { ChatMessage, ToolDefinition } from '../../types.js';
import { ILLMProvider } from '../../providers/types.js';
import { createLLMProvider } from '../../providers/factory.js';
import { ContextEngine } from '../context.js';
import { toolRegistry, allTools } from '../../tools/index.js';
import { extractToolCalls } from '../../utils/tool-parser.js';
import {
  SubagentRole,
  SubagentSessionConfig,
  SubagentOutcome,
  SUBAGENT_ALLOWED_TOOLS,
  SUBAGENT_SYSTEM_PROMPTS
} from './types.js';

export class SubagentRunner {
  /**
   * Spawns and executes an isolated subagent with ephemeral context and restricted tool permissions.
   */
  static async run(
    config: SubagentSessionConfig,
    customProvider?: ILLMProvider
  ): Promise<SubagentOutcome> {
    const startTime = Date.now();
    const role: SubagentRole = config.role;
    const maxSteps = Math.min(Math.max(1, config.maxSteps ?? 5), 10);
    const allowedTools = config.allowedTools ?? SUBAGENT_ALLOWED_TOOLS[role];
    const allowedSet = new Set(allowedTools.map(t => t.toLowerCase().trim()));

    // Instantiate ephemeral ContextEngine
    const ephemeralContext = new ContextEngine(32768, config.context.cwd);
    ephemeralContext.setObjective(config.objective);

    // Resolve model provider
    let provider = customProvider;
    if (!provider) {
      const modelToUse = (role === 'architect' && config.context.architectModel)
        ? config.context.architectModel
        : config.context.model;
      provider = createLLMProvider({
        ...config.context,
        model: modelToUse
      });
    }

    // Build role-specific system prompt
    const systemPrompt = SUBAGENT_SYSTEM_PROMPTS[role] || SUBAGENT_SYSTEM_PROMPTS.explorer;
    const initialUserPrompt = config.initialContext
      ? `${config.objective}\n\nCONTEXT:\n${config.initialContext}`
      : config.objective;

    const subagentMessages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: initialUserPrompt }
    ];

    // Filter tools for provider schema
    const roleTools = allTools.filter(t => allowedSet.has(t.name.toLowerCase().trim()));

    const inspectedFiles = new Set<string>();
    let stepCount = 0;
    let finalSummary = '';

    while (stepCount < maxSteps) {
      stepCount++;

      let response;
      try {
        response = await provider.chat(subagentMessages, roleTools);
      } catch (err: any) {
        finalSummary = `Subagent chat execution error: ${err.message}`;
        break;
      }

      const rawContent = response.content || '';
      let toolCalls = response.tool_calls || [];
      let cleanedText = rawContent;

      if (!toolCalls || toolCalls.length === 0) {
        const parsed = extractToolCalls(rawContent, allowedTools);
        if (parsed.hasToolCalls && parsed.toolCalls.length > 0) {
          toolCalls = parsed.toolCalls as any;
          cleanedText = parsed.cleanedText;
        }
      }

      if (!toolCalls || toolCalls.length === 0) {
        // Model produced final textual analysis
        finalSummary = rawContent.trim();
        subagentMessages.push({
          role: 'assistant',
          content: rawContent
        });
        break;
      }

      // Record assistant turn with tool calls
      subagentMessages.push({
        role: 'assistant',
        content: cleanedText,
        tool_calls: toolCalls
      });

      // Execute proposed tool calls through strict permission filter
      for (const call of toolCalls) {
        const toolName = call.function.name;
        const normalizedName = toolName.toLowerCase().trim();

        if (!allowedSet.has(normalizedName)) {
          // Strictly reject unauthorized tools
          subagentMessages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: `Error: Tool '${toolName}' is prohibited for ${role} subagent. Allowed tools: ${allowedTools.join(', ')}`
          });
          continue;
        }

        const toolDef = toolRegistry.get(toolName) || toolRegistry.get(normalizedName);
        if (!toolDef) {
          subagentMessages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: `Error: Unknown tool '${toolName}'`
          });
          continue;
        }

        let args: Record<string, any> = {};
        if (typeof call.function.arguments === 'string') {
          try {
            args = JSON.parse(call.function.arguments);
          } catch {
            args = {};
          }
        } else if (call.function.arguments) {
          args = call.function.arguments;
        }

        // Track inspected files
        if (['view_file', 'batch_read_files'].includes(normalizedName)) {
          if (args.path) inspectedFiles.add(String(args.path));
          if (Array.isArray(args.paths)) args.paths.forEach((p: any) => inspectedFiles.add(String(p)));
        }

        try {
          const execRes = await toolDef.execute(args, config.context);
          const outputText = typeof execRes === 'string' ? execRes : (execRes?.result ?? String(execRes));
          subagentMessages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: outputText
          });
        } catch (execErr: any) {
          subagentMessages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: `Error executing ${toolName}: ${execErr.message}`
          });
        }
      }
    }

    if (!finalSummary) {
      const lastAssistant = subagentMessages.filter(m => m.role === 'assistant').pop();
      finalSummary = lastAssistant?.content || `Subagent completed exploration within ${stepCount} steps.`;
    }

    // Extract key findings and suggested actions from the conversation
    const findings: string[] = [];
    const suggestedActions: string[] = [];

    const lines = finalSummary.split('\n');
    let section: 'findings' | 'actions' | 'other' = 'other';

    for (const line of lines) {
      const t = line.trim();
      if (/findings|discovered|root cause/i.test(t)) {
        section = 'findings';
        continue;
      } else if (/actions|suggested|surgical fix|next steps/i.test(t)) {
        section = 'actions';
        continue;
      }

      if (t.startsWith('-') || t.startsWith('*') || /^\d+\./.test(t)) {
        const item = t.replace(/^[-*]|\d+\./, '').trim();
        if (item) {
          if (section === 'findings') findings.push(item);
          else if (section === 'actions') suggestedActions.push(item);
        }
      }
    }

    // Fallback if no formatted bullet points found
    if (findings.length === 0 && finalSummary.length > 0) {
      findings.push(finalSummary.slice(0, 300));
    }

    return {
      role,
      success: true,
      summary: finalSummary,
      findings,
      suggestedActions,
      stepsUsed: stepCount,
      durationMs: Date.now() - startTime,
      inspectedFiles: Array.from(inspectedFiles)
    };
  }
}
