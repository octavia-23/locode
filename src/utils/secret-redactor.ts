/**
 * Secret Redactor Utility
 * Enforces cloud privacy and secret-redaction policies at outgoing request boundaries.
 */

import path from 'node:path';

/**
 * Checks whether a file path points to an inherently sensitive configuration or secret store.
 */
export function isSensitiveFile(filePath: string): boolean {
  if (!filePath || typeof filePath !== 'string') return false;
  const base = path.basename(filePath).toLowerCase();

  // 1. Environment files (.env, .env.local, .env.production, etc.)
  if (base === '.env' || base.startsWith('.env.')) return true;

  // 2. Private key and certificate files
  if (/\.(pem|key|pkcs12|p12|pfx|jks|keystore)$/i.test(base)) return true;
  if (/^id_(rsa|dsa|ecdsa|ed25519)$/i.test(base)) return true;

  // 3. Known credential file basenames
  const sensitiveNames = [
    'credentials.json',
    'client_secret.json',
    'secrets.json',
    'auth.json',
    'token.json',
    '.npmrc',
    '.netrc',
    '.dockercfg'
  ];
  if (sensitiveNames.includes(base)) return true;
  if (base.startsWith('service-account') || base.startsWith('service_account')) return true;

  // 4. Known secret directory subpaths
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  if (normalized.includes('/.aws/credentials') || normalized.includes('/.docker/config.json')) return true;

  return false;
}

/**
 * Checks whether a structured property/key name indicates sensitive secret data.
 */
export function isSensitiveKeyName(key: string): boolean {
  if (!key || typeof key !== 'string') return false;
  return /secret|password|passwd|token|apikey|api_key|auth|credential|private_key|privatekey|signing_key|client_secret|access_key|accesskey|encryption_key|master_key|salt|hash/i.test(key);
}

/**
 * Redacts values for sensitive keys in structured JSON or Key-Value text (.env format).
 * Protects credentials without relying solely on known regex prefix patterns.
 */
export function redactStructuredContent(text: string): string {
  if (!text || typeof text !== 'string') return text;

  let result = text;

  // A. Redact JSON objects with sensitive key names
  try {
    const trimmed = text.trim();
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      const parsed = JSON.parse(text);
      const redactNode = (node: any): any => {
        if (Array.isArray(node)) return node.map(redactNode);
        if (node && typeof node === 'object') {
          const res: Record<string, any> = {};
          for (const [k, v] of Object.entries(node)) {
            if (isSensitiveKeyName(k) && typeof v === 'string') {
              res[k] = '[REDACTED_SECRET]';
            } else {
              res[k] = redactNode(v);
            }
          }
          return res;
        }
        return node;
      };
      const cleanObj = redactNode(parsed);
      return JSON.stringify(cleanObj, null, 2);
    }
  } catch {}

  // B. Redact Key-Value / .env assignment lines (e.g. DATABASE_PASSWORD=my_db_pass or export SECRET="foo")
  result = result.replace(
    /^([ \t]*(?:export[ \t]+)?)([a-zA-Z0-9_.-]*(?:secret|password|passwd|token|api_key|apikey|auth|credential|key|salt)[a-zA-Z0-9_.-]*)([ \t]*[:=][ \t]*)(?:(["'])(?:[\s\S]*?)\4|([^\r\n#]+))/gim,
    (_match, prefix, keyName, separator) => `${prefix}${keyName}${separator}"[REDACTED_SECRET]"`
  );

  return result;
}

/**
 * Redacts content from a sensitive file.
 */
export function redactSensitiveFileContent(filePath: string, content: string): string {
  if (!content) return content;
  // Apply structured parsing first
  let cleaned = redactStructuredContent(content);
  // Apply general secret redaction
  cleaned = redactSecrets(cleaned);
  return cleaned;
}

export function redactSecrets(text: string): string {
  if (!text || typeof text !== 'string') return text;

  let redacted = redactStructuredContent(text);

  // 1. Private keys
  redacted = redacted.replace(
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    '[REDACTED_SECRET]'
  );

  // 2. Specific API key patterns
  redacted = redacted.replace(/\bsk-ant-[a-zA-Z0-9_\-]{20,}\b/g, '[REDACTED_SECRET]');
  redacted = redacted.replace(/\bsk-(?:proj-)?[a-zA-Z0-9_\-]{20,}\b/g, '[REDACTED_SECRET]');
  redacted = redacted.replace(/\bAIza[0-9A-Za-z-_]{35}\b/g, '[REDACTED_SECRET]');
  redacted = redacted.replace(/\bgsk_[a-zA-Z0-9]{20,}\b/g, '[REDACTED_SECRET]');
  redacted = redacted.replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[a-zA-Z0-9]{36,}\b/g, '[REDACTED_SECRET]');
  redacted = redacted.replace(/\bgithub_pat_[a-zA-Z0-9_]{50,}\b/g, '[REDACTED_SECRET]');
  redacted = redacted.replace(/\bxox[baprs]-[0-9a-zA-Z]{10,48}\b/g, '[REDACTED_SECRET]');
  redacted = redacted.replace(/\b(?:AKIA|ABIA|ACCA|ASIA)[0-9A-Z]{16}\b/g, '[REDACTED_SECRET]');

  // 3. Authorization Bearer tokens
  redacted = redacted.replace(/\bBearer\s+[a-zA-Z0-9_\-\.]{15,}\b/gi, 'Bearer [REDACTED_SECRET]');

  // 4. Generic key/token/password assignments (e.g. password = "...", api_key: "...", Password: password = "...")
  redacted = redacted.replace(
    /\b(api[_-]?key|access[_-]?token|auth[_-]?token|secret|password|passwd)(?:\s*[:=]\s*(?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password|passwd))?\s*[:=]\s*(["']?)([^"'\s\r\n,;]{6,})\2/gi,
    (_match, key) => `${key} = "[REDACTED_SECRET]"`
  );

  return redacted;
}

/**
 * Recursively redacts secrets from any value (string, object, array).
 */
export function redactValue(val: any): any {
  if (typeof val === 'string') {
    return redactSecrets(val);
  }
  if (Array.isArray(val)) {
    return val.map(redactValue);
  }
  if (val && typeof val === 'object') {
    const result: Record<string, any> = {};
    for (const [k, v] of Object.entries(val)) {
      result[k] = redactValue(v);
    }
    return result;
  }
  return val;
}

export function redactSecretsFromMessages<T extends { content?: string; tool_calls?: any[] }>(messages: T[]): T[] {
  return messages.map(m => {
    let changed = false;
    let cleanContent = m.content;
    if (typeof m.content === 'string') {
      cleanContent = redactSecrets(m.content);
      if (cleanContent !== m.content) changed = true;
    }

    let cleanToolCalls = m.tool_calls;
    if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      cleanToolCalls = m.tool_calls.map(tc => {
        if (!tc?.function?.arguments) return tc;
        let args = tc.function.arguments;
        if (typeof args === 'string') {
          try {
            const parsed = JSON.parse(args);
            const redactedObj = redactValue(parsed);
            return {
              ...tc,
              function: {
                ...tc.function,
                arguments: JSON.stringify(redactedObj)
              }
            };
          } catch {
            return {
              ...tc,
              function: {
                ...tc.function,
                arguments: redactSecrets(args)
              }
            };
          }
        } else if (typeof args === 'object') {
          return {
            ...tc,
            function: {
              ...tc.function,
              arguments: redactValue(args)
            }
          };
        }
        return tc;
      });
      changed = true;
    }

    if (!changed) return m;

    return {
      ...m,
      content: cleanContent,
      tool_calls: cleanToolCalls
    };
  });
}
