import os from 'node:os';
import path from 'node:path';
import syncFs from 'node:fs';
import readline from 'node:readline';
import { theme } from '../ui/theme.js';
import type { ProviderType } from '../types.js';

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
  for (const key of ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GROQ_API_KEY', 'NVIDIA_API_KEY', 'NVAPI_KEY', 'APINEX_API_KEY']) {
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
    case 'apinex':
      return 'APINEX_API_KEY';
    case 'openrouter':
      return 'OPENROUTER_API_KEY';
    case 'groq':
      return 'GROQ_API_KEY';
    case 'nim':
    case 'nvidia':
      return 'NVIDIA_API_KEY';
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
    case 'apinex':
      return (process.env.APINEX_API_KEY || process.env.APINEX_KEY || '').trim() || undefined;
    case 'openrouter':
      return (process.env.OPENROUTER_API_KEY || '').trim() || undefined;
    case 'groq':
      return (process.env.GROQ_API_KEY || '').trim() || undefined;
    case 'nim':
    case 'nvidia':
      return (process.env.NVIDIA_API_KEY || process.env.NVAPI_KEY || '').trim() || undefined;
    case 'openai':
      return (process.env.OPENAI_API_KEY || '').trim() || undefined;
    default:
      return undefined;
  }
}

/**
 * Identifies the LLM provider based on API key structure and prefix conventions.
 */
export function identifyProviderFromApiKey(apiKey?: string): ProviderType | undefined {
  if (!apiKey || typeof apiKey !== 'string') return undefined;
  const key = apiKey.trim().replace(/^["']|["']$/g, '');
  if (!key) return undefined;

  // Google Gemini API keys start with "AIza"
  if (key.startsWith('AIza')) {
    return 'gemini';
  }

  // Anthropic Claude keys start with "sk-ant-"
  if (key.startsWith('sk-ant-')) {
    return 'anthropic';
  }

  // APINex keys start with "sk-apx" or "apx-"
  if (key.startsWith('sk-apx') || key.startsWith('apx-')) {
    return 'apinex';
  }

  // Groq keys start with "gsk_" or "gsk-"
  if (key.startsWith('gsk_') || key.startsWith('gsk-')) {
    return 'groq';
  }

  // OpenRouter keys start with "sk-or-" or "or-"
  if (key.startsWith('sk-or-') || key.startsWith('or-')) {
    return 'openrouter';
  }

  // NVIDIA NIM keys start with "nvapi-" or "nvapi_"
  if (key.startsWith('nvapi-') || key.startsWith('nvapi_')) {
    return 'nim';
  }

  // OpenAI keys start with "sk-proj-", "sk-svcacct-", "sk-admin-", or standard "sk-" (not anthropic, apinex, or openrouter)
  if (
    key.startsWith('sk-proj-') ||
    key.startsWith('sk-svcacct-') ||
    key.startsWith('sk-admin-') ||
    (key.startsWith('sk-') && !key.startsWith('sk-ant-') && !key.startsWith('sk-or-') && !key.startsWith('sk-apx'))
  ) {
    return 'openai';
  }

  return undefined;
}

/**
 * Safely masks an API key for display (e.g. "AIzaSy...****").
 */
export function maskApiKey(apiKey?: string): string {
  if (!apiKey) return '';
  const trimmed = apiKey.trim().replace(/^["']|["']$/g, '');
  if (trimmed.length <= 8) return '****';
  return `${trimmed.slice(0, 6)}...${trimmed.slice(-4)}`;
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
        const detectedProvider = identifyProviderFromApiKey(trimmed);
        const actualKeyName = detectedProvider && detectedProvider !== provider.toLowerCase()
          ? getEnvKeyNameForProvider(detectedProvider)
          : keyName;
        saveApiKeyToGlobalEnv(actualKeyName, trimmed);
        if (actualKeyName !== keyName) {
          saveApiKeyToGlobalEnv(keyName, trimmed);
        }
        console.log(`  ${theme.strong('✓')} Saved ${theme.accent(actualKeyName)} to ${theme.secondary(filePath)}\n`);
        resolve(trimmed);
      } else {
        resolve(undefined);
      }
    });
  });
}

export interface ExternalModelConfig {
  providerName: string;
  modelId: string;
  displayName?: string;
  baseURL?: string;
  apiKey?: string;
  contextLimit?: number;
  outputLimit?: number;
}

/**
 * Loads custom provider & model definitions from ~/.config/opencode/opencode.json
 * and ~/.locode/config.json for seamless cross-harness compatibility.
 */
export function loadOpenCodeConfig(): ExternalModelConfig[] {
  const candidates = [
    path.join(os.homedir(), '.config', 'opencode', 'opencode.json'),
    path.join(os.homedir(), '.locode', 'config.json')
  ];

  const configs: ExternalModelConfig[] = [];
  for (const cPath of candidates) {
    try {
      if (!syncFs.existsSync(cPath)) continue;
      const raw = syncFs.readFileSync(cPath, 'utf8');
      const json = JSON.parse(raw);
      if (!json || typeof json.provider !== 'object') continue;

      for (const [providerKey, pVal] of Object.entries<any>(json.provider)) {
        const baseURL = pVal.options?.baseURL;
        const apiKey = pVal.options?.apiKey;
        if (pVal.models && typeof pVal.models === 'object') {
          for (const [modelKey, mVal] of Object.entries<any>(pVal.models)) {
            configs.push({
              providerName: providerKey,
              modelId: modelKey,
              displayName: mVal.name,
              baseURL,
              apiKey,
              contextLimit: mVal.limit?.context,
              outputLimit: mVal.limit?.output
            });
          }
        }
      }
    } catch {}
  }
  return configs;
}
