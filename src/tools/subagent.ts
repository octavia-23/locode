import { ToolDefinition, AgentContext } from '../types.js';
import { SubagentRunner } from '../agent/subagents/runner.js';
import { SubagentRole } from '../agent/subagents/types.js';

export const delegateTaskTool: ToolDefinition = {
  name: 'delegate_task',
  description: 'Delegates an isolated subtask to a specialized subagent (explorer, architect, verifier) with role-specific tool restrictions, bounded steps, and ephemeral context.',
  parameters: {
    type: 'object',
    properties: {
      role: {
        type: 'string',
        enum: ['explorer', 'architect', 'verifier'],
        description: 'Specialized role for the subagent: explorer (read-only search), architect (contract diagnosis), verifier (automated testing).'
      },
      prompt: {
        type: 'string',
        description: 'Specific actionable objective or question for the subagent to investigate or solve.'
      },
      maxSteps: {
        type: 'number',
        description: 'Maximum turns allowed for the subagent (1-10, default: 5).'
      }
    },
    required: ['role', 'prompt']
  },
  execute: async (args: { role: SubagentRole; prompt: string; maxSteps?: number }, context: AgentContext): Promise<{ result: string; isError?: boolean }> => {
    const outcome = await SubagentRunner.run({
      role: args.role,
      objective: args.prompt,
      maxSteps: args.maxSteps,
      context
    });

    const parts: string[] = [
      `[Subagent '${outcome.role}' completed with ${outcome.stepsUsed} steps in ${outcome.durationMs}ms]`,
      `Summary:\n${outcome.summary}`
    ];

    if (outcome.findings.length > 0) {
      parts.push(`Key Findings:\n${outcome.findings.map(f => '- ' + f).join('\n')}`);
    }

    if (outcome.inspectedFiles.length > 0) {
      parts.push(`Inspected Files: ${outcome.inspectedFiles.join(', ')}`);
    }

    if (outcome.suggestedActions.length > 0) {
      parts.push(`Suggested Actions:\n${outcome.suggestedActions.map(a => '- ' + a).join('\n')}`);
    }

    return {
      result: parts.join('\n\n')
    };
  }
};
