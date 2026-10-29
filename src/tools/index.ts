import { ToolDefinition } from '../types.js';
import { viewFileTool, batchReadFilesTool, writeFileTool, editFileTool, multiEditFileTool } from './file-ops.js';
import { listDirTool, searchCodeTool } from './search.js';
import { runCommandTool } from './terminal.js';
import { fetchWebTool, searchWebTool } from './web.js';
import { delegateTaskTool } from './subagent.js';

export { delegateTaskTool, multiEditFileTool };

export const allTools: ToolDefinition[] = [
  viewFileTool,
  batchReadFilesTool,
  writeFileTool,
  editFileTool,
  multiEditFileTool,
  listDirTool,
  searchCodeTool,
  runCommandTool,
  fetchWebTool,
  searchWebTool,
  delegateTaskTool
];

export const toolRegistry = new Map<string, ToolDefinition>();
for (const tool of allTools) {
  toolRegistry.set(tool.name, tool);
}

export function registerDynamicTool(tool: ToolDefinition): void {
  toolRegistry.set(tool.name, tool);
  if (!allTools.some(t => t.name === tool.name)) {
    allTools.push(tool);
  }
}

export function unregisterDynamicTool(toolName: string): void {
  toolRegistry.delete(toolName);
  const idx = allTools.findIndex(t => t.name === toolName);
  if (idx !== -1) {
    allTools.splice(idx, 1);
  }
}

export function unregisterDynamicTools(toolNames: string[]): void {
  const set = new Set(toolNames);
  for (const name of toolNames) {
    toolRegistry.delete(name);
  }
  for (let i = allTools.length - 1; i >= 0; i--) {
    if (set.has(allTools[i].name)) {
      allTools.splice(i, 1);
    }
  }
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
