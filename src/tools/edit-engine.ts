import { applyPatch } from 'diff';

export interface EditResult {
  success: boolean;
  content: string;
  strategyUsed?: 'exact' | 'clean-line-numbers' | 'whitespace-trimmed' | 'anchor-context' | 'unified-diff';
  error?: string;
  closestMatch?: {
    startLine: number;
    endLine: number;
    content: string;
  };
}

/**
 * Multi-Strategy Edit Engine inspired by Aider's diff and fallback architecture.
 * 
 * Provides a resilient multi-tier fallback pipeline for local LLM code modifications:
 * 1. Exact string search-and-replace (fast path).
 * 2. Strip view_file line numbers / pipe prefixes (handles copied UI line numbers).
 * 3. Whitespace & indentation normalized line-by-line matching.
 * 4. Context Anchor matching (top/bottom context locks with fuzzy interior).
 * 5. Unified diff hunk parser (handles @@ -a,b +c,d @@ and +/- patch blocks).
 * 6. Actionable closest-match diagnostic when all strategies fail (prevents hallucination loops).
 */
export class MultiStrategyEditEngine {
  static apply(
    fileContent: string,
    targetContent: string,
    replacementContent: string,
    filePath: string = 'file'
  ): EditResult {
    const normFile = fileContent.replace(/\r\n/g, '\n');
    let normTarget = targetContent.replace(/\r\n/g, '\n');
    let normReplacement = replacementContent.replace(/\r\n/g, '\n');

    // ── Strategy 1: Exact Substring Replacement ──
    const exactResult = this.tryExactReplace(normFile, normTarget, normReplacement, filePath);
    if (exactResult.handled) {
      if (exactResult.error) return { success: false, content: fileContent, error: exactResult.error };
      return { success: true, content: exactResult.content!, strategyUsed: 'exact' };
    }

    // ── Strategy 2: Clean Line Numbers (e.g. "   12: ", "45 | ") ──
    const cleanTarget = this.stripLineNumbers(normTarget);
    const cleanReplacement = this.stripLineNumbers(normReplacement);
    if (cleanTarget !== normTarget || cleanReplacement !== normReplacement) {
      const cleanedResult = this.tryExactReplace(normFile, cleanTarget, cleanReplacement, filePath);
      if (cleanedResult.handled) {
        if (cleanedResult.error) return { success: false, content: fileContent, error: cleanedResult.error };
        return { success: true, content: cleanedResult.content!, strategyUsed: 'clean-line-numbers' };
      }
      normTarget = cleanTarget;
      normReplacement = cleanReplacement;
    }

    // ── Strategy 3: Whitespace & Indentation Normalized Matching ──
    const wsResult = this.tryWhitespaceTrimmedMatch(normFile, normTarget, normReplacement, filePath);
    if (wsResult.handled) {
      if (wsResult.error) return { success: false, content: fileContent, error: wsResult.error };
      return { success: true, content: wsResult.content!, strategyUsed: 'whitespace-trimmed' };
    }

    // ── Strategy 4: Context Anchor Matching (Top/Bottom Anchors) ──
    const anchorResult = this.tryAnchorMatching(normFile, normTarget, normReplacement, filePath);
    if (anchorResult.handled) {
      if (anchorResult.error) return { success: false, content: fileContent, error: anchorResult.error };
      return { success: true, content: anchorResult.content!, strategyUsed: 'anchor-context' };
    }

    // ── Strategy 5: Unified Diff Hunk Application ──
    const diffResult = this.tryUnifiedDiffPatch(normFile, normTarget, normReplacement);
    if (diffResult.handled) {
      if (diffResult.error) return { success: false, content: fileContent, error: diffResult.error };
      return { success: true, content: diffResult.content!, strategyUsed: 'unified-diff' };
    }

    // ── Strategy 6: Actionable Closest-Match Diagnostic ──
    const closest = this.findClosestMatch(normFile, normTarget);
    let errorMsg = `Target content not found in ${filePath}.`;
    if (closest) {
      errorMsg += `\nClosest matching section in file (lines ${closest.startLine}–${closest.endLine}):\n\`\`\`\n${closest.content}\n\`\`\`\nPlease align your target_content with the exact code snippet shown above.`;
    } else {
      errorMsg += ` Make sure the target text exists in the file (use view_file first to see current contents).`;
    }

    return {
      success: false,
      content: fileContent,
      error: errorMsg,
      closestMatch: closest || undefined
    };
  }

  private static tryExactReplace(
    file: string,
    target: string,
    replacement: string,
    filePath: string
  ): { handled: boolean; content?: string; error?: string } {
    if (!file.includes(target)) {
      return { handled: false };
    }

    const firstIdx = file.indexOf(target);
    const secondIdx = file.indexOf(target, firstIdx + target.length);
    if (secondIdx !== -1) {
      return {
        handled: true,
        error: `Target content appears multiple times in ${filePath}. Please provide a larger, unique block of context to replace.`
      };
    }

    return {
      handled: true,
      content: file.replace(target, replacement)
    };
  }

  private static stripLineNumbers(text: string): string {
    const lines = text.split('\n');
    const hasLineNumbers = lines.length > 0 && lines.every(l => !l.trim() || /^\s*\d+[:|]\s*/.test(l));
    if (hasLineNumbers) {
      return lines.map(l => l.replace(/^\s*\d+[:|]\s?/, '')).join('\n');
    }
    return text;
  }

  private static tryWhitespaceTrimmedMatch(
    file: string,
    target: string,
    replacement: string,
    filePath: string
  ): { handled: boolean; content?: string; error?: string } {
    const fileLines = file.split('\n');
    const targetLines = target.split('\n').filter((_, idx, arr) => idx < arr.length - 1 || arr[idx].trim().length > 0);

    if (targetLines.length === 0) return { handled: false };

    const trimmedTarget = targetLines.map(l => l.trim());
    const matches: number[] = [];

    for (let i = 0; i <= fileLines.length - targetLines.length; i++) {
      let isMatch = true;
      for (let j = 0; j < targetLines.length; j++) {
        if (fileLines[i + j].trim() !== trimmedTarget[j]) {
          isMatch = false;
          break;
        }
      }
      if (isMatch) {
        matches.push(i);
      }
    }

    if (matches.length > 1) {
      return {
        handled: true,
        error: `Target content matched at ${matches.length} different locations in ${filePath}. Please include more surrounding context to disambiguate.`
      };
    }

    if (matches.length === 1) {
      const idx = matches[0];
      const before = fileLines.slice(0, idx);
      const after = fileLines.slice(idx + targetLines.length);
      return {
        handled: true,
        content: [...before, replacement, ...after].join('\n')
      };
    }

    return { handled: false };
  }

  private static tryAnchorMatching(
    file: string,
    target: string,
    replacement: string,
    filePath: string
  ): { handled: boolean; content?: string; error?: string } {
    const fileLines = file.split('\n');
    const targetLines = target.split('\n').map(l => l.trim()).filter(l => l.length > 0);

    if (targetLines.length < 3) return { handled: false };

    const headAnchor = targetLines[0];
    const tailAnchor = targetLines[targetLines.length - 1];

    const candidates: Array<{ start: number; end: number }> = [];

    for (let i = 0; i < fileLines.length; i++) {
      if (fileLines[i].trim() === headAnchor) {
        // Search for tail anchor within reasonable window
        const maxWindow = Math.min(fileLines.length, i + targetLines.length + 6);
        for (let j = i + 2; j < maxWindow; j++) {
          if (fileLines[j].trim() === tailAnchor) {
            candidates.push({ start: i, end: j });
          }
        }
      }
    }

    if (candidates.length > 1) {
      return {
        handled: true,
        error: `Anchor context matched multiple sections in ${filePath}. Please provide more surrounding lines.`
      };
    }

    if (candidates.length === 1) {
      const { start, end } = candidates[0];
      const before = fileLines.slice(0, start);
      const after = fileLines.slice(end + 1);
      return {
        handled: true,
        content: [...before, replacement, ...after].join('\n')
      };
    }

    return { handled: false };
  }

  private static tryUnifiedDiffPatch(
    file: string,
    target: string,
    replacement: string
  ): { handled: boolean; content?: string; error?: string } {
    // Check if target or replacement has unified diff markers
    const patchCandidate = target.includes('@@') ? target : (replacement.includes('@@') ? replacement : '');
    if (!patchCandidate) return { handled: false };

    try {
      // Ensure patch headers if missing
      let fullPatch = patchCandidate;
      if (!fullPatch.startsWith('---')) {
        fullPatch = `--- a/file\n+++ b/file\n` + fullPatch;
      }

      const patched = applyPatch(file, fullPatch);
      if (typeof patched === 'string') {
        return { handled: true, content: patched };
      }
    } catch {}

    return { handled: false };
  }

  private static findClosestMatch(
    file: string,
    target: string
  ): { startLine: number; endLine: number; content: string } | null {
    const fileLines = file.split('\n');
    const targetLines = target.split('\n').map(l => l.trim()).filter(l => l.length > 0);

    if (targetLines.length === 0 || fileLines.length === 0) return null;

    const windowSize = Math.max(1, targetLines.length);
    let bestScore = -1;
    let bestStart = 0;
    let bestEnd = Math.min(fileLines.length, windowSize);

    const targetWords = new Set(target.toLowerCase().match(/\b[a-zA-Z0-9_$]{2,}\b/g) || []);
    if (targetWords.size === 0) return null;

    for (let i = 0; i <= fileLines.length - windowSize; i++) {
      const windowSlice = fileLines.slice(i, i + windowSize);
      const windowText = windowSlice.join(' ').toLowerCase();
      
      let matches = 0;
      for (const w of targetWords) {
        if (windowText.includes(w)) matches++;
      }

      const score = matches / targetWords.size;
      if (score > bestScore) {
        bestScore = score;
        bestStart = i;
        bestEnd = i + windowSize;
      }
    }

    // Only return if at least 40% keyword similarity
    if (bestScore >= 0.35) {
      const snippet = fileLines.slice(bestStart, bestEnd).join('\n');
      return {
        startLine: bestStart + 1,
        endLine: bestEnd,
        content: snippet
      };
    }

    return null;
  }
}
