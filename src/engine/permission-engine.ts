import { ToolDefinition, AgentContext } from '../types.js';
import { PermissionEvaluation, ToolDispatchOptions } from './types.js';
import { resolveSafePath, classifyCommandSecurity, isDangerousCommand, isSsrfSafeUrl } from '../tools/security.js';
import { isUnredactableSensitiveFile } from '../utils/secret-redactor.js';
import { isCloudProvider } from '../providers/factory.js';

export interface PermissionPolicy {
  readOnly?: boolean;
  allowOutsideWorkspace?: boolean;
  allowNetwork?: boolean;
  allowedCommands?: RegExp[];
  blockedCommands?: RegExp[];
  autoApprove?: boolean;
}

export class PermissionEngine {
  private policy: PermissionPolicy;

  constructor(policy: PermissionPolicy = {}) {
    this.policy = policy;
  }

  setPolicy(policy: Partial<PermissionPolicy>) {
    this.policy = { ...this.policy, ...policy };
  }

  getPolicy(): PermissionPolicy {
    return { ...this.policy };
  }

  /**
   * Evaluates permissions before any tool execution can begin.
   * Fails closed whenever required approvals or security checks are unavailable.
   */
  evaluate(
    tool: ToolDefinition,
    args: Record<string, any>,
    context: AgentContext,
    options?: ToolDispatchOptions
  ): PermissionEvaluation {
    const isAutoApprove = options?.autoApprove ?? this.policy.autoApprove ?? context.autoApprove ?? false;
    const allowOutside = options?.allowOutsideWorkspace ?? this.policy.allowOutsideWorkspace ?? false;
    const allowNetwork = options?.allowNetwork ?? this.policy.allowNetwork ?? true;
    const isApprovalAvailable = options?.approvalAvailable !== false &&
                                options?.interactive !== false &&
                                context.interactive !== false;

    // 1. Read-only policy enforcement
    if (this.policy.readOnly) {
      if (tool.name === 'write_file' || tool.name === 'edit_file') {
        return {
          allowed: false,
          reason: `Permission Denied: Workspace is in read-only mode. Tool "${tool.name}" is prohibited.`
        };
      }
      if (tool.name === 'run_command') {
        const cmd = String(args.command || args.cmd || '');
        if (/\b(rm|del|rmdir|mkdir|mv|cp|git\s+commit|git\s+push)\b/i.test(cmd)) {
          return {
            allowed: false,
            reason: `Permission Denied: Destructive or state-mutating command "${cmd}" is blocked in read-only mode.`
          };
        }
      }
    }

    // 2. Network access check
    if (!allowNetwork && (tool.name === 'fetch_web' || tool.name === 'search_web')) {
      return {
        allowed: false,
        reason: `Permission Denied: Network access is disabled by security profile. Tool "${tool.name}" is blocked.`
      };
    }

    // 3. SSRF validation for web tools
    if (tool.name === 'fetch_web' && args.url) {
      const ssrfCheck = isSsrfSafeUrl(String(args.url));
      if (!ssrfCheck.safe) {
        return {
          allowed: false,
          reason: `Security Blocked: ${ssrfCheck.reason || 'URL violates SSRF safety policy.'}`
        };
      }
    }

    // 4. Filesystem path validation & containment
    const isMutatingFileTool = tool.name === 'write_file' || tool.name === 'edit_file';
    // Mutating file tools NEVER allow writing outside workspace
    const effectiveAllowOutside = isMutatingFileTool ? false : allowOutside;

    const pathsToCheck: string[] = [];
    if (typeof args.path === 'string') {
      pathsToCheck.push(args.path);
    }
    if (Array.isArray(args.paths)) {
      for (const p of args.paths) {
        if (typeof p === 'string') pathsToCheck.push(p);
      }
    }

    const isPathSensitiveTool = tool.name === 'view_file' ||
                                tool.name === 'batch_read_files' ||
                                tool.name === 'write_file' ||
                                tool.name === 'edit_file' ||
                                tool.name === 'list_dir' ||
                                tool.name === 'search_code';

    if (isPathSensitiveTool && pathsToCheck.length > 0) {
      for (const p of pathsToCheck) {
        try {
          resolveSafePath(p, context.cwd, effectiveAllowOutside);
        } catch (err: any) {
          return {
            allowed: false,
            reason: err.message || `Path "${p}" violates workspace containment.`
          };
        }
      }
    }

    // 5. Cloud privacy check: unredactable sensitive files require explicit authorization
    const isCloud = isCloudProvider(context.provider);
    if (isCloud && pathsToCheck.length > 0) {
      for (const p of pathsToCheck) {
        if (isUnredactableSensitiveFile(p)) {
          if (!isApprovalAvailable && !options?.authorizedForCloud) {
            return {
              allowed: false,
              requiresPrompt: false,
              reason: `Permission Denied: File "${p}" contains unredactable sensitive cryptographic keys/secrets. Transmission to cloud provider is blocked without explicit interactive authorization.`
            };
          }
          return {
            allowed: true,
            requiresPrompt: true,
            reason: `File "${p}" contains sensitive cryptographic credentials that cannot be safely redacted. Explicit authorization is required to transmit content to cloud provider.`
          };
        }
      }
    }

    // 6. Command security classification (deny, ask, allow)
    if (tool.name === 'run_command') {
      const cmd = String(args.command || args.cmd || '').trim();
      const check = classifyCommandSecurity(cmd);

      // Unconditional DENY: Prohibited commands can NEVER execute under any circumstances.
      // Must not be bypassed by --auto, profile overrides, or missing approval handlers.
      if (check.decision === 'deny') {
        return {
          allowed: false,
          requiresPrompt: false,
          reason: `Execution Prohibited: Command is unconditionally denied by security policy: ${check.reason}`
        };
      }

      // ASK: High-risk commands requiring explicit approval unless auto-approval is enabled
      if (check.decision === 'ask') {
        if (!isAutoApprove) {
          if (!isApprovalAvailable) {
            return {
              allowed: false,
              requiresPrompt: false,
              reason: `Permission Denied: Command requires explicit approval, but approval is unavailable: ${check.reason}`
            };
          }
          return {
            allowed: true,
            requiresPrompt: true,
            reason: check.reason
          };
        }
      }
    }

    // 6. Interactive approval evaluation (Fail-closed when approval is required but unavailable)
    const needsApproval = typeof tool.needsApproval === 'function'
      ? tool.needsApproval(args)
      : tool.needsApproval;

    if (needsApproval && !isAutoApprove) {
      if (!isApprovalAvailable) {
        return {
          allowed: false,
          requiresPrompt: false,
          reason: `Permission Denied: Tool "${tool.name}" requires user approval, but approval is unavailable (non-interactive context).`
        };
      }
      return {
        allowed: true,
        requiresPrompt: true,
        reason: `Tool "${tool.name}" requires user approval before execution.`
      };
    }

    return {
      allowed: true,
      requiresPrompt: false
    };
  }
}
