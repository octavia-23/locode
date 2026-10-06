import fs from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import ignore from 'ignore';
import { execa } from 'execa';
import { ToolDefinition } from '../types.js';
import { resolveSafePath } from './security.js';

let rgAvailablePromise: Promise<boolean> | null = null;

async function checkRipgrep(): Promise<boolean> {
  if (rgAvailablePromise) return rgAvailablePromise;
  rgAvailablePromise = (async () => {
    try {
      const res = await execa('rg --version', { shell: true, timeout: 2000 });
      return res.exitCode === 0;
    } catch {
      return false;
    }
  })();
  return rgAvailablePromise;
}

export function isBinaryBuffer(buffer: Buffer): boolean {
  // Check first 1024 bytes for null bytes
  const checkLen = Math.min(buffer.length, 1024);
  for (let i = 0; i < checkLen; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

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
      const targetDir = resolveSafePath(relPath, context.cwd);
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

/**
 * Searches code using the pure JavaScript fallback with binary filtering and .gitignore support.
 */
export async function searchCodeFallback(
  patternStr: string,
  searchRoot: string,
  cwd: string,
  maxMatches: number = 100,
  fileGlob?: string | null
): Promise<string[]> {
  const ig = await getIgnoreFilter(cwd);
  const globPattern = fileGlob ? `**/${fileGlob}` : '**/*';
  const files = await fg([globPattern], {
    cwd: searchRoot,
    onlyFiles: true,
    dot: false
  });

  const results: string[] = [];
  let regex: RegExp;
  if (fileGlob) {
    // If searching by file glob, match any non-empty line
    regex = /./;
  } else {
    try {
      regex = new RegExp(patternStr, 'i');
    } catch {
      regex = new RegExp(patternStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    }
  }

  for (const file of files) {
    const fullPath = path.join(searchRoot, file);
    const relToCwd = path.relative(cwd, fullPath).replace(/\\/g, '/');
    if (ig.ignores(relToCwd)) continue;

    try {
      const buf = await fs.readFile(fullPath);
      if (isBinaryBuffer(buf)) {
        continue; // Safe binary file skip
      }
      const content = buf.toString('utf8');
      const lines = content.split('\n');

      for (let idx = 0; idx < lines.length; idx++) {
        const line = lines[idx];
        if (regex.test(line)) {
          results.push(`${relToCwd}:${idx + 1}: ${line.trim()}`);
          if (results.length >= maxMatches) {
            results.push(`... [Truncated at ${maxMatches} matches]`);
            return results;
          }
        }
      }
    } catch {
      // Skip unreadable files
    }
  }

  return results;
}

export const searchCodeTool: ToolDefinition = {
  name: 'search_code',
  description: 'Search workspace files for a text string or regex pattern (uses ripgrep when available, with portable JS fallback). Returns matching lines with line numbers.',
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
      let patternStr = (args.pattern || '').trim();
      const rawPath = args.path || '';
      
      // Reika Lesson: Small models often emit glob patterns as pattern (e.g. pattern="*.ts" or "*.json")
      // instead of putting them in path or searching for content.
      let fileGlobFilter: string | null = null;
      if (/^\*\.[a-zA-Z0-9_-]+$/.test(patternStr)) {
        fileGlobFilter = patternStr;
      }

      // Handle tilde paths or relative paths safely
      const searchRoot = rawPath ? resolveSafePath(rawPath.replace(/^~[\\/]/, ''), context.cwd) : context.cwd;
      const hasRg = await checkRipgrep();

      let results: string[] = [];

      if (hasRg) {
        try {
          const rgArgs = [
            '--line-number',
            '--heading',
            '--color', 'never',
            '--max-count', '100',
            '-i'
          ];

          if (fileGlobFilter) {
            rgArgs.push('--glob', fileGlobFilter);
            rgArgs.push('-e', '.');
          } else {
            rgArgs.push('-e', patternStr);
          }
          rgArgs.push(searchRoot);

          const res = await execa('rg', rgArgs, {
            cwd: context.cwd,
            reject: false,
            timeout: 10000
          });

          if (res.exitCode === 0 && res.stdout.trim()) {
            const rawLines = res.stdout.trim().split('\n');
            let currentFile = '';
            for (const line of rawLines) {
              if (!line.trim()) continue;
              const match = /^(\d+):(.*)$/.exec(line);
              if (match && currentFile) {
                const relFile = path.relative(context.cwd, currentFile).replace(/\\/g, '/');
                results.push(`${relFile}:${match[1]}: ${match[2].trim()}`);
              } else {
                currentFile = line.trim();
              }
              if (results.length >= 100) {
                results.push('[Search output truncated at 100 matches for context length - command succeeded]');
                break;
              }
            }
          }
        } catch {
          // Fall back to JS implementation if rg encounters an issue
          results = [];
        }
      }

      // If ripgrep wasn't available or produced empty/failed fallback
      if (!hasRg || results.length === 0) {
        results = await searchCodeFallback(fileGlobFilter || patternStr, searchRoot, context.cwd, 100, fileGlobFilter);
      }

      if (results.length === 0) {
        const pathNotice = rawPath ? ` in path "${rawPath}"` : '';
        return { result: `[Search completed: 0 matches found for pattern "${patternStr}"${pathNotice}. The query executed properly, but no matching text exists in the workspace.]` };
      }

      return { result: `Matches for "${patternStr}":\n` + results.join('\n') };
    } catch (err: any) {
      return { result: `Search failed to execute: ${err.message}`, isError: true };
    }
  }
};
