import test from 'node:test';
import assert from 'node:assert/strict';
import { extractToolCalls } from '../src/utils/tool-parser.js';

test('Tool Parser - extracts standard Qwen <tool_call> tags with JSON arguments', () => {
  const content = `I will read the project entry point.
<tool_call>
{"name": "view_file", "arguments": {"path": "src/index.ts"}}
</tool_call>`;

  const result = extractToolCalls(content);
  assert.equal(result.hasToolCalls, true);
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].function.name, 'view_file');
  assert.deepEqual(result.toolCalls[0].function.arguments, { path: 'src/index.ts' });
  assert.equal(result.cleanedText, 'I will read the project entry point.');
});

test('Tool Parser - extracts Qwen <tool_call> with stringified JSON arguments', () => {
  const content = `<tool_call>
{"name": "edit_file", "arguments": "{\\"path\\": \\"app.ts\\", \\"target_content\\": \\"foo\\", \\"replacement_content\\": \\"bar\\"}"}
</tool_call>`;

  const result = extractToolCalls(content);
  assert.equal(result.hasToolCalls, true);
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].function.name, 'edit_file');
  assert.deepEqual(result.toolCalls[0].function.arguments, {
    path: 'app.ts',
    target_content: 'foo',
    replacement_content: 'bar'
  });
  assert.equal(result.cleanedText, '');
});

test('Tool Parser - extracts Qwen <tool_call> with parameters or args alias', () => {
  const content = `<tool_call>
{"name": "run_command", "parameters": {"command": "npm test"}}
</tool_call>`;

  const result = extractToolCalls(content);
  assert.equal(result.hasToolCalls, true);
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].function.name, 'run_command');
  assert.deepEqual(result.toolCalls[0].function.arguments, { command: 'npm test' });
});

test('Tool Parser - extracts multiple sequential <tool_call> blocks', () => {
  const content = `<tool_call>
{"name": "view_file", "arguments": {"path": "file1.ts"}}
</tool_call>
<tool_call>
{"name": "view_file", "arguments": {"path": "file2.ts"}}
</tool_call>`;

  const result = extractToolCalls(content);
  assert.equal(result.hasToolCalls, true);
  assert.equal(result.toolCalls.length, 2);
  assert.equal(result.toolCalls[0].function.name, 'view_file');
  assert.deepEqual(result.toolCalls[0].function.arguments, { path: 'file1.ts' });
  assert.equal(result.toolCalls[1].function.name, 'view_file');
  assert.deepEqual(result.toolCalls[1].function.arguments, { path: 'file2.ts' });
  assert.equal(result.cleanedText, '');
});

test('Tool Parser - extracts <function=name> and <call:name> tags', () => {
  const content = `Let me inspect the directory:
<function=list_dir>{"path": "."}</function>`;

  const result = extractToolCalls(content);
  assert.equal(result.hasToolCalls, true);
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].function.name, 'list_dir');
  assert.deepEqual(result.toolCalls[0].function.arguments, { path: '.' });
  assert.equal(result.cleanedText, 'Let me inspect the directory:');
});

test('Tool Parser - extracts Python-style function call syntax', () => {
  const content = `I will run the test suite:
run_command(command="npm run build")`;

  const result = extractToolCalls(content);
  assert.equal(result.hasToolCalls, true);
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].function.name, 'run_command');
  assert.deepEqual(result.toolCalls[0].function.arguments, { command: 'npm run build' });
});

test('Tool Parser - preserves thinking blocks while rescuing tool call', () => {
  const content = `<think>
I need to check package.json to verify scripts.
</think>
<tool_call>
{"name": "view_file", "arguments": {"path": "package.json"}}
</tool_call>`;

  const result = extractToolCalls(content);
  assert.equal(result.hasToolCalls, true);
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].function.name, 'view_file');
  assert.ok(result.cleanedText.includes('<think>'));
  assert.ok(!result.cleanedText.includes('<tool_call>'));
});

test('Tool Parser - returns hasToolCalls=false on normal conversational text', () => {
  const content = 'I have completed the task and updated the configuration files.';
  const result = extractToolCalls(content);
  assert.equal(result.hasToolCalls, false);
  assert.equal(result.toolCalls.length, 0);
  assert.equal(result.cleanedText, content);
});
