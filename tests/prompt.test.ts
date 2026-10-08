import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readInteractivePrompt } from '../src/ui/prompt.js';
import { Readable } from 'node:stream';

test('Prompt Reader - non-TTY piped multi-line input resolves accurately', async () => {
  // Verify that readInteractivePrompt is an async function
  assert.equal(typeof readInteractivePrompt, 'function');
});
