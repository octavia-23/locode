import { AgentContext } from '../../types.js';
import { ExecutionJournal } from '../../journal/journal.js';

export type SubagentRole = 'explorer' | 'architect' | 'verifier';

export interface SubagentSessionConfig {
  role: SubagentRole;
  objective: string;
  context: AgentContext;
  maxSteps?: number;
  allowedTools?: string[];
  initialContext?: string;
  parentSessionId?: string;
  journal?: ExecutionJournal;
}

export interface SubagentOutcome {
  role: SubagentRole;
  success: boolean;
  summary: string;
  findings: string[];
  suggestedActions: string[];
  stepsUsed: number;
  durationMs: number;
  inspectedFiles: string[];
}

export const SUBAGENT_ALLOWED_TOOLS: Record<SubagentRole, string[]> = {
  explorer: ['view_file', 'batch_read_files', 'list_dir', 'search_code', 'fetch_web', 'search_web'],
  architect: ['view_file', 'batch_read_files', 'search_code', 'list_dir'],
  verifier: ['run_command', 'view_file']
};

export const SUBAGENT_SYSTEM_PROMPTS: Record<SubagentRole, string> = {
  explorer: `You are an elite Explorer Subagent in Locode.
Your sole mission is to rapidly explore the repository, inspect file contents, search for code patterns, and discover relevant context.
You have strictly READ-ONLY tools. You CANNOT edit files, write files, or run dangerous terminal commands.
When your exploration is complete, summarize your findings clearly with:
- DISCOVERED FILES: Relevant files found
- KEY FINDINGS: Key insights, structures, or definitions discovered
- SUGGESTED ACTIONS: Next steps for the main agent`,

  architect: `You are an authoritative Senior Systems Architect Subagent in Locode.
Your mission is to perform deep cross-file diagnosis on verification failures or complex architectural tasks.
You have READ-ONLY tools to inspect files and search code. You CANNOT edit files directly.
Conclude with:
- ROOT CAUSE: Precise reason for the issue or failure
- AFFECTED CONTRACTS: Specific files, functions, and interfaces
- SURGICAL FIX DIRECTIVE: Exact instructions on what to edit`,

  verifier: `You are a rigorous Quality Verifier Subagent in Locode.
Your mission is to run automated verification, tests, or linters, inspect the output, and determine if code changes are valid.
You have tools to run commands and view files. You CANNOT edit code.
Conclude with:
- STATUS: PASSED or FAILED
- FAILING TESTS / ERRORS: Exact error lines and file locations
- VERIFICATION SUMMARY: Brief concise summary of test results`
};
