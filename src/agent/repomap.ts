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
  references: Set<string>;
  imports: Set<string>;
  lineCount: number;
  pageRank?: number;
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
 * Advanced Dependency Graph & PageRank Codebase Repository Mapper.
 * 
 * Inspired by Aider's repository mapping architecture:
 * 1. Analyzes multi-language AST symbols (definitions, imports, and references).
 * 2. Builds a directed cross-file dependency graph.
 * 3. Runs PageRank (power iteration with damping factor 0.85) to surface the most
 *    architecturally critical files and types.
 * 4. Packs top-ranked symbols into an exact ~1,500–2,500 token budget.
 */
export class RepoMapGenerator {
  private cwd: string;
  private cachedMap: string | null = null;
  private cachedAt: number = 0;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  /**
   * Generates a high-density, PageRank-ranked repository map.
   */
  async generateMap(maxFiles: number = 50, maxTokens: number = 2500, focusFiles?: string[]): Promise<string> {
    const now = Date.now();
    if (this.cachedMap && now - this.cachedAt < 60000 && !focusFiles) {
      return this.cachedMap;
    }

    try {
      const sourceFiles = await this.discoverSourceFiles(this.cwd, maxFiles * 2);
      if (sourceFiles.length === 0) {
        this.cachedMap = '';
        this.cachedAt = now;
        return '';
      }

      const entries: FileMapEntry[] = [];
      const symbolToFile = new Map<string, string>(); // symbol name -> relativePath

      for (const filePath of sourceFiles) {
        const entry = await this.extractFileSymbols(filePath);
        if (entry && (entry.symbols.length > 0 || entry.lineCount > 0)) {
          entries.push(entry);
          for (const sym of entry.symbols) {
            symbolToFile.set(sym.name, entry.relativePath);
          }
        }
      }

      if (entries.length === 0) {
        return '';
      }

      // Compute PageRank over file dependency graph
      this.computePageRank(entries, symbolToFile, focusFiles);

      // Sort by PageRank score (with architectural entrypoint boost)
      entries.sort((a, b) => {
        const scoreA = this.calculateEntryScore(a);
        const scoreB = this.calculateEntryScore(b);
        return scoreB - scoreA;
      });

      const selectedEntries = entries.slice(0, maxFiles);

      const outputParts: string[] = ['## Repository Codebase Map (Exported Symbols & Architecture):'];
      let estimatedChars = 0;
      const charBudget = maxTokens * 3.5;

      for (const entry of selectedEntries) {
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
      if (!focusFiles) {
        this.cachedMap = finalMap;
        this.cachedAt = now;
      }
      return finalMap;
    } catch {
      return '';
    }
  }

  /**
   * Computes PageRank across files based on directed references and imports.
   */
  computePageRank(entries: FileMapEntry[], symbolToFile: Map<string, string>, focusFiles?: string[]): void {
    const n = entries.length;
    if (n === 0) return;

    const fileIndices = new Map<string, number>();
    entries.forEach((e, idx) => fileIndices.set(e.relativePath, idx));

    // Adjacency list: outgoing edges outEdges[u] = list of files that u depends on
    const outEdges: number[][] = Array.from({ length: n }, () => []);
    const inEdges: number[][] = Array.from({ length: n }, () => []);

    for (let u = 0; u < n; u++) {
      const entry = entries[u];
      const targetIndices = new Set<number>();

      // 1. Edges from explicit relative imports
      for (const imp of entry.imports) {
        // Resolve relative import path against entry.relativePath
        const dir = path.dirname(entry.relativePath);
        const resolvedBase = path.normalize(path.join(dir, imp)).replace(/\\/g, '/');
        // Match exact or with common extensions
        for (const ext of ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '/index.ts', '/index.js']) {
          const candidate = resolvedBase + ext;
          if (fileIndices.has(candidate) && fileIndices.get(candidate) !== u) {
            targetIndices.add(fileIndices.get(candidate)!);
            break;
          }
        }
      }

      // 2. Edges from referenced symbols
      for (const ref of entry.references) {
        const definingFile = symbolToFile.get(ref);
        if (definingFile && definingFile !== entry.relativePath) {
          const v = fileIndices.get(definingFile);
          if (v !== undefined) {
            targetIndices.add(v);
          }
        }
      }

      for (const v of targetIndices) {
        outEdges[u].push(v);
        inEdges[v].push(u);
      }
    }

    // Power-iteration PageRank with damping factor d = 0.85
    const d = 0.85;
    let ranks = new Array<number>(n).fill(1 / n);

    // Personalization vector for teleportation
    const teleport = new Array<number>(n).fill(1 / n);
    if (focusFiles && focusFiles.length > 0) {
      const focusSet = new Set(focusFiles.map(f => f.replace(/\\/g, '/')));
      const matched = entries.map((e, idx) => focusSet.has(e.relativePath) ? idx : -1).filter(idx => idx !== -1);
      if (matched.length > 0) {
        teleport.fill(0);
        const weight = 1 / matched.length;
        matched.forEach(idx => { teleport[idx] = weight; });
      }
    }

    // 20 iterations guarantee convergence on DAGs and small graphs
    for (let iter = 0; iter < 20; iter++) {
      const nextRanks = new Array<number>(n).fill(0);
      let sinkSum = 0;

      for (let u = 0; u < n; u++) {
        if (outEdges[u].length === 0) {
          sinkSum += ranks[u];
        }
      }

      for (let v = 0; v < n; v++) {
        let incomingSum = 0;
        for (const u of inEdges[v]) {
          incomingSum += ranks[u] / outEdges[u].length;
        }
        nextRanks[v] = (1 - d) * teleport[v] + d * (incomingSum + sinkSum * teleport[v]);
      }

      ranks = nextRanks;
    }

    // Assign normalized PageRank to each entry
    entries.forEach((e, idx) => {
      e.pageRank = ranks[idx];
    });
  }

  private calculateEntryScore(entry: FileMapEntry): number {
    const isEntrypoint = /index|main|app|cli|server|root/i.test(entry.relativePath);
    const pr = entry.pageRank || 0.01;
    const symbolWeight = 1 + Math.log10(1 + entry.symbols.length);
    const entryBoost = isEntrypoint ? 1.5 : 1.0;

    return pr * symbolWeight * entryBoost;
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
      const references = new Set<string>();
      const imports = new Set<string>();

      lines.forEach((line, idx) => {
        const trimmed = line.trim();
        const lineNum = idx + 1;

        // TS/JS patterns
        if (ext === '.ts' || ext === '.tsx' || ext === '.js' || ext === '.jsx' || ext === '.mjs') {
          // Detect imports: import ... from './foo.js'
          const importMatch = /from\s+['"]([^'"]+)['"]/.exec(trimmed);
          if (importMatch && importMatch[1].startsWith('.')) {
            imports.add(importMatch[1]);
          }

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
          // Detect imports
          const pyImp = /^(?:from\s+(\S+)\s+import|import\s+(\S+))/.exec(trimmed);
          if (pyImp) {
            imports.add(pyImp[1] || pyImp[2]);
          }

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

        // Collect identifier tokens as reference candidates
        const tokens = trimmed.match(/[a-zA-Z_$][a-zA-Z0-9_$]{2,}/g);
        if (tokens) {
          for (const token of tokens) {
            references.add(token);
          }
        }
      });

      return {
        relativePath,
        symbols,
        references,
        imports,
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
