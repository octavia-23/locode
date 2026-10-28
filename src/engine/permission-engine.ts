import { ToolDefinition, AgentContext } from '../types.js';
import { PermissionEvaluation, ToolDispatchOptions } from './types.js';
import { resolveSafePath, isDangerousCommand, isSsrfSafeUrl } from '../tools/security.js';

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

    // 4. Filesystem path validation
    const pathArg = args.path || (Array.isArray(args.paths) ? args.paths[0] : undefined);
    if (pathArg && (tool.name === 'view_file' || tool.name === 'write_file' || tool.name === 'edit_file' || tool.name === 'list_dir')) {
      try {
        resolveSafePath(String(pathArg), context.cwd, allowOutside);
      } catch (err: any) {
        return {
          allowed: false,
          reason: err.message || `Path "${pathArg}" violates workspace containment.`
        };
      }
    }

    // 5. Dangerous command inspection
    if (tool.name === 'run_command') {
      const cmd = String(args.command || args.cmd || '').trim();
      const dangerousCheck = isDangerousCommand(cmd);
      if (dangerousCheck.dangerous) {
        if (!isAutoApprove) {
          return {
            allowed: true,
            requiresPrompt: true,
            reason: dangerousCheck.reason
          };
        }
      }
    }

    // 6. Interactive approval evaluation
    const needsApproval = typeof tool.needsApproval === 'function'
      ? tool.needsApproval(args)
      : tool.needsApproval;

    if (needsApproval && !isAutoApprove) {
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
