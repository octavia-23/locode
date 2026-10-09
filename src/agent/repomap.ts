import fs from 'node:fs/promises';
import path from 'node:path';

export interface FileSymbol {
  kind: 'function' | 'class' | 'interface' | 'type' | 'component' | 'const';
  name: string;
  signature?: string;
  line: number;
}

export interface FileMapEntry {
  relativePath: string;
  symbols: FileSymbol[];
  lineCount: number;
}

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.next',
  '.turbo',
  '.nuxt',
  'coverage',
  '.cache',
  '.locode',
  'target',
  'vendor',
  '__pycache__'
]);

const CODE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.py',
  '.rs',
  '.go'
]);

/**
 * Fast AST-style Symbol Extractor and Repository Map Generator.
 * 
 * Provides global codebase structure and exported symbol signatures
 * in ~1,000–2,000 tokens, eliminating the need for dozens of blind view_file turns.
 */
export class RepoMapGenerator {
  private cwd: string;
  private cachedMap: string | null = null;
  private cachedAt: number = 0;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  /**
   * Generates a high-density, concise symbol map of the repository.
   */
  async generateMap(maxFiles: number = 50, maxTokens: number = 2500): Promise<string> {
    const now = Date.now();
    if (this.cachedMap && now - this.cachedAt < 60000) {
      return this.cachedMap;
    }

    try {
      const sourceFiles = await this.discoverSourceFiles(this.cwd, maxFiles);
      if (sourceFiles.length === 0) {
        this.cachedMap = '';
        this.cachedAt = now;
        return '';
      }

      const entries: FileMapEntry[] = [];
      for (const filePath of sourceFiles) {
        const entry = await this.extractFileSymbols(filePath);
        if (entry && (entry.symbols.length > 0 || entry.lineCount > 0)) {
          entries.push(entry);
        }
      }

      // Prioritize entrypoints and high-symbol files
      entries.sort((a, b) => {
        const isEntryA = /index|main|app|cli|server|root/i.test(a.relativePath);
        const isEntryB = /index|main|app|cli|server|root/i.test(b.relativePath);
        if (isEntryA && !isEntryB) return -1;
        if (!isEntryA && isEntryB) return 1;
        return b.symbols.length - a.symbols.length;
      });

      const outputParts: string[] = ['## Repository Codebase Map (Exported Symbols & Architecture):'];
      let estimatedChars = 0;
      const charBudget = maxTokens * 3.5;

      for (const entry of entries) {
        let fileLine = `• ${entry.relativePath} (${entry.lineCount} lines)`;
        if (entry.symbols.length > 0) {
          const syms = entry.symbols
            .slice(0, 10)
            .map(s => `    ${s.kind} ${s.name}${s.signature ? `(${s.signature})` : ''}`)
            .join('\n');
          fileLine += `:\n${syms}`;
          if (entry.symbols.length > 10) {
            fileLine += `\n    ... [${entry.symbols.length - 10} more symbols]`;
          }
        }

        if (estimatedChars + fileLine.length > charBudget) {
          outputParts.push(`  ... [${entries.length - outputParts.length + 1} additional files indexed in project]`);
          break;
        }

        outputParts.push(fileLine);
        estimatedChars += fileLine.length + 2;
      }

      const finalMap = outputParts.join('\n');
      this.cachedMap = finalMap;
      this.cachedAt = now;
      return finalMap;
    } catch {
      return '';
    }
  }

  private async discoverSourceFiles(dir: string, limit: number): Promise<string[]> {
    const results: string[] = [];

    const walk = async (currentDir: string) => {
      if (results.length >= limit) return;
      try {
        const dirents = await fs.readdir(currentDir, { withFileTypes: true });
        for (const dirent of dirents) {
          if (results.length >= limit) break;
          const name = dirent.name;
          if (name.startsWith('.') || IGNORED_DIRS.has(name)) continue;

          const fullPath = path.join(currentDir, name);
          if (dirent.isDirectory()) {
            await walk(fullPath);
          } else if (dirent.isFile()) {
            const ext = path.extname(name).toLowerCase();
            if (CODE_EXTENSIONS.has(ext)) {
              results.push(fullPath);
            }
          }
        }
      } catch {}
    };

    await walk(dir);
    return results;
  }

  private async extractFileSymbols(fullPath: string): Promise<FileMapEntry | null> {
    try {
      const content = await fs.readFile(fullPath, 'utf8');
      const lines = content.split('\n');
      const relativePath = path.relative(this.cwd, fullPath).replace(/\\/g, '/');
      const ext = path.extname(fullPath).toLowerCase();
      const symbols: FileSymbol[] = [];

      lines.forEach((line, idx) => {
        const trimmed = line.trim();
        const lineNum = idx + 1;

        // TS/JS patterns
        if (ext === '.ts' || ext === '.tsx' || ext === '.js' || ext === '.jsx' || ext === '.mjs') {
          // Export functions
          const fnMatch = /^(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+([a-zA-Z0-9_$]+)\s*\(([^)]*)\)/.exec(trimmed);
          if (fnMatch) {
            symbols.push({
              kind: 'function',
              name: fnMatch[1],
              signature: this.cleanParams(fnMatch[2]),
              line: lineNum
            });
            return;
          }

          // Export classes
          const classMatch = /^(?:export\s+(?:default\s+)?)?class\s+([a-zA-Z0-9_$]+)/.exec(trimmed);
          if (classMatch) {
            symbols.push({
              kind: 'class',
              name: classMatch[1],
              line: lineNum
            });
            return;
          }

          // Export interfaces & types
          const ifaceMatch = /^export\s+interface\s+([a-zA-Z0-9_$]+)/.exec(trimmed);
          if (ifaceMatch) {
            symbols.push({
              kind: 'interface',
              name: ifaceMatch[1],
              line: lineNum
            });
            return;
          }

          const typeMatch = /^export\s+type\s+([a-zA-Z0-9_$]+)/.exec(trimmed);
          if (typeMatch) {
            symbols.push({
              kind: 'type',
              name: typeMatch[1],
              line: lineNum
            });
            return;
          }

          // Export const arrow / React components
          const constMatch = /^export\s+const\s+([a-zA-Z0-9_$]+)\s*=\s*(?:async\s*)?\(([^)]*)\)/.exec(trimmed);
          if (constMatch) {
            symbols.push({
              kind: 'const',
              name: constMatch[1],
              signature: this.cleanParams(constMatch[2]),
              line: lineNum
            });
            return;
          }
        }

        // Python patterns
        if (ext === '.py') {
          const pyClass = /^class\s+([a-zA-Z0-9_]+)/.exec(trimmed);
          if (pyClass) {
            symbols.push({ kind: 'class', name: pyClass[1], line: lineNum });
            return;
          }
          const pyFn = /^(?:async\s+)?def\s+([a-zA-Z0-9_]+)\s*\(([^)]*)\):/.exec(trimmed);
          if (pyFn) {
            symbols.push({ kind: 'function', name: pyFn[1], signature: this.cleanParams(pyFn[2]), line: lineNum });
            return;
          }
        }

        // Rust patterns
        if (ext === '.rs') {
          const rsFn = /^pub\s+(?:async\s+)?fn\s+([a-zA-Z0-9_]+)\s*\(([^)]*)\)/.exec(trimmed);
          if (rsFn) {
            symbols.push({ kind: 'function', name: rsFn[1], signature: this.cleanParams(rsFn[2]), line: lineNum });
            return;
          }
          const rsStruct = /^pub\s+(?:struct|enum|trait)\s+([a-zA-Z0-9_]+)/.exec(trimmed);
          if (rsStruct) {
            symbols.push({ kind: 'interface', name: rsStruct[1], line: lineNum });
            return;
          }
        }

        // Go patterns
        if (ext === '.go') {
          const goFn = /^func\s+([a-zA-Z0-9_]+)\s*\(([^)]*)\)/.exec(trimmed);
          if (goFn) {
            symbols.push({ kind: 'function', name: goFn[1], signature: this.cleanParams(goFn[2]), line: lineNum });
            return;
          }
        }
      });

      return {
        relativePath,
        symbols,
        lineCount: lines.length
      };
    } catch {
      return null;
    }
  }

  private cleanParams(params: string): string {
    const cleaned = params.replace(/\s+/g, ' ').trim();
    if (cleaned.length > 50) {
      return cleaned.slice(0, 47) + '...';
    }
    return cleaned;
  }
}
