import { ChatMessage } from '../types.js';

export class ContextManager {
  private maxTokens: number;

  constructor(maxTokens: number = 16384) {
    this.maxTokens = maxTokens;
  }

  estimateTokens(text: string): number {
    if (!text) return 0;
    // Simple heuristic: ~3.8 chars per token for code/text
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

  compactMessages(messages: ChatMessage[]): ChatMessage[] {
    const totalTokens = this.estimateMessagesTokens(messages);
    const budget = Math.floor(this.maxTokens * 0.75); // Leave 25% for generation

    if (totalTokens <= budget || messages.length <= 4) {
      return messages;
    }

    // Clone messages so we don't mutate unexpectedly
    const compacted = messages.map(m => ({ ...m }));

    // Preserve the first system message and the last user turn (last 2 messages)
    const preserveLast = 2;
    const endIdx = compacted.length - preserveLast;

    for (let i = 1; i < endIdx; i++) {
      const msg = compacted[i];
      if (msg.role === 'tool' && msg.content.length > 500) {
        const preview = msg.content.slice(0, 120).replace(/\n/g, ' ');
        msg.content = `[Output compacted: ${preview}... (${msg.content.length} chars total)]`;
      }
    }

    return compacted;
  }
}
