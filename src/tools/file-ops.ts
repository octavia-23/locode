import fs from 'node:fs/promises';
import path from 'node:path';
import { ToolDefinition } from '../types.js';
import { resolveSafePath } from './security.js';

export const viewFileTool: ToolDefinition = {
  name: 'view_file',
  description: 'View the contents of a file with line numbers. You can specify start_line and end_line (1-indexed).',
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
      }
    },
    required: ['path']
  },
  needsApproval: false,
  async execute(args, context) {
    try {
      const fullPath = resolveSafePath(args.path, context.cwd);
      const content = await fs.readFile(fullPath, 'utf8');
      const lines = content.split('\n');
      
      const start = args.start_line ? Math.max(1, Math.min(args.start_line, lines.length)) : 1;
      const defaultEnd = Math.min(lines.length, start + 250);
      let end = args.end_line ? Math.min(lines.length, Math.max(start, args.end_line)) : defaultEnd;
      const maxWindow = 350;
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
      if (wasWindowCapped) {
        header += `[Window capped at ${maxWindow} lines to preserve context - read succeeded. Use start_line=${end + 1} to inspect further lines]\n`;
      } else if (end < lines.length && !args.end_line) {
        header += `[Context limit: output truncated at line ${end} of ${lines.length} - read succeeded. Use start_line=${end + 1} if you need further lines]\n`;
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
      
      let target = args.target_content;
      let replacement = args.replacement_content;

      // Smart cleanup: If the model accidentally included view_file line numbers (e.g. "   1: " or "12 | "), strip them!
      const stripLineNumbers = (text: string): string => {
        const lines = text.split('\n');
        const hasLineNumbers = lines.length > 0 && lines.every(l => !l.trim() || /^\s*\d+[:|]\s*/.test(l));
        if (hasLineNumbers) {
          return lines.map(l => l.replace(/^\s*\d+[:|]\s?/, '')).join('\n');
        }
        return text;
      };

      const cleanTarget = stripLineNumbers(target);
      const cleanReplacement = stripLineNumbers(replacement);

      // Helper function to find and replace in text with CRLF normalization
      const attemptReplace = (fileText: string, searchTarget: string, searchReplacement: string): string | null => {
        const normFile = fileText.replace(/\r\n/g, '\n');
        const normTarget = searchTarget.replace(/\r\n/g, '\n');
        const normReplacement = searchReplacement.replace(/\r\n/g, '\n');

        if (normFile.includes(normTarget)) {
          const firstIdx = normFile.indexOf(normTarget);
          const secondIdx = normFile.indexOf(normTarget, firstIdx + normTarget.length);
          if (secondIdx !== -1) {
            throw new Error(`Target content appears multiple times in ${args.path}. Please provide a larger, unique block of context to replace.`);
          }
          return normFile.replace(normTarget, normReplacement);
        }

        // Fuzzy fallback: line-by-line whitespace-trimmed matching
        const fileLines = normFile.split('\n');
        const targetLines = normTarget.split('\n');

        if (targetLines.length > 0) {
          const trimmedTarget = targetLines.map(l => l.trim());
          for (let i = 0; i <= fileLines.length - targetLines.length; i++) {
            let matches = true;
            for (let j = 0; j < targetLines.length; j++) {
              if (fileLines[i + j].trim() !== trimmedTarget[j]) {
                matches = false;
                break;
              }
            }
            if (matches) {
              // Found matched block! Replace this exact range of lines
              const before = fileLines.slice(0, i);
              const after = fileLines.slice(i + targetLines.length);
              return [...before, normReplacement, ...after].join('\n');
            }
          }
        }

        return null;
      };

      let newContent: string | null = null;
      try {
        // Try with original target first
        newContent = attemptReplace(existing, target, replacement);
        // If not found, try with line numbers stripped
        if (!newContent && (cleanTarget !== target || cleanReplacement !== replacement)) {
          newContent = attemptReplace(existing, cleanTarget, cleanReplacement);
        }
      } catch (err: any) {
        return { result: err.message, isError: true };
      }

      if (!newContent) {
        return {
          result: `Target content not found in ${args.path}. Make sure the target text matches the file lines exactly (use view_file first to see current lines, without copying line numbers).`,
          isError: true
        };
      }

      await fs.writeFile(fullPath, newContent, 'utf8');
      if (context.contextEngine?.invalidateFile) {
        context.contextEngine.invalidateFile(args.path);
      }
      return { result: `Successfully updated ${args.path}` };
    } catch (err: any) {
      return { result: `Failed to edit file "${args.path}": ${err.message}`, isError: true };
    }
  }
};
