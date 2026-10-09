/**
 * Universal Tool Call and Reasoning Rescue Parser
 * 
 * Specifically optimized for Qwen3.6-35B-A3B and MoE models running on llama-server.
 * Rescues tool calls when the model outputs raw XML/JSON into `message.content`
 * rather than the OpenAI `tool_calls` delta, or when reasoning tags (`<think>`)
 * cause the internal grammar parser to bypass native tool calling.
 */

export interface NormalizedToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: Record<string, any>;
  };
}

export interface ToolParseResult {
  toolCalls: NormalizedToolCall[];
  cleanedText: string;
  hasToolCalls: boolean;
}

const DEFAULT_KNOWN_TOOLS = [
  'view_file',
  'edit_file',
  'write_file',
  'run_command',
  'list_dir',
  'search_code',
  'batch_read_files',
  'fetch_web',
  'search_web'
];

/**
 * Safely parses JSON string or object, normalizing arguments/parameters/args into a dictionary
 */
function normalizeArguments(rawArgs: any): Record<string, any> {
  if (!rawArgs) return {};
  if (typeof rawArgs === 'object' && !Array.isArray(rawArgs)) {
    return rawArgs;
  }
  if (typeof rawArgs === 'string') {
    const trimmed = rawArgs.trim();
    if (!trimmed) return {};
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed;
      }
      return { value: parsed };
    } catch {
      // Try relaxed parsing for unescaped newlines or single quotes
      try {
        const relaxed = trimmed
          .replace(/'/g, '"')
          .replace(/\\'/g, "'");
        const parsed = JSON.parse(relaxed);
        if (typeof parsed === 'object' && parsed !== null) {
          return parsed;
        }
      } catch {}
      return { raw: rawArgs };
    }
  }
  return {};
}

/**
 * Parses Python-style key="val" kwargs inside function call parentheses
 */
function parseKwargs(argsStr: string): Record<string, any> {
  const result: Record<string, any> = {};
  const trimmed = argsStr.trim();
  if (!trimmed) return result;

  // Check if argsStr is actually a JSON object
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      return JSON.parse(trimmed);
    } catch {}
  }

  // Regex to match key = "value" or key = 'value' or key = value
  const kwargRegex = /([a-zA-Z0-9_]+)\s*=\s*(?:"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|([^,\s\)]+))/g;
  let match: RegExpExecArray | null;
  while ((match = kwargRegex.exec(trimmed)) !== null) {
    const key = match[1];
    let val: any;
    if (match[2] !== undefined) {
      val = match[2].replace(/\\n/g, '\n').replace(/\\"/g, '"');
    } else if (match[3] !== undefined) {
      val = match[3].replace(/\\n/g, '\n').replace(/\\'/g, "'");
    } else {
      const rawVal = match[4];
      if (rawVal === 'true') val = true;
      else if (rawVal === 'false') val = false;
      else if (!isNaN(Number(rawVal))) val = Number(rawVal);
      else val = rawVal;
    }
    result[key] = val;
  }

  return result;
}

export function extractToolCalls(
  content: string,
  knownTools: string[] = DEFAULT_KNOWN_TOOLS
): ToolParseResult {
  if (!content || typeof content !== 'string') {
    return { toolCalls: [], cleanedText: '', hasToolCalls: false };
  }

  const calls: NormalizedToolCall[] = [];
  let cleaned = content;

  // 1. Pattern: <tool_call>\n{...}\n</tool_call> (Standard Qwen format)
  const toolCallXmlRegex = /<tool_call>([\s\S]*?)<\/tool_call>/gi;
  let match: RegExpExecArray | null;
  while ((match = toolCallXmlRegex.exec(content)) !== null) {
    const blockContent = match[1].trim();
    try {
      const parsed = JSON.parse(blockContent);
      if (parsed.name && typeof parsed.name === 'string') {
        const args = normalizeArguments(parsed.arguments ?? parsed.parameters ?? parsed.args);
        calls.push({
          id: `call_${Date.now()}_${calls.length}`,
          type: 'function',
          function: {
            name: parsed.name.trim(),
            arguments: args
          }
        });
      }
    } catch {
      // In case the JSON was truncated or malformed, try regex extraction
      const nameMatch = /"name"\s*:\s*"([^"]+)"/i.exec(blockContent);
      if (nameMatch) {
        const name = nameMatch[1];
        calls.push({
          id: `call_${Date.now()}_${calls.length}`,
          type: 'function',
          function: {
            name: name.trim(),
            arguments: {}
          }
        });
      }
    }
  }

  if (calls.length > 0) {
    cleaned = cleaned.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '').trim();
    return {
      toolCalls: calls,
      cleanedText: cleaned,
      hasToolCalls: true
    };
  }

  // 2. Pattern: <function=name>{...}</function> or <function:name>{...}</function>
  const functionTagRegex = /<(?:function|call)[=:\s]+([a-zA-Z0-9_\-\.]+)>([\s\S]*?)<\/(?:function|call)>/gi;
  while ((match = functionTagRegex.exec(content)) !== null) {
    const funcName = match[1].trim();
    const funcBody = match[2].trim();
    const args = normalizeArguments(funcBody);
    calls.push({
      id: `call_${Date.now()}_${calls.length}`,
      type: 'function',
      function: {
        name: funcName,
        arguments: args
      }
    });
  }

  if (calls.length > 0) {
    cleaned = cleaned.replace(functionTagRegex, '').trim();
    return {
      toolCalls: calls,
      cleanedText: cleaned,
      hasToolCalls: true
    };
  }

  // 3. Pattern: Markdown code blocks ```tool_call or ```json containing {"name": "..."}
  const codeBlockRegex = /```(?:tool_call|json)?\s*(\{\s*"name"\s*:\s*"[^"]+".*?\})\s*```/gis;
  while ((match = codeBlockRegex.exec(content)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed.name && typeof parsed.name === 'string') {
        const args = normalizeArguments(parsed.arguments ?? parsed.parameters ?? parsed.args);
        calls.push({
          id: `call_${Date.now()}_${calls.length}`,
          type: 'function',
          function: {
            name: parsed.name.trim(),
            arguments: args
          }
        });
      }
    } catch {}
  }

  if (calls.length > 0) {
    cleaned = cleaned.replace(codeBlockRegex, '').trim();
    return {
      toolCalls: calls,
      cleanedText: cleaned,
      hasToolCalls: true
    };
  }

  // 4. Pattern: Python-style tool call syntax: tool_name(...)
  // e.g., edit_file(path="src/index.ts", target_content="old", replacement_content="new")
  const toolNameUnion = knownTools.join('|');
  const pythonCallRegex = new RegExp(`(?:^|\\n)\\s*(${toolNameUnion})\\(([\\s\\S]*?)\\)(?:\\s*\\n|$)`, 'gi');
  while ((match = pythonCallRegex.exec(content)) !== null) {
    const toolName = match[1].trim();
    const argStr = match[2].trim();
    const parsedArgs = parseKwargs(argStr);
    calls.push({
      id: `call_${Date.now()}_${calls.length}`,
      type: 'function',
      function: {
        name: toolName,
        arguments: parsedArgs
      }
    });
  }

  if (calls.length > 0) {
    cleaned = cleaned.replace(pythonCallRegex, '').trim();
    return {
      toolCalls: calls,
      cleanedText: cleaned,
      hasToolCalls: true
    };
  }

  // 5. Pattern: Embedded JSON object {"name": "...", "arguments": {...}}
  const embeddedJsonRegex = /\{\s*"name"\s*:\s*"([a-zA-Z0-9_\-\.]+)"\s*,\s*"(?:arguments|parameters|args)"\s*:\s*(\{[\s\S]*?\})\s*\}/g;
  while ((match = embeddedJsonRegex.exec(content)) !== null) {
    try {
      const name = match[1].trim();
      const args = JSON.parse(match[2]);
      calls.push({
        id: `call_${Date.now()}_${calls.length}`,
        type: 'function',
        function: {
          name,
          arguments: args
        }
      });
    } catch {}
  }

  if (calls.length > 0) {
    cleaned = cleaned.replace(embeddedJsonRegex, '').trim();
    return {
      toolCalls: calls,
      cleanedText: cleaned,
      hasToolCalls: true
    };
  }

  // 6. Pattern: Entire text is a valid JSON object with a recognized tool name
  try {
    const trimmed = content.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      const parsed = JSON.parse(trimmed);
      if (parsed.name && typeof parsed.name === 'string') {
        const args = normalizeArguments(parsed.arguments ?? parsed.parameters ?? parsed.args);
        return {
          toolCalls: [{
            id: `call_${Date.now()}_0`,
            type: 'function',
            function: {
              name: parsed.name.trim(),
              arguments: args
            }
          }],
          cleanedText: '',
          hasToolCalls: true
        };
      }
    }
  } catch {}

  return {
    toolCalls: [],
    cleanedText: content.trim(),
    hasToolCalls: false
  };
}
