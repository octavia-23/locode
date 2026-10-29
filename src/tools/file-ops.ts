import fs from 'node:fs/promises';
import path from 'node:path';
import { ToolDefinition } from '../types.js';
import { resolveSafePath } from './security.js';
import { MultiStrategyEditEngine } from './edit-engine.js';
import { isCloudProvider } from '../providers/factory.js';
import { isSensitiveFile, redactSensitiveFileContent } from '../utils/secret-redactor.js';
import { CodeVerifier } from '../agent/verifier.js';

export const viewFileTool: ToolDefinition = {
  name: 'view_file',
  description: 'View the contents of a file with line numbers. By default shows the whole file (up to 600 lines) or specify start_line and end_line. For large files (>800 lines), use outline=true or use search_code to locate the exact functions or lines needed.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Path to the file to read (relative to workspace or absolute)'
      },
      start_line: {
        type: 'number',
        description: 'Optional start line number (1-indexed, inclusive)'
      },
      end_line: {
        type: 'number',
        description: 'Optional end line number (1-indexed, inclusive)'
      },
      outline: {
        type: 'boolean',
        description: 'If true, returns an structural outline of function/class/export signatures with their line numbers. Ideal for large files.'
      }
    },
    required: ['path']
  },
  needsApproval: false,
  async execute(args, context) {
    try {
      const fullPath = resolveSafePath(args.path, context.cwd);
      let content = await fs.readFile(fullPath, 'utf8');
      if (isSensitiveFile(args.path)) {
        content = redactSensitiveFileContent(args.path, content);
      }
      const lines = content.split('\n');

      // Outline Mode for large files
      if (args.outline) {
        const outlineLines: string[] = [];
        for (let idx = 0; idx < lines.length; idx++) {
          const l = lines[idx];
          if (/^\s*(export\s+)?(function|class|interface|type|const|let|var|def|class|pub\s+fn|async\s+function)\b/.test(l) ||
              /^\s*(public|private|protected|static|async)?\s*([a-zA-Z0-9_$]+)\s*\([^)]*\)\s*[:{]/.test(l) ||
              /^[A-Za-z0-9_#.-]+:/.test(l)) {
            outlineLines.push(`${(idx + 1).toString().padStart(4, ' ')}: ${l.trimEnd()}`);
          }
        }
        return {
          result: `Outline for ${args.path} (${outlineLines.length} symbols in ${lines.length} lines):\n` +
            (outlineLines.length > 0 ? outlineLines.join('\n') : '(No top-level declarations detected)') +
            `\n\nUse search_code to locate specific methods, or view_file with start_line/end_line around the target symbol.`
        };
      }
      
      const isCloud = isCloudProvider(context?.provider);
      const start = args.start_line ? Math.max(1, Math.min(args.start_line, lines.length)) : 1;
      const defaultWindow = isCloud ? 2500 : 600;
      const maxWindow = isCloud ? 3000 : 700;
      const defaultEnd = Math.min(lines.length, start + defaultWindow);
      let end = args.end_line ? Math.min(lines.length, Math.max(start, args.end_line)) : defaultEnd;
      let wasWindowCapped = false;
      if (end - start + 1 > maxWindow) {
        end = start + maxWindow - 1;
        wasWindowCapped = true;
      }

      const sliced = lines.slice(start - 1, end);
      const formatted = sliced
        .map((line, idx) => `${(start + idx).toString().padStart(4, ' ')}: ${line}`)
        .join('\n');

      let header = `File: ${args.path} (lines ${start}-${end} of ${lines.length})\n`;
      if (isCloud) {
        if (wasWindowCapped || end < lines.length) {
          header += `[Lines ${start}-${end} of ${lines.length} shown. Use start_line/end_line to view other sections if needed]\n`;
        }
      } else {
        if (lines.length > 800) {
          header += `[NOTICE: Large file (${lines.length} lines). Do NOT paginate the entire file with view_file! Use 'search_code' to find the relevant function/variable, or 'view_file' with outline=true to see declarations, then proceed directly to 'edit_file']\n`;
        }
        if (wasWindowCapped) {
          header += `[Window capped at ${maxWindow} lines. Do NOT page through the file. Use 'search_code' to locate specific functions or proceed directly to 'edit_file']\n`;
        } else if (end < lines.length && !args.end_line) {
          header += `[Context limit: output truncated at line ${end} of ${lines.length}. Use 'search_code' to locate specific functions or proceed directly to 'edit_file']\n`;
        }
      }

      if (context.contextEngine?.recordFileRead) {
        context.contextEngine.recordFileRead(args.path, content);
      }

      return { result: header + formatted };
    } catch (err: any) {
      return { result: `Failed to read file "${args.path}": ${err.message}`, isError: true };
    }
  }
};

export const batchReadFilesTool: ToolDefinition = {
  name: 'batch_read_files',
  description: 'Inspect multiple files in a single tool call to understand architecture or dependencies without wasting individual turns.',
  parameters: {
    type: 'object',
    properties: {
      paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Array of file paths to read'
      },
      max_lines_per_file: {
        type: 'number',
        description: 'Maximum lines to read per file (default: 200)'
      }
    },
    required: ['paths']
  },
  needsApproval: false,
  async execute(args, context) {
    try {
      const paths: string[] = args.paths || [];
      if (paths.length === 0) {
        return { result: 'No file paths provided.', isError: true };
      }

      const isCloud = isCloudProvider(context?.provider);
      const defaultBatchMax = isCloud ? 500 : 200;
      const maxLines = args.max_lines_per_file || defaultBatchMax;
      const results: string[] = [];

      for (const p of paths.slice(0, 10)) { // limit to 10 files per batch
        try {
          const fullPath = resolveSafePath(p, context.cwd);
          let content = await fs.readFile(fullPath, 'utf8');
          if (isSensitiveFile(p)) {
            content = redactSensitiveFileContent(p, content);
          }
          const lines = content.split('\n');
          const displayLines = lines.slice(0, maxLines);
          const formatted = displayLines
            .map((line, idx) => `${(idx + 1).toString().padStart(4, ' ')}: ${line}`)
            .join('\n');
          
          let fileHeader = `--- File: ${p} (${Math.min(lines.length, maxLines)} of ${lines.length} lines) ---\n`;
          if (lines.length > maxLines) {
            fileHeader += `[Truncated at line ${maxLines}. Proceed directly to 'edit_file' or use 'search_code' for specific symbols]\n`;
          }

          results.push(fileHeader + formatted);

          if (context.contextEngine?.recordFileRead) {
            context.contextEngine.recordFileRead(p, content);
          }
        } catch (err: any) {
          results.push(`--- File: ${p} ---\n[Error reading file: ${err.message}]`);
        }
      }

      return { result: results.join('\n\n') };
    } catch (err: any) {
      return { result: `Failed to batch read files: ${err.message}`, isError: true };
    }
  }
};

export const writeFileTool: ToolDefinition = {
  name: 'write_file',
  description: 'Create a new file or completely overwrite an existing file with the provided content.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Path of the file to write'
      },
      content: {
        type: 'string',
        description: 'The complete content to write'
      }
    },
    required: ['path', 'content']
  },
  needsApproval: true,
  async execute(args, context) {
    try {
      const fullPath = resolveSafePath(args.path, context.cwd);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, args.content, 'utf8');
      if (context.contextEngine?.invalidateFile) {
        context.contextEngine.invalidateFile(args.path);
      }
      return { result: `Successfully wrote ${args.content.length} characters to ${args.path}` };
    } catch (err: any) {
      return { result: `Failed to write file "${args.path}": ${err.message}`, isError: true };
    }
  }
};

export const editFileTool: ToolDefinition = {
  name: 'edit_file',
  description: 'Perform a precise search-and-replace edit on an existing file. Provide exact target_content to be replaced and replacement_content.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Path to the file to edit'
      },
      target_content: {
        type: 'string',
        description: 'The exact string/block of code to find and replace'
      },
      replacement_content: {
        type: 'string',
        description: 'The new string/block of code to insert'
      }
    },
    required: ['path', 'target_content', 'replacement_content']
  },
  needsApproval: true,
  async execute(args, context) {
    try {
      const fullPath = resolveSafePath(args.path, context.cwd);
      const existing = await fs.readFile(fullPath, 'utf8');

      const editResult = MultiStrategyEditEngine.apply(
        existing,
        args.target_content,
        args.replacement_content,
        args.path
      );

      if (!editResult.success) {
        return { result: editResult.error || `Target content not found in ${args.path}.`, isError: true };
      }

      const hasCrlf = existing.includes('\r\n');
      const finalContent = hasCrlf ? editResult.content.replace(/\r?\n/g, '\r\n') : editResult.content;
      await fs.writeFile(fullPath, finalContent, 'utf8');
      if (context.contextEngine?.invalidateFile) {
        context.contextEngine.invalidateFile(args.path);
      }

      const fallbackNotice = editResult.strategyUsed && editResult.strategyUsed !== 'exact'
        ? ` (applied via ${editResult.strategyUsed} fallback)`
        : '';

      return { result: `Successfully updated ${args.path}${fallbackNotice}` };
    } catch (err: any) {
      return { result: `Failed to edit file "${args.path}": ${err.message}`, isError: true };
    }
  }
};

export const multiEditFileTool: ToolDefinition = {
  name: 'multi_edit_file',
  description: 'Perform atomic, multi-hunk or multi-file edits across one or more files. All edits are validated and computed in-memory first; if any hunk in any file fails to match, zero changes are written to disk (atomic rollback guarantee).',
  parameters: {
    type: 'object',
    properties: {
      files: {
        type: 'array',
        description: 'List of files to edit with their corresponding replacement hunks.',
        items: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Path to the file to edit'
            },
            edits: {
              type: 'array',
              description: 'Sequential hunks to apply to this file',
              items: {
                type: 'object',
                properties: {
                  target_content: {
                    type: 'string',
                    description: 'Exact text or hunk to replace'
                  },
                  replacement_content: {
                    type: 'string',
                    description: 'Replacement text'
                  }
                },
                required: ['target_content', 'replacement_content']
              }
            }
          },
          required: ['path', 'edits']
        }
      },
      edits: {
        type: 'array',
        description: 'Alternative flat list of edits across files.',
        items: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Path to the file to edit'
            },
            target_content: {
              type: 'string',
              description: 'Exact text or hunk to replace'
            },
            replacement_content: {
              type: 'string',
              description: 'Replacement text'
            }
          },
          required: ['target_content', 'replacement_content']
        }
      },
      path: {
        type: 'string',
        description: 'Convenience path when editing multiple hunks within a single file.'
      },
      validate_syntax: {
        type: 'boolean',
        description: 'If true, verifies candidate TypeScript/JavaScript/JSON syntax in-memory before writing. Aborts and rolls back if errors are detected.'
      },
      validateSyntax: {
        type: 'boolean',
        description: 'Alias for validate_syntax'
      }
    }
  },
  needsApproval: true,
  async execute(args, context) {
    try {
      // Step 1: Normalize input formats into Map<string, Array<{ target_content: string; replacement_content: string }>>
      const fileEditsMap = new Map<string, Array<{ target_content: string; replacement_content: string }>>();

      if (Array.isArray(args.files)) {
        for (const item of args.files) {
          if (item && typeof item.path === 'string' && Array.isArray(item.edits)) {
            const list = fileEditsMap.get(item.path) || [];
            for (const e of item.edits) {
              if (e && typeof e.target_content === 'string' && typeof e.replacement_content === 'string') {
                list.push({
                  target_content: e.target_content,
                  replacement_content: e.replacement_content
                });
              }
            }
            if (list.length > 0) {
              fileEditsMap.set(item.path, list);
            }
          }
        }
      }

      if (Array.isArray(args.edits)) {
        for (const e of args.edits) {
          const filePath = e.path || args.path;
          if (filePath && typeof e.target_content === 'string' && typeof e.replacement_content === 'string') {
            const list = fileEditsMap.get(filePath) || [];
            list.push({
              target_content: e.target_content,
              replacement_content: e.replacement_content
            });
            fileEditsMap.set(filePath, list);
          }
        }
      }

      if (fileEditsMap.size === 0) {
        return {
          result: 'No valid edits provided to multi_edit_file. Provide either "files: [{ path, edits }]" or "edits: [{ path, target_content, replacement_content }]" or "path" with "edits".',
          isError: true
        };
      }

      // Step 2: In-Memory Pre-computation & Strict Validation Phase
      const pendingWrites = new Map<string, {
        fullPath: string;
        originalContent: string;
        newContent: string;
        strategies: string[];
      }>();

      for (const [filePath, hunks] of fileEditsMap.entries()) {
        let fullPath: string;
        let originalContent: string;
        try {
          fullPath = resolveSafePath(filePath, context.cwd);
          originalContent = await fs.readFile(fullPath, 'utf8');
        } catch (err: any) {
          return {
            result: `Transaction aborted: Unable to read file "${filePath}": ${err.message}. ATOMIC ROLLBACK: 0 files modified on disk.`,
            isError: true
          };
        }

        let currentContent = originalContent;
        const strategies: string[] = [];

        for (let i = 0; i < hunks.length; i++) {
          const hunk = hunks[i];
          const editRes = MultiStrategyEditEngine.apply(
            currentContent,
            hunk.target_content,
            hunk.replacement_content,
            filePath
          );

          if (!editRes.success) {
            return {
              result: `Transaction aborted: Hunk #${i + 1} of ${hunks.length} failed for "${filePath}".\n${editRes.error || 'Target content not found.'}\n\nATOMIC ROLLBACK: 0 files modified on disk. All changes have been reverted.`,
              isError: true
            };
          }

          currentContent = editRes.content;
          strategies.push(editRes.strategyUsed || 'exact');
        }

        pendingWrites.set(filePath, {
          fullPath,
          originalContent,
          newContent: currentContent,
          strategies
        });
      }

      // Step 2.5: Optional syntax pre-validation via CodeVerifier
      const shouldValidateSyntax = Boolean(args.validate_syntax ?? args.validateSyntax);
      if (shouldValidateSyntax) {
        for (const [filePath, pending] of pendingWrites.entries()) {
          const diagnostics = CodeVerifier.verifyContentFast(filePath, pending.newContent);
          if (diagnostics.length > 0) {
            const firstErr = diagnostics[0];
            return {
              result: `Transaction aborted: Syntax error detected in "${filePath}" (line ${firstErr.line}): ${firstErr.message}.\n\nATOMIC ROLLBACK: 0 files modified on disk. All changes have been reverted.`,
              isError: true
            };
          }
        }
      }

      // Step 3: Atomic Commit Phase (all hunks in all files succeeded in-memory)
      const appliedSummaries: string[] = [];
      let totalHunks = 0;

      for (const [filePath, pending] of pendingWrites.entries()) {
        const hasCrlf = pending.originalContent.includes('\r\n');
        const finalContent = hasCrlf ? pending.newContent.replace(/\r?\n/g, '\r\n') : pending.newContent;

        await fs.writeFile(pending.fullPath, finalContent, 'utf8');
        if (context.contextEngine?.invalidateFile) {
          context.contextEngine.invalidateFile(filePath);
        }

        totalHunks += pending.strategies.length;
        const stratCounts: Record<string, number> = {};
        for (const s of pending.strategies) {
          stratCounts[s] = (stratCounts[s] || 0) + 1;
        }
        const stratSummary = Object.entries(stratCounts)
          .map(([strat, count]) => `${count} ${strat}`)
          .join(', ');

        appliedSummaries.push(`- ${filePath}: ${pending.strategies.length} edit(s) applied (${stratSummary})`);
      }

      const summary = `Successfully applied ${totalHunks} edit(s) across ${pendingWrites.size} file(s) atomically:\n` +
        appliedSummaries.join('\n');
      return { result: summary };
    } catch (err: any) {
      return {
        result: `Failed to execute multi_edit_file: ${err.message}. ATOMIC ROLLBACK: 0 files modified on disk.`,
        isError: true
      };
    }
  }
};
