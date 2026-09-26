export interface MCPServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface MCPConfigFile {
  mcpServers?: Record<string, MCPServerConfig>;
}
