import { ChatMessage } from '../types.js';

export interface CompactionConfig {
  maxTokens: number;
  preserveHeadChars?: number;
  preserveTailChars?: number;
}

export class ContextManager {
  private maxTokens: number;

  constructor(maxTokens: number = 16384) {
    this.maxTokens = maxTokens;
  }

  estimateTokens(text: string): number {
    if (!text) return 0;
    // Heuristic: ~3.8 chars per token for code/text
    return Math.ceil(text.length / 3.8);
  }

  estimateMessagesTokens(messages: ChatMessage[]): number {
    let total = 0;
    for (const msg of messages) {
      total += this.estimateTokens(msg.content);
      if (msg.tool_calls) {
        total += this.estimateTokens(JSON.stringify(msg.tool_calls));
      }
    }
    return total;
  }

  /**
   * Intelligently compacts tool output while preserving high-value signals:
   * - Compiler errors / test failures
   * - Stack traces (at ... / Error:)
   * - File paths & line numbers
   * - Head and tail of output
   */
  compactToolOutput(content: string, maxLen: number = 600): string {
    if (!content || content.length <= maxLen) {
      return content;
    }

    const lines = content.split('\n');

    // 1. Identify high-value lines (errors, stack traces, paths, exit codes)
    const criticalIndices = new Set<number>();
    const isCritical = (line: string): boolean => {
      const l = line.trim();
      return (
        /error|fail|exception|panic|fatal|ts\d{4}|warning/i.test(l) ||
        /^\s*at\s+[\w\s.<>$]+\(.*:\d+:\d+\)/.test(l) || // Stack trace format
        /:\d+:\d+:/.test(l) || // File:line:col
        /\berr!|status\s+code\s+\d+/i.test(l) ||
        /^>\s+/.test(l) // Test runner runner line
      );
    };

    lines.forEach((line, idx) => {
      if (isCritical(line)) {
        criticalIndices.add(idx);
        // Also keep immediate next line for context (e.g. error details)
        if (idx + 1 < lines.length) criticalIndices.add(idx + 1);
        if (idx > 0) criticalIndices.add(idx - 1);
      }
    });

    // If critical lines exist, build a structured excerpt
    if (criticalIndices.size > 0) {
      const headCount = Math.min(4, lines.length);
      const tailCount = Math.min(4, lines.length);
      for (let i = 0; i < headCount; i++) criticalIndices.add(i);
      for (let i = lines.length - tailCount; i < lines.length; i++) criticalIndices.add(i);

      const sortedIndices = Array.from(criticalIndices).sort((a, b) => a - b);
      const outputParts: string[] = [];
      let lastIdx = -1;

      for (const idx of sortedIndices) {
        if (lastIdx !== -1 && idx > lastIdx + 1) {
          outputParts.push(`  ... [${idx - lastIdx - 1} lines collapsed] ...`);
        }
        outputParts.push(lines[idx]);
        lastIdx = idx;
      }

      const compactedResult = outputParts.join('\n');
      if (compactedResult.length < content.length) {
        return `[Compacted Output (${lines.length} lines total, preserving key errors & traces)]:\n${compactedResult}`;
      }
    }

    // Default head/tail split if no explicit error lines
    const headChars = Math.floor(maxLen * 0.6);
    const tailChars = Math.floor(maxLen * 0.3);
    const head = content.slice(0, headChars);
    const tail = content.slice(-tailChars);
    return `[Output compacted: ${head} ... [${content.length - headChars - tailChars} characters collapsed] ... ${tail}]`;
  }

  compactMessages(messages: ChatMessage[]): ChatMessage[] {
    const totalTokens = this.estimateMessagesTokens(messages);
    const budget = Math.floor(this.maxTokens * 0.75); // Leave 25% for generation

    if (totalTokens <= budget || messages.length <= 4) {
      return messages;
    }

    // Clone messages so caller's array is not mutated unexpectedly
    const compacted = messages.map(m => ({ ...m }));

    // Priority ordering preserved:
    // 1. System instructions (index 0)
    // 2. Recent turn (last 2 messages: assistant/user)
    const preserveLast = 2;
    const endIdx = compacted.length - preserveLast;

    for (let i = 1; i < endIdx; i++) {
      const msg = compacted[i];
      if (msg.role === 'tool' && msg.content && msg.content.length > 500) {
        msg.content = this.compactToolOutput(msg.content, 500);
      } else if (msg.role === 'assistant' && msg.content && msg.content.length > 1200) {
        // Compress older long assistant thoughts
        const preview = msg.content.slice(0, 400).replace(/\s+/g, ' ');
        msg.content = `${preview}...\n[Older assistant thought compacted for token budget]`;
      }
    }

    return compacted;
  }
}
