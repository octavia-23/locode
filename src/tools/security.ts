import path from 'node:path';
import fs from 'node:fs/promises';
import { AgentContext } from '../types.js';

export interface SecurityPolicy {
  allowedWorkspaceRoot: string;
  allowOutsideWorkspace?: boolean;
  blockedCommands?: RegExp[];
  maxFileReadBytes?: number;
  maxWebResponseBytes?: number;
}

const DEFAULT_BLOCKED_COMMANDS: RegExp[] = [
  // Destructive disk / formatting
  /\b(mkfs|fdisk|parted|format)\b/i,
  // System shutdown / reboot
  /\b(shutdown|reboot|init\s+0|halt)\b/i,
  // Unrestricted rm -rf of root / wildcards
  /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*|--recursive\s+--force)\s+[/~]/i,
  // Windows equivalents of destructive operations
  /\b(format\s+[a-zA-Z]:|rd\s+\/s\s+\/q\s+[\\\/]|del\s+\/f\s+\/s\s+\/q\s+[\\\/])/i,
  // Destructive git commands that wipe everything without rollback
  /\bgit\s+clean\s+-[a-zA-Z]*x/i
];

/**
 * Validates and resolves a file path against the configured workspace.
 * Throws an error or returns a clean path preventing directory traversal.
 */
export function resolveSafePath(filePath: string, cwd: string, allowOutside: boolean = false): string {
  const resolved = path.isAbsolute(filePath) ? path.normalize(filePath) : path.normalize(path.resolve(cwd, filePath));
  const normalizedCwd = path.normalize(path.resolve(cwd));

  if (allowOutside) {
    return resolved;
  }

  // Windows drive check or case-insensitive prefix handling
  const isWindows = process.platform === 'win32';
  const targetLower = isWindows ? resolved.toLowerCase() : resolved;
  const cwdLower = isWindows ? normalizedCwd.toLowerCase() : normalizedCwd;

  const isInside = targetLower === cwdLower || targetLower.startsWith(cwdLower + path.sep);

  if (!isInside) {
    throw new Error(`Security Violation: Path "${filePath}" resolves outside the allowed workspace (${cwd}).`);
  }

  return resolved;
}

/**
 * Checks whether a command string is deemed dangerous or requires high-level confirmation.
 */
export function isDangerousCommand(command: string): { dangerous: boolean; reason?: string } {
  const trimmed = command.trim();

  for (const pattern of DEFAULT_BLOCKED_COMMANDS) {
    if (pattern.test(trimmed)) {
      return { dangerous: true, reason: `Command matches critical security blocklist: ${pattern}` };
    }
  }

  // High-risk command patterns that always require approval
  const dangerousPatterns = [
    { pattern: /\b(rm|del|rd|rmdir)\b/i, reason: 'File deletion command' },
    { pattern: /\bgit\s+(reset\s+--hard|clean\s+-fd|push\s+--force)/i, reason: 'Destructive Git operation' },
    { pattern: /\b(chmod|chown|attrib)\b/i, reason: 'Permission/Attribute modification' },
    { pattern: /\b(curl|wget)\b.*\|\s*(sh|bash|powershell|cmd)/i, reason: 'Piped remote script execution' },
    { pattern: /\b(npm\s+publish|pnpm\s+publish|yarn\s+publish)\b/i, reason: 'Package publish operation' },
  ];

  for (const item of dangerousPatterns) {
    if (item.pattern.test(trimmed)) {
      return { dangerous: true, reason: item.reason };
    }
  }

  return { dangerous: false };
}

/**
 * Audits a URL against SSRF targets (localhost, link-local, private ranges, cloud metadata).
 */
export function isSsrfSafeUrl(rawUrl: string): { safe: boolean; reason?: string } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { safe: false, reason: 'Malformed URL' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { safe: false, reason: `Unsupported protocol: ${parsed.protocol}` };
  }

  const hostname = parsed.hostname.toLowerCase();

  // Localhost checks
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '0.0.0.0'
  ) {
    return { safe: false, reason: 'SSRF Protection: Requests to localhost and loopback interfaces are blocked.' };
  }

  // Cloud metadata services
  if (
    hostname === '169.254.169.254' || // AWS / GCP / Azure metadata IP
    hostname === 'metadata.google.internal' ||
    hostname === 'metadata'
  ) {
    return { safe: false, reason: 'SSRF Protection: Requests to cloud metadata endpoints are strictly blocked.' };
  }

  // Private IPv4 ranges (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16)
  const ipv4Match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (ipv4Match) {
    const octets = ipv4Match.slice(1, 5).map(Number);
    const [o1, o2] = octets;

    if (o1 === 10) {
      return { safe: false, reason: 'SSRF Protection: Requests to private IP range 10.0.0.0/8 are blocked.' };
    }
    if (o1 === 172 && o2 >= 16 && o2 <= 31) {
      return { safe: false, reason: 'SSRF Protection: Requests to private IP range 172.16.0.0/12 are blocked.' };
    }
    if (o1 === 192 && o2 === 168) {
      return { safe: false, reason: 'SSRF Protection: Requests to private IP range 192.168.0.0/16 are blocked.' };
    }
    if (o1 === 169 && o2 === 254) {
      return { safe: false, reason: 'SSRF Protection: Requests to link-local IP range 169.254.0.0/16 are blocked.' };
    }
  }

  return { safe: true };
}
