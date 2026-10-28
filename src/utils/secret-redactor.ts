/**
 * Secret Redactor Utility
 * Enforces cloud privacy and secret-redaction policies at outgoing request boundaries.
 */

export function redactSecrets(text: string): string {
  if (!text || typeof text !== 'string') return text;

  let redacted = text;

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
