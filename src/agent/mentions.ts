import fs from 'node:fs/promises';
import path from 'node:path';

export interface MentionResolution {
  processedPrompt: string;
  injectedFiles: string[];
  contextBlock: string;
}

export async function resolveFileMentions(prompt: string, cwd: string): Promise<MentionResolution> {
  // Regex to match @filepath patterns (e.g. @src/cli.ts, @./README.md, @"path with spaces/file.ts")
  const mentionRegex = /@(?:"([^"]+)"|([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]+))/g;

  const matches: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = mentionRegex.exec(prompt)) !== null) {
    const rawPath = match[1] || match[2];
    if (rawPath && !matches.includes(rawPath)) {
      matches.push(rawPath);
    }
  }

  if (matches.length === 0) {
    return {
      processedPrompt: prompt,
      injectedFiles: [],
      contextBlock: ''
    };
  }

  const injectedFiles: string[] = [];
  const fileContents: string[] = [];

  for (const relPath of matches) {
    const fullPath = path.isAbsolute(relPath) ? relPath : path.resolve(cwd, relPath);
    try {
      const stat = await fs.stat(fullPath);
      if (stat.isFile()) {
        const content = await fs.readFile(fullPath, 'utf8');
        // Cap single file mention at 600 lines to preserve context window
        const lines = content.split('\n');
        const truncated = lines.slice(0, 600).join('\n');
        const note = lines.length > 600 ? `\n... [truncated ${lines.length - 600} lines]` : '';

        fileContents.push(`### File: ${relPath}\n\`\`\`\n${truncated}${note}\n\`\`\``);
        injectedFiles.push(relPath);
      }
    } catch {
      // File not found or unreadable, ignore
    }
  }

  const contextBlock = fileContents.length > 0
    ? `\n\n[Referenced Files Context]:\n${fileContents.join('\n\n')}\n`
    : '';

  return {
    processedPrompt: prompt + contextBlock,
    injectedFiles,
    contextBlock
  };
}
