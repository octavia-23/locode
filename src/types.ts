export interface ToolParameterProperty {
  type: string;
  description: string;
  enum?: string[];
  items?: {
    type: string;
  };
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
  tool_calls?: Array<{
    id?: string;
    type?: string;
    function: {
      name: string;
      arguments: Record<string, any> | string;
    };
  }>;
}

export interface AgentContext {
  cwd: string;
  autoApprove: boolean;
  model: string;
  ollamaHost: string;
}
