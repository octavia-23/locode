export interface ToolParameterProperty {
  type: string;
  description: string;
  enum?: string[];
  items?: {
    type: string;
    description?: string;
    properties?: Record<string, ToolParameterProperty | any>;
    required?: string[];
    items?: any;
  } | Record<string, any>;
  properties?: Record<string, ToolParameterProperty | any>;
  required?: string[];
}

export interface ToolParameters {
  type: 'object';
  properties: Record<string, ToolParameterProperty>;
  required?: string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameters;
  needsApproval?: boolean | ((args: any) => boolean);
  execute: (args: any, context: AgentContext) => Promise<{ result: string; isError?: boolean }>;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id?: string;
    type?: string;
    function: {
      name: string;
      arguments: Record<string, any> | string;
    };
  }>;
}

import { HardwareProfile } from './hardware/detector.js';
import { LlamaRuntimeConfig } from './runtime/profiles.js';
import type { StagnationThresholds } from './agent/stagnation.js';

export type ProviderType =
  | 'ollama'
  | 'openai'
  | 'lmstudio'
  | 'vllm'
  | 'llamacpp'
  | 'gemini'
  | 'anthropic'
  | 'openrouter'
  | 'groq';

export interface AgentContext {
  cwd: string;
  autoApprove: boolean;
  model: string;
  ollamaHost: string;
  provider?: ProviderType;
  apiBase?: string;
  apiKey?: string;
  numCtx?: number;
  interactive?: boolean;
  trustProjectMcp?: boolean;
  hardwareProfile?: HardwareProfile;
  architectModel?: string;
  mode?: 'worker' | 'architect';
  llamaConfig?: Partial<LlamaRuntimeConfig>;
  contextEngine?: any;
  stagnationThresholds?: Partial<StagnationThresholds>;
  maxOutputTokens?: number;
  reasoningBudget?: number;
  commandTimeoutMs?: number;
  signal?: AbortSignal;
  onCommandProgress?: (progress: { elapsedMs: number; lastOutput?: string }) => void;
  journal?: any;
}
