import fs from 'node:fs/promises';
import path from 'node:path';
import { ToolDefinition } from '../types.js';
import { resolveSafePath } from './security.js';

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
      const content = await fs.readFile(fullPath, 'utf8');
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
      
      const start = args.start_line ? Math.max(1, Math.min(args.start_line, lines.length)) : 1;
      const defaultEnd = Math.min(lines.length, start + 600);
      let end = args.end_line ? Math.min(lines.length, Math.max(start, args.end_line)) : defaultEnd;
      const maxWindow = 700;
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
      if (lines.length > 800) {
        header += `[NOTICE: Large file (${lines.length} lines). Do NOT paginate the entire file with view_file! Use 'search_code' to find the relevant function/variable, or 'view_file' with outline=true to see declarations, then proceed directly to 'edit_file']\n`;
      } else if (wasWindowCapped) {
        header += `[Window capped at ${maxWindow} lines. Do NOT page through the file. Use 'search_code' to locate specific functions or proceed directly to 'edit_file']\n`;
      } else if (end < lines.length && !args.end_line) {
        header += `[Context limit: output truncated at line ${end} of ${lines.length}. Use 'search_code' to locate specific functions or proceed directly to 'edit_file']\n`;
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

      const maxLines = args.max_lines_per_file || 200;
      const results: string[] = [];

      for (const p of paths.slice(0, 10)) { // limit to 10 files per batch
        try {
          const fullPath = resolveSafePath(p, context.cwd);
          const content = await fs.readFile(fullPath, 'utf8');
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
