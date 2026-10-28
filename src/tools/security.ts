import path from 'node:path';
import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import dns from 'node:dns/promises';
import net from 'node:net';
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
 * Throws an error or returns a clean path preventing directory traversal,
 * symlink escapes, junction escapes, and unauthorized outside writes.
 */
export function resolveSafePath(filePath: string, cwd: string, allowOutside: boolean = false): string {
  const normalizedCwd = path.normalize(path.resolve(cwd));
  const resolved = path.isAbsolute(filePath)
    ? path.normalize(filePath)
    : path.normalize(path.resolve(normalizedCwd, filePath));

  if (allowOutside) {
    return resolved;
  }

  // Windows drive check or case-insensitive prefix handling
  const isWindows = process.platform === 'win32';
  const isLexicallyInside = (target: string, base: string) => {
    const tNorm = isWindows ? target.toLowerCase() : target;
    const bNorm = isWindows ? base.toLowerCase() : base;
    return tNorm === bNorm || tNorm.startsWith(bNorm.endsWith(path.sep) ? bNorm : bNorm + path.sep);
  };

  if (!isLexicallyInside(resolved, normalizedCwd)) {
    throw new Error(`Security Violation: Path "${filePath}" resolves outside the allowed workspace (${cwd}).`);
  }

  // Verify real filesystem containment (symlinks, junctions) if workspace exists on disk
  if (syncFs.existsSync(normalizedCwd)) {
    let realCwd: string;
    try {
      realCwd = syncFs.realpathSync.native ? syncFs.realpathSync.native(normalizedCwd) : syncFs.realpathSync(normalizedCwd);
    } catch {
      realCwd = normalizedCwd;
    }

    try {
      const lstat = syncFs.lstatSync(resolved);
      if (lstat.isSymbolicLink()) {
        let linkTarget = syncFs.readlinkSync(resolved);
        if (!path.isAbsolute(linkTarget)) {
          linkTarget = path.resolve(path.dirname(resolved), linkTarget);
        }
        let realLinkTarget: string;
        try {
          realLinkTarget = syncFs.realpathSync.native ? syncFs.realpathSync.native(linkTarget) : syncFs.realpathSync(linkTarget);
        } catch {
          realLinkTarget = path.normalize(linkTarget);
        }
        if (!isLexicallyInside(realLinkTarget, realCwd)) {
          throw new Error(`Security Violation: Path "${filePath}" resolves via symlink outside the allowed workspace (${cwd}). Target: ${realLinkTarget}`);
        }
      }

      const realTarget = syncFs.realpathSync.native ? syncFs.realpathSync.native(resolved) : syncFs.realpathSync(resolved);
      if (!isLexicallyInside(realTarget, realCwd)) {
        throw new Error(`Security Violation: Path "${filePath}" resolves via symlink outside the allowed workspace (${cwd}). Target: ${realTarget}`);
      }
    } catch (err: any) {
      if (err.message?.includes('Security Violation')) {
        throw err;
      }
      if (err.code === 'ENOENT') {
        // Target does not exist yet (e.g. write_file creating a new file)
        // Inspect the deepest existing ancestor directory to ensure no intermediate symlink escapes
        let ancestor = path.dirname(resolved);
        while (ancestor && ancestor !== path.dirname(ancestor)) {
          if (syncFs.existsSync(ancestor)) {
            try {
              const realAncestor = syncFs.realpathSync.native ? syncFs.realpathSync.native(ancestor) : syncFs.realpathSync(ancestor);
              if (!isLexicallyInside(realAncestor, realCwd)) {
                throw new Error(`Security Violation: Path "${filePath}" resolves via symlink outside the allowed workspace (${cwd}). Ancestor target: ${realAncestor}`);
              }
            } catch (aErr: any) {
              if (aErr.message?.includes('Security Violation')) throw aErr;
            }
            break;
          }
          ancestor = path.dirname(ancestor);
        }
      }
    }
  }

  return resolved;
}

export type CommandSecurityDecision = 'allow' | 'ask' | 'deny';

export interface CommandSecurityEvaluation {
  decision: CommandSecurityDecision;
  dangerous: boolean;
  reason?: string;
}

/**
 * Classifies a command into an explicit security decision:
 * - 'deny': unconditionally prohibited command (e.g. format disk, rm -rf /, shutdown). Never executed.
 * - 'ask': high-risk command requiring explicit user confirmation.
 * - 'allow': normal development command allowed if other checks pass.
 */
export function classifyCommandSecurity(command: string): CommandSecurityEvaluation {
  const trimmed = command.trim();

  // 1. Unconditional DENY list: Truly prohibited commands that must NEVER execute
  // Cannot be bypassed by --auto, profile overrides, or approval handlers.
  for (const pattern of DEFAULT_BLOCKED_COMMANDS) {
    if (pattern.test(trimmed)) {
      return {
        decision: 'deny',
        dangerous: true,
        reason: `Command is prohibited by critical security blocklist: ${pattern}`
      };
    }
  }

  // 2. ASK list: High-risk command patterns that require explicit user approval
  const dangerousPatterns = [
    { pattern: /\b(rm|del|rd|rmdir)\b/i, reason: 'File deletion command' },
    { pattern: /\bgit\s+(reset\s+--hard|clean\s+-fd|push\s+--force)/i, reason: 'Destructive Git operation' },
    { pattern: /\b(chmod|chown|attrib)\b/i, reason: 'Permission/Attribute modification' },
    { pattern: /\b(curl|wget)\b.*\|\s*(sh|bash|powershell|cmd)/i, reason: 'Piped remote script execution' },
    { pattern: /\b(npm\s+publish|pnpm\s+publish|yarn\s+publish)\b/i, reason: 'Package publish operation' },
  ];

  for (const item of dangerousPatterns) {
    if (item.pattern.test(trimmed)) {
      return { decision: 'ask', dangerous: true, reason: item.reason };
    }
  }

  return { decision: 'allow', dangerous: false };
}

/**
 * Checks whether a command string is deemed dangerous or requires high-level confirmation.
 * Preserves backwards compatibility while utilizing explicit security classification.
 */
export function isDangerousCommand(command: string): CommandSecurityEvaluation {
  return classifyCommandSecurity(command);
}

/**
 * Checks whether an IP address belongs to loopback, private, link-local, or reserved ranges.
 */
export function isPrivateOrBlockedIp(ipStr: string): boolean {
  const ip = ipStr.trim().toLowerCase();

  // IPv4 mapped IPv6 (e.g. ::ffff:127.0.0.1)
  if (ip.startsWith('::ffff:')) {
    const rawV4 = ip.slice(7);
    if (net.isIPv4(rawV4)) {
      return isPrivateOrBlockedIp(rawV4);
    }
  }

  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some(n => isNaN(n) || n < 0 || n > 255)) {
      return true; // Malformed IPv4
    }
    const [b0, b1, b2, b3] = parts;

    // 0.0.0.0/8 (Current network)
    if (b0 === 0) return true;
    // 10.0.0.0/8 (Private)
    if (b0 === 10) return true;
    // 127.0.0.0/8 (Loopback)
    if (b0 === 127) return true;
    // 100.64.0.0/10 (Carrier grade NAT)
    if (b0 === 100 && b1 >= 64 && b1 <= 127) return true;
    // 169.254.0.0/16 (Link local / Cloud metadata)
    if (b0 === 169 && b1 === 254) return true;
    // 172.16.0.0/12 (Private)
    if (b0 === 172 && b1 >= 16 && b1 <= 31) return true;
    // 192.0.0.0/24 (IETF Protocol Assignments)
    if (b0 === 192 && b1 === 0 && b2 === 0) return true;
    // 192.0.2.0/24 (TEST-NET-1)
    if (b0 === 192 && b1 === 0 && b2 === 2) return true;
    // 192.168.0.0/16 (Private)
    if (b0 === 192 && b1 === 168) return true;
    // 198.51.100.0/24 (TEST-NET-2)
    if (b0 === 198 && b1 === 51 && b2 === 100) return true;
    // 203.0.113.0/24 (TEST-NET-3)
    if (b0 === 203 && b1 === 0 && b2 === 113) return true;
    // 224.0.0.0/4 (Multicast)
    if (b0 >= 224 && b0 <= 239) return true;
    // 240.0.0.0/4 (Reserved)
    if (b0 >= 240) return true;
    // 255.255.255.255 (Broadcast)
    if (b0 === 255 && b1 === 255 && b2 === 255 && b3 === 255) return true;

    return false;
  }

  if (net.isIPv6(ip)) {
    // ::1 (Loopback)
    if (ip === '::1' || ip === '0:0:0:0:0:0:0:1') return true;
    // :: (Unspecified)
    if (ip === '::' || ip === '0:0:0:0:0:0:0:0') return true;
    // Unique local: fc00::/7 (starts with fc or fd)
    if (/^f[cd][0-9a-f]{2}:/i.test(ip) || ip.startsWith('fc') || ip.startsWith('fd')) return true;
    // Link-local: fe80::/10 (fe80 through febf)
    if (/^fe[89ab][0-9a-f]:/i.test(ip) || ip.startsWith('fe80:')) return true;
    // Multicast: ff00::/8
    if (ip.startsWith('ff')) return true;

    return false;
  }

  return false;
}

/**
 * Audits a URL against static SSRF targets (localhost, link-local, private ranges, cloud metadata).
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

  // Direct IP checks
  if (net.isIP(hostname) && isPrivateOrBlockedIp(hostname)) {
    return { safe: false, reason: `SSRF Protection: Requests to private/reserved IP "${hostname}" are blocked.` };
  }

  return { safe: true };
}

/**
 * Validates a URL against SSRF, resolving DNS to check actual destination IP addresses.
 */
export async function validateSsrfSafeUrl(rawUrl: string): Promise<{ safe: boolean; reason?: string }> {
  // 1. Static validation
  const staticCheck = isSsrfSafeUrl(rawUrl);
  if (!staticCheck.safe) {
    return staticCheck;
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { safe: false, reason: 'Malformed URL' };
  }

  const hostname = parsed.hostname.toLowerCase();

  // 2. Direct IP check
  if (net.isIP(hostname)) {
    if (isPrivateOrBlockedIp(hostname)) {
      return { safe: false, reason: `SSRF Protection: Direct access to private/reserved IP "${hostname}" is blocked.` };
    }
    return { safe: true };
  }

  // 3. DNS Resolution check (resolves all A and AAAA records)
  try {
    const records = await dns.lookup(hostname, { all: true });
    if (!records || records.length === 0) {
      return { safe: false, reason: `DNS resolution failed for hostname "${hostname}".` };
    }

    for (const record of records) {
      if (isPrivateOrBlockedIp(record.address)) {
        return {
          safe: false,
          reason: `SSRF Protection: Hostname "${hostname}" resolves to blocked IP address (${record.address}).`
        };
      }
    }
  } catch (err: any) {
    return { safe: false, reason: `DNS lookup failed for "${hostname}": ${err.message}` };
  }

  return { safe: true };
}
