import fs from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import ignore from 'ignore';
import { ToolDefinition } from '../types.js';

async function getIgnoreFilter(cwd: string) {
  const ig = ignore();
  ig.add([
    'node_modules',
    '.git',
    '.gemini',
    'dist',
    'build',
    '.next',
    '.turbo',
    'coverage',
    '*.log',
    '*.png',
    '*.jpg',
    '*.jpeg',
    '*.ico',
    '*.pdf',
    '*.lock',
    'package-lock.json'
  ]);

  try {
    const gitignorePath = path.join(cwd, '.gitignore');
    const gitignoreContent = await fs.readFile(gitignorePath, 'utf8');
    ig.add(gitignoreContent);
  } catch {
    // No .gitignore found, ignore
  }

  return ig;
}

export const listDirTool: ToolDefinition = {
  name: 'list_dir',
  description: 'List files and directories in the workspace. Supports recursive listing with max_depth (default: 2). Respects .gitignore.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Relative path of directory to list (default: ".")'
      },
      depth: {
        type: 'number',
        description: 'Maximum depth of recursion (default: 2)'
      }
    }
  },
  needsApproval: false,
  async execute(args, context) {
    try {
      const relPath = args.path || '.';
      const targetDir = path.resolve(context.cwd, relPath);
      const maxDepth = args.depth ?? 2;
      const ig = await getIgnoreFilter(context.cwd);

      const entries = await fg(['**/*'], {
        cwd: targetDir,
        deep: maxDepth,
        onlyFiles: false,
        markDirectories: true,
        dot: true
      });

      const filtered = entries.filter(item => {
        const fullRel = path.relative(context.cwd, path.join(targetDir, item)).replace(/\\/g, '/');
        return !ig.ignores(fullRel) && !ig.ignores(item);
      });

      if (filtered.length === 0) {
        return { result: `No visible files found in "${relPath}".` };
      }

      const output = [
        `Directory listing for "${relPath}" (depth: ${maxDepth}):`,
        ...filtered.slice(0, 100).map(f => `  ${f}`)
      ];

      if (filtered.length > 100) {
        output.push(`  ... and ${filtered.length - 100} more files (use search_code or narrower path)`);
      }

      return { result: output.join('\n') };
    } catch (err: any) {
      return { result: `Failed to list directory: ${err.message}`, isError: true };
    }
  }
};

export const searchCodeTool: ToolDefinition = {
  name: 'search_code',
  description: 'Search workspace files for a text string or regex pattern (like grep/ripgrep). Returns matching lines with line numbers.',
  parameters: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Text string or regex pattern to search for'
      },
      path: {
        type: 'string',
        description: 'Subdirectory or specific file pattern to limit search (optional)'
      }
    },
    required: ['pattern']
  },
  needsApproval: false,
  async execute(args, context) {
    try {
      const patternStr = args.pattern;
      const ig = await getIgnoreFilter(context.cwd);
      const searchRoot = args.path ? path.resolve(context.cwd, args.path) : context.cwd;

      const files = await fg(['**/*'], {
        cwd: searchRoot,
        onlyFiles: true,
        dot: false
      });

      const results: string[] = [];
      let regex: RegExp;
      try {
        regex = new RegExp(patternStr, 'i');
      } catch {
        regex = new RegExp(patternStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      }

      for (const file of files) {
        const fullPath = path.join(searchRoot, file);
        const relToCwd = path.relative(context.cwd, fullPath).replace(/\\/g, '/');
        if (ig.ignores(relToCwd)) continue;

        try {
          const content = await fs.readFile(fullPath, 'utf8');
          const lines = content.split('\n');

          lines.forEach((line, idx) => {
            if (regex.test(line)) {
              results.push(`${relToCwd}:${idx + 1}: ${line.trim()}`);
            }
          });
        } catch {
          // Skip binary or unreadable files
        }

        if (results.length > 100) {
          results.push(`... [Truncated at 100 matches]`);
          break;
        }
      }

      if (results.length === 0) {
        return { result: `No matches found for "${patternStr}".` };
      }

      return { result: `Matches for "${patternStr}":\n` + results.join('\n') };
    } catch (err: any) {
      return { result: `Search failed: ${err.message}`, isError: true };
    }
  }
};
