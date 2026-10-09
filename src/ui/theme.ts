import chalk from 'chalk';

/**
 * Claude Code & Reika-inspired Design System & Visual Grammar for Locode.
 * 
 * Aesthetic Principles:
 * - Natural, muted zinc and slate neutrals (zero neon blue or cyan slop).
 * - Warm terracotta / sand / desert amber accent (`#d4a373`).
 * - Soft sage green (`#34d399`) and coral rose (`#f43f5e`) for diffs, checks, and diagnostics.
 * - Claude Code action tree hierarchy: `⏺ Action` with nested `  ⎿  Outcome`.
 * - Clean gutter-aligned inline diffs (`line │ - / +`).
 * - Reika-inspired geometric frames and micro-gauges (`[▰▰▰▱▱▱▱▱]`).
 */
export const theme = {
  // Neutral spectrum (Zinc / Slate)
  text: chalk.hex('#f4f4f5'),          // Crisp off-white
  secondary: chalk.hex('#a1a1aa'),     // Muted zinc
  muted: chalk.hex('#71717a'),         // Darker zinc / metadata
  faint: chalk.hex('#3f3f46'),         // Hairline borders and dividers
  subtle: chalk.hex('#27272a'),        // Darkest structural elements

  // Semantic accents (low-saturation, natural)
  accent: chalk.hex('#d4a373'),        // Warm terracotta / desert sand
  success: chalk.hex('#34d399'),       // Soft sage green
  error: chalk.hex('#f43f5e'),         // Soft rose coral
  warning: chalk.hex('#fbbf24'),       // Muted warm amber

  // Diff tokens
  diffAdd: chalk.hex('#34d399'),
  diffDel: chalk.hex('#f43f5e'),
  diffHunk: chalk.hex('#52525b'),
  diffContext: chalk.hex('#71717a'),

  // Claude Code Action Tree Glyphs
  actionDot: chalk.hex('#d4a373')('⏺'),
  branch: chalk.hex('#71717a')('  ⎿  '),
  branchSub: chalk.hex('#3f3f46')('     │ '),
  promptGlyph: chalk.hex('#d4a373').bold('❯'),
  diamond: chalk.hex('#d4a373')('◆'),

  // Structural spine & box characters
  spineTop: chalk.hex('#52525b')('╭─'),
  spineMid: chalk.hex('#3f3f46')('│ '),
  spineBot: chalk.hex('#52525b')('╰─'),
  spineLine: chalk.hex('#3f3f46')('──'),

  boxTl: '╭',
  boxTr: '╮',
  boxBl: '╰',
  boxBr: '╯',
  boxH: '─',
  boxV: '│',

  // Semantic glyphs
  bullet: chalk.hex('#52525b')('•'),
  arrow: chalk.hex('#d4a373')('›'),
  check: chalk.hex('#34d399')('✓'),
  cross: chalk.hex('#f43f5e')('×'),
  alert: chalk.hex('#fbbf24')('!'),

  // Formatting helpers
  code: (text: string | number) => chalk.hex('#d4a373')(String(text)),
  path: (text: string) => chalk.hex('#f4f4f5').bold(text),
  dim: (text: string | number) => chalk.hex('#71717a')(String(text)),
  strong: (text: string | number) => chalk.hex('#f4f4f5').bold(String(text)),
  tag: (text: string) => chalk.hex('#3f3f46')('[') + chalk.hex('#a1a1aa')(text) + chalk.hex('#3f3f46')(']'),

  /**
   * Formats line number and vertical gutter rule for diffs
   */
  gutter(lineNo: number | string, width: number = 4): string {
    const padded = String(lineNo).padStart(width);
    return `${chalk.hex('#52525b')(padded)} ${chalk.hex('#3f3f46')('│')} `;
  },

  /**
   * Generates a sleek, non-gimmicky Unicode micro-gauge: e.g. [▰▰▰▱▱▱▱▱] 38%
   */
  gauge(pct: number, width: number = 8): string {
    const clamped = Math.max(0, Math.min(100, pct));
    const filled = Math.min(width, Math.round((clamped / 100) * width));
    const unfilled = width - filled;

    let barColor = chalk.hex('#d4a373');
    if (clamped > 85) barColor = chalk.hex('#f43f5e');
    else if (clamped > 65) barColor = chalk.hex('#fbbf24');

    const filledStr = barColor('▰'.repeat(filled));
    const unfilledStr = chalk.hex('#3f3f46')('▱'.repeat(unfilled));
    return `[${filledStr}${unfilledStr}]`;
  }
};
