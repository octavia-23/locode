import chalk from 'chalk';
import { AgentContext, ChatMessage } from '../types.js';
import { ILLMProvider } from '../providers/types.js';
import { createLLMProvider } from '../providers/factory.js';

export class ArchitectEngine {
  /**
   * Generates a deep structural diagnosis when the worker model gets stuck in a verification error.
   */
  static async diagnose(
    errorOutput: string,
    command: string,
    recentMessages: ChatMessage[],
    context: AgentContext,
    defaultProvider: ILLMProvider
  ): Promise<string> {
    const architectModel = context.architectModel || context.model;
    
    // If an alternate architect model is configured, instantiate provider for it
    let provider = defaultProvider;
    if (context.architectModel && context.architectModel !== context.model) {
      provider = createLLMProvider({
        ...context,
        model: context.architectModel
      });
    }

    // Extract recent file modifications from messages
    const recentEdits = recentMessages
      .filter(m => m.role === 'tool' || (m.role === 'assistant' && m.tool_calls))
      .slice(-6);

    const prompt = `You are the Lead Systems Architect in an elite software engineering team.
The fast code editor model introduced changes that broke automated verification.
The automated repair loop needs your senior diagnostic analysis to unblock the build.

VERIFICATION COMMAND:
\`${command}\`

FAILURE STACK TRACE & COMPILER OUTPUT:
\`\`\`
${errorOutput.slice(0, 2000)}
\`\`\`

RECENT ACTIONS TAKEN:
${recentEdits.map(m => `[${m.role}] ${typeof m.content === 'string' ? m.content.slice(0, 300) : ''}`).join('\n')}

Provide an EXECUTIVE ARCHITECTURAL DIAGNOSIS with:
1. ROOT CAUSE ANALYSIS: Exactly why the compiler or test is failing (type mismatch, missing export, async unhandled, broken import).
2. AFFECTED CONTRACT: The specific file(s), line(s), and function signatures that must be reconciled.
3. SURGICAL FIX DIRECTIVE: Exact instructions for the worker model on what to replace in 'edit_file'.

Be authoritative, precise, and concise. Do NOT output conversational boilerplate.`;

    try {
      const res = await provider.chat([
        {
          role: 'system',
          content: 'You are an authoritative Senior Systems Architect providing precise debugging plans.'
        },
        {
          role: 'user',
          content: prompt
        }
      ], []);

      return res.content.trim();
    } catch (err: any) {
      return `Failed to generate architect diagnosis: ${err.message}`;
    }
  }
}
