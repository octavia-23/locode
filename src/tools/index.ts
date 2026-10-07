import { ToolDefinition } from '../types.js';
import { viewFileTool, batchReadFilesTool, writeFileTool, editFileTool } from './file-ops.js';
import { listDirTool, searchCodeTool } from './search.js';
import { runCommandTool } from './terminal.js';
import { fetchWebTool, searchWebTool } from './web.js';

export const allTools: ToolDefinition[] = [
  viewFileTool,
  batchReadFilesTool,
  writeFileTool,
  editFileTool,
  listDirTool,
  searchCodeTool,
  runCommandTool,
  fetchWebTool,
  searchWebTool
];

export const toolRegistry = new Map<string, ToolDefinition>();
for (const tool of allTools) {
  toolRegistry.set(tool.name, tool);
}

export function getOllamaTools() {
  return allTools.map(tool => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }
  }));
}
