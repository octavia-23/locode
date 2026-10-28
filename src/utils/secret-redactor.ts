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

export function redactSecretsFromMessages<T extends { content?: string }>(messages: T[]): T[] {
  return messages.map(m => {
    if (!m.content || typeof m.content !== 'string') return m;
    const cleanContent = redactSecrets(m.content);
    if (cleanContent === m.content) return m;
    return {
      ...m,
      content: cleanContent
    };
  });
}
