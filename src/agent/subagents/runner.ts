import { ChatMessage, ToolDefinition } from '../../types.js';
import { ILLMProvider } from '../../providers/types.js';
import { createLLMProvider, isCloudProvider } from '../../providers/factory.js';
import { ContextEngine } from '../context.js';
import { toolRegistry, allTools } from '../../tools/index.js';
import { extractToolCalls } from '../../utils/tool-parser.js';
import { ToolDispatcher } from '../../engine/tool-dispatcher.js';
import { PermissionEngine } from '../../engine/permission-engine.js';
import { redactSecrets } from '../../utils/secret-redactor.js';
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

    // Enforce readOnly: true for explorer and architect roles in PermissionEngine
    const isReadOnlyRole = role === 'explorer' || role === 'architect';
    const permissionEngine = new PermissionEngine({
      autoApprove: true,
      readOnly: isReadOnlyRole,
      allowNetwork: config.context.provider ? !isCloudProvider(config.context.provider) : true
    });

    const journal = config.journal || config.context.journal;
    const dispatcher = new ToolDispatcher(permissionEngine, undefined, journal);

    if (journal) {
      await journal.recordEvent('subagent_spawned', {
        role,
        objective: config.objective,
        maxSteps,
        allowedTools,
        readOnly: isReadOnlyRole
      }).catch(() => {});
    }

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
    let totalTokens = 0;
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

      if (response?.usage) {
        totalTokens += response.usage.totalTokens || 0;
      }

      const rawContent = response?.content || '';
      let toolCalls = response?.tool_calls || [];
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

      // Execute proposed tool calls through ToolDispatcher & PermissionEngine
      let batchFailed = false;
      for (let i = 0; i < toolCalls.length; i++) {
        const call = toolCalls[i];
        const toolName = call.function.name;
        const normalizedName = toolName.toLowerCase().trim();
        const callId = call.id || `subagent_call_${Date.now()}_${i}`;

        if (batchFailed) {
          subagentMessages.push({
            role: 'tool',
            name: toolName,
            tool_call_id: callId,
            content: '[Skipped due to preceding tool error in batch]'
          });
          continue;
        }

        if (!allowedSet.has(normalizedName)) {
          // Strictly reject unauthorized tools
          subagentMessages.push({
            role: 'tool',
            name: toolName,
            tool_call_id: callId,
            content: `Error: Tool '${toolName}' is prohibited for ${role} subagent. Allowed tools: ${allowedTools.join(', ')}`
          });
          batchFailed = true;
          continue;
        }

        const toolDef = toolRegistry.get(toolName) || toolRegistry.get(normalizedName);
        if (!toolDef) {
          subagentMessages.push({
            role: 'tool',
            name: toolName,
            tool_call_id: callId,
            content: `Error: Unknown tool '${toolName}'`
          });
          batchFailed = true;
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

        // Dispatch tool through scoped ToolDispatcher (validates schema, checks path containment & permissions)
        const durableResult = await dispatcher.dispatch(
          toolDef,
          args,
          config.context,
          callId,
          {
            autoApprove: true,
            allowNetwork: config.context.provider ? !isCloudProvider(config.context.provider) : true
          }
        );

        let outputText = durableResult.output;
        // Redact any secrets
        outputText = redactSecrets(outputText);

        subagentMessages.push({
          role: 'tool',
          name: toolName,
          tool_call_id: callId,
          content: outputText
        });

        if (durableResult.isError) {
          batchFailed = true;
        } else {
          // Track inspected files on success
          if (['view_file', 'batch_read_files'].includes(normalizedName)) {
            if (args.path) inspectedFiles.add(String(args.path));
            if (Array.isArray(args.paths)) args.paths.forEach((p: any) => inspectedFiles.add(String(p)));
          }
        }
      }
    }

    // Force final synthesis when maxSteps is reached on a tool turn
    if (!finalSummary.trim()) {
      try {
        subagentMessages.push({
          role: 'user',
          content: 'You have reached the maximum tool step limit. Synthesize all findings, file paths, and conclusions from the tool outputs above into a concise final report. Do not invoke any tools.'
        });
        const synthesisResponse = await provider.chat(subagentMessages, []);
        if (synthesisResponse?.usage) {
          totalTokens += synthesisResponse.usage.totalTokens || 0;
        }
        finalSummary = (synthesisResponse?.content || '').trim();
      } catch {}
    }

    // Deterministic fallback if provider returned empty synthesis text
    if (!finalSummary.trim()) {
      const toolOutputs = subagentMessages
        .filter(m => m.role === 'tool' && m.content && !m.content.startsWith('[Skipped'))
        .map(m => typeof m.content === 'string' ? m.content.slice(0, 150) : '')
        .filter(Boolean);

      if (toolOutputs.length > 0) {
        finalSummary = `Subagent ${role} executed ${stepCount} steps inspecting: ${Array.from(inspectedFiles).join(', ') || 'workspace files'}.\nFindings:\n` +
          toolOutputs.map(o => `- ${o.replace(/\n+/g, ' ')}`).join('\n');
      } else {
        finalSummary = `Subagent ${role} completed exploration within ${stepCount} steps for objective: "${config.objective}".`;
      }
    }

    if (journal) {
      await journal.recordEvent('subagent_completed', {
        role,
        stepsUsed: stepCount,
        durationMs: Date.now() - startTime,
        success: true,
        totalTokensUsed: totalTokens,
        summary: finalSummary.slice(0, 500)
      }).catch(() => {});
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
