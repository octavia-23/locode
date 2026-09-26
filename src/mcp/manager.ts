import fs from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ToolDefinition } from '../types.js';
import { MCPConfigFile, MCPServerConfig } from './types.js';

export interface ActiveMCPServer {
  name: string;
  client: Client;
  transport: StdioClientTransport;
  tools: ToolDefinition[];
}

export class MCPManager {
  private cwd: string;
  private activeServers: Map<string, ActiveMCPServer> = new Map();

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  async loadConfiguration(): Promise<MCPConfigFile | null> {
    const configCandidates = [
      path.join(this.cwd, '.mcp.json'),
      path.join(this.cwd, 'mcp.json')
    ];

    for (const candidate of configCandidates) {
      try {
        const raw = await fs.readFile(candidate, 'utf8');
        const parsed = JSON.parse(raw) as MCPConfigFile;
        if (parsed && parsed.mcpServers) {
          return parsed;
        }
      } catch {}
    }

    return null;
  }

  async init(): Promise<ToolDefinition[]> {
    const config = await this.loadConfiguration();
    if (!config || !config.mcpServers) {
      return [];
    }

    const loadedTools: ToolDefinition[] = [];

    for (const [serverName, serverConfig] of Object.entries(config.mcpServers)) {
      try {
        const tools = await this.connectServer(serverName, serverConfig);
        loadedTools.push(...tools);
      } catch (err: any) {
        console.error(`Failed to connect MCP server "${serverName}": ${err.message}`);
      }
    }

    return loadedTools;
  }

  private async connectServer(serverName: string, config: MCPServerConfig): Promise<ToolDefinition[]> {
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args || [],
      env: {
        ...process.env,
        ...(config.env || {})
      } as Record<string, string>
    });

    const client = new Client(
      {
        name: `locode-client-${serverName}`,
        version: '0.2.0'
      },
      {
        capabilities: {}
      }
    );

    await client.connect(transport);

    const toolsResponse = await client.listTools();
    const serverTools: ToolDefinition[] = [];

    for (const mcpTool of toolsResponse.tools) {
      const toolName = `mcp_${serverName}_${mcpTool.name}`;
      const originalToolName = mcpTool.name;

      const toolDef: ToolDefinition = {
        name: toolName,
        description: `[MCP: ${serverName}] ${mcpTool.description || ''}`,
        parameters: {
          type: 'object',
          properties: (mcpTool.inputSchema?.properties as any) || {},
          required: (mcpTool.inputSchema?.required as any) || []
        },
        needsApproval: true,
        execute: async (args: any) => {
          try {
            const result = await client.callTool({
              name: originalToolName,
              arguments: args
            });

            const textOutputs: string[] = [];
            for (const content of (result.content as any[]) || []) {
              if (content.type === 'text') {
                textOutputs.push(content.text);
              } else {
                textOutputs.push(JSON.stringify(content));
              }
            }

            const output = textOutputs.join('\n');
            return {
              result: output || 'Tool executed successfully with no output.',
              isError: Boolean(result.isError)
            };
          } catch (err: any) {
            return {
              result: `MCP tool execution failed: ${err.message}`,
              isError: true
            };
          }
        }
      };

      serverTools.push(toolDef);
    }

    this.activeServers.set(serverName, {
      name: serverName,
      client,
      transport,
      tools: serverTools
    });

    return serverTools;
  }

  getActiveServers(): string[] {
    return Array.from(this.activeServers.keys());
  }

  getLoadedTools(): ToolDefinition[] {
    const all: ToolDefinition[] = [];
    for (const s of this.activeServers.values()) {
      all.push(...s.tools);
    }
    return all;
  }

  async closeAll() {
    for (const s of this.activeServers.values()) {
      try {
        await s.client.close();
      } catch {}
    }
    this.activeServers.clear();
  }
}
