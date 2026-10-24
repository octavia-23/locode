import os from 'node:os';
import path from 'node:path';
import syncFs from 'node:fs';
import readline from 'node:readline';
import { theme } from '../ui/theme.js';

export function getGlobalConfigDir(): string {
  return path.join(os.homedir(), '.locode');
}

export function getGlobalEnvPath(): string {
  return path.join(getGlobalConfigDir(), '.env');
}

/**
 * Loads environment variables from ~/.locode/.env, workspace .env, and .env.local
 */
export function loadEnvironmentVariables(cwd: string): void {
  const envCandidates = [
    getGlobalEnvPath(),
    path.join(cwd, '.env'),
    path.join(cwd, '.env.local')
  ];

  for (const envPath of envCandidates) {
    try {
      if (syncFs.existsSync(envPath) && typeof process.loadEnvFile === 'function') {
        process.loadEnvFile(envPath);
      }
    } catch {}
  }

  // Clean empty-string values (e.g. KEY="" in .env shouldn't count as a defined key)
  for (const key of ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GROQ_API_KEY']) {
    if (process.env[key] !== undefined && process.env[key]!.trim() === '') {
      delete process.env[key];
    }
  }
}

export function getEnvKeyNameForProvider(provider: string): string {
  switch (provider.toLowerCase()) {
    case 'gemini':
      return 'GEMINI_API_KEY';
    case 'anthropic':
      return 'ANTHROPIC_API_KEY';
    case 'openrouter':
      return 'OPENROUTER_API_KEY';
    case 'groq':
      return 'GROQ_API_KEY';
    case 'openai':
    default:
      return 'OPENAI_API_KEY';
  }
}

export function getApiKeyForProvider(provider: string, explicitKey?: string): string | undefined {
  if (explicitKey && explicitKey.trim() && explicitKey !== 'not-needed') {
    return explicitKey.trim();
  }

  switch (provider.toLowerCase()) {
    case 'gemini':
      return (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim() || undefined;
    case 'anthropic':
      return (process.env.ANTHROPIC_API_KEY || '').trim() || undefined;
    case 'openrouter':
      return (process.env.OPENROUTER_API_KEY || '').trim() || undefined;
    case 'groq':
      return (process.env.GROQ_API_KEY || '').trim() || undefined;
    case 'openai':
      return (process.env.OPENAI_API_KEY || '').trim() || undefined;
    default:
      return undefined;
  }
}

export function saveApiKeyToGlobalEnv(keyName: string, keyValue: string): void {
  const dir = getGlobalConfigDir();
  const filePath = getGlobalEnvPath();

  try {
    if (!syncFs.existsSync(dir)) {
      syncFs.mkdirSync(dir, { recursive: true });
    }

    let content = '';
    if (syncFs.existsSync(filePath)) {
      content = syncFs.readFileSync(filePath, 'utf8');
    }

    const regex = new RegExp(`^#?\\s*${keyName}\\s*=.*$`, 'm');
    const newLine = `${keyName}="${keyValue.trim()}"`;

    if (regex.test(content)) {
      content = content.replace(regex, newLine);
    } else {
      content = content ? `${content.trimEnd()}\n${newLine}\n` : `${newLine}\n`;
    }

    syncFs.writeFileSync(filePath, content, 'utf8');
    process.env[keyName] = keyValue.trim();
  } catch (err: any) {
    console.error(`Warning: Failed to save API key to ${filePath}: ${err.message}`);
  }
}

export async function promptAndSaveApiKey(
  provider: string
): Promise<string | undefined> {
  const keyName = getEnvKeyNameForProvider(provider);
  const filePath = getGlobalEnvPath();

  console.log(`\n  ${theme.diamond} ${theme.strong(`Setup ${provider.toUpperCase()} API Key`)}`);
  console.log(`  ${theme.muted(`No active ${keyName} detected in environment or ${filePath}.`)}\n`);

  if (!process.stdin.isTTY) {
    return undefined;
  }

  return new Promise<string | undefined>((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    rl.question(`  ${theme.promptGlyph} Enter ${theme.accent(keyName)}: `, (answer) => {
      rl.close();
      const trimmed = answer.trim();
      if (trimmed) {
        saveApiKeyToGlobalEnv(keyName, trimmed);
        console.log(`  ${theme.strong('✓')} Saved ${theme.accent(keyName)} to ${theme.secondary(filePath)}\n`);
        resolve(trimmed);
      } else {
        resolve(undefined);
      }
    });
  });
}
