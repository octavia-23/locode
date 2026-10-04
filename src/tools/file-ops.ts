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
      const end = args.end_line ? Math.min(lines.length, Math.max(start, args.end_line)) : Math.min(lines.length, start + 300);

      const sliced = lines.slice(start - 1, end);
      const formatted = sliced
        .map((line, idx) => `${(start + idx).toString().padStart(4, ' ')}: ${line}`)
        .join('\n');

      let header = `File: ${args.path} (lines ${start}-${end} of ${lines.length})\n`;
      if (end < lines.length && !args.end_line) {
        header += `[Note: Truncated to line ${end}. Use start_line=${end + 1} to read more]\n`;
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
      
      const target = args.target_content;
      const replacement = args.replacement_content;

      // Check if target exists directly
      let newContent: string;
      if (existing.includes(target)) {
        // Single replacement check
        const firstIdx = existing.indexOf(target);
        const secondIdx = existing.indexOf(target, firstIdx + target.length);
        if (secondIdx !== -1) {
          return {
            result: `Target content appears multiple times in ${args.path}. Please provide a larger, unique block of context to replace.`,
            isError: true
          };
        }
        newContent = existing.replace(target, replacement);
      } else {
        // Fallback: normalize line endings (CRLF vs LF)
        const normalizedExisting = existing.replace(/\r\n/g, '\n');
        const normalizedTarget = target.replace(/\r\n/g, '\n');
        if (normalizedExisting.includes(normalizedTarget)) {
          const firstIdx = normalizedExisting.indexOf(normalizedTarget);
          const secondIdx = normalizedExisting.indexOf(normalizedTarget, firstIdx + normalizedTarget.length);
          if (secondIdx !== -1) {
            return {
              result: `Target content appears multiple times in ${args.path} (with normalized line breaks). Provide more surrounding context.`,
              isError: true
            };
          }
          newContent = normalizedExisting.replace(normalizedTarget, replacement.replace(/\r\n/g, '\n'));
        } else {
          return {
            result: `Target content not found in ${args.path}. Make sure the target text matches the file lines exactly (use view_file first to see current lines).`,
            isError: true
          };
        }
      }

      await fs.writeFile(fullPath, newContent, 'utf8');
      return { result: `Successfully updated ${args.path}` };
    } catch (err: any) {
      return { result: `Failed to edit file "${args.path}": ${err.message}`, isError: true };
    }
  }
};
