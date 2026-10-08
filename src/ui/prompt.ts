import readline from 'node:readline';

/**
 * High-performance, unconstrained multi-line terminal prompt reader.
 * 
 * Implements:
 * 1. ANSI Bracketed Paste Mode (\x1b[?2004h / \x1b[?2004l) to capture multi-line clipboard pastes seamlessly.
 * 2. Temporal Burst Detection as a fallback for terminals lacking bracketed paste support.
 * 3. Raw mode keyboard handling with immediate single-keystroke responsiveness and zero prompt length limits.
 */
export async function readInteractivePrompt(promptPrefix: string): Promise<string> {
  // If not a TTY (piped input, CI, or automated script), fallback to standard readline
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    return new Promise((resolve) => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: false
      });
      process.stdout.write(promptPrefix);
      rl.once('line', (line) => {
        rl.close();
        resolve(line);
      });
    });
  }

  return new Promise<string>((resolve) => {
    let buffer = '';
    let inBracketedPaste = false;
    let burstTimer: NodeJS.Timeout | null = null;

    // Enable Bracketed Paste Mode in terminal
    process.stdout.write('\x1b[?2004h');
    process.stdout.write(promptPrefix);

    const cleanup = () => {
      if (burstTimer) clearTimeout(burstTimer);
      // Disable Bracketed Paste Mode
      process.stdout.write('\x1b[?2004l');
      try {
        process.stdin.setRawMode(false);
      } catch {}
      process.stdin.removeListener('data', onData);
      process.stdin.pause();
    };

    const submit = () => {
      cleanup();
      process.stdout.write('\n');
      resolve(buffer);
    };

    const onData = (chunk: Buffer) => {
      const str = chunk.toString('utf8');

      // 1. Interrupt signals
      if (str.includes('\x03')) { // Ctrl+C
        cleanup();
        process.stdout.write('^C\n');
        process.exit(0);
      }

      if (str.includes('\x04') && buffer.length === 0) { // Ctrl+D on empty input
        cleanup();
        process.stdout.write('\n');
        process.exit(0);
      }

      // 2. Bracketed Paste Handling (\x1b[200~ ... \x1b[201~)
      let current = str;

      if (current.includes('\x1b[200~')) {
        inBracketedPaste = true;
        current = current.replace('\x1b[200~', '');
      }

      if (inBracketedPaste) {
        if (current.includes('\x1b[201~')) {
          const parts = current.split('\x1b[201~');
          const pasted = parts[0].replace(/\r\n/g, '\n').replace(/\r/g, '\n');
          buffer += pasted;
          process.stdout.write(pasted);
          inBracketedPaste = false;
          current = parts[1] || '';
        } else {
          const pasted = current.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
          buffer += pasted;
          process.stdout.write(pasted);
          return;
        }
      }

      if (!current) return;

      // 3. Fallback: Temporal Burst Detection for non-bracketed terminals
      // If a chunk contains multiple characters and newlines, it's a clipboard burst
      const hasNewline = current.includes('\r') || current.includes('\n');
      const isBurst = current.length > 2 && hasNewline;

      if (isBurst) {
        const normalized = current.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        buffer += normalized;
        process.stdout.write(normalized);

        if (burstTimer) clearTimeout(burstTimer);
        burstTimer = setTimeout(() => {
          burstTimer = null;
        }, 60);
        return;
      }

      // 4. Character-by-character interactive processing
      for (let i = 0; i < current.length; i++) {
        const char = current[i];

        // Enter key (\r or \n)
        if (char === '\r' || char === '\n') {
          if (burstTimer) {
            // Still in a paste burst window: treat as literal newline
            buffer += '\n';
            process.stdout.write('\n');
          } else {
            // Intentional human submission
            submit();
            return;
          }
        }
        // Backspace (\x7f or \x08)
        else if (char === '\x7f' || char === '\x08') {
          if (buffer.length > 0) {
            if (buffer.endsWith('\n')) {
              buffer = buffer.slice(0, -1);
              process.stdout.write('\x1b[1A\x1b[2K');
            } else {
              buffer = buffer.slice(0, -1);
              process.stdout.write('\b \b');
            }
          }
        }
        // Printable characters & tabs
        else if (char >= ' ' || char === '\t') {
          buffer += char;
          process.stdout.write(char);
        }
      }
    };

    process.stdin.resume();
    process.stdin.setRawMode(true);
    process.stdin.on('data', onData);
  });
}
