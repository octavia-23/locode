import chalk from 'chalk';

/**
 * Reika-inspired Minimalist Design System & Visual Grammar for Locode.
 * 
 * Aesthetic Principles:
 * - Natural, muted zinc and slate neutrals (no harsh neon colors).
 * - Zero saturated cyan/blue slop.
 * - Understated warm amber/sand accent (`#d4a373`).
 * - Soft sage green (`#34d399`) and coral rose (`#f43f5e`) for diffs and status.
 * - Elegant, open-spine structural framing (`╭─`, `│ `, `╰─`) connecting tool calls and outcomes.
 * - Clean micro-gauges (`▰▰▰▱▱▱▱▱`) for context and VRAM.
 */
export const theme = {
  // Neutral spectrum
  text: chalk.hex('#f4f4f5'),          // Crisp off-white
  secondary: chalk.hex('#a1a1aa'),     // Muted zinc
  muted: chalk.hex('#71717a'),         // Darker zinc / metadata
  faint: chalk.hex('#3f3f46'),         // Hairline borders and dividers
  subtle: chalk.hex('#27272a'),        // Darkest structural elements

  // Semantic accents (low-saturation, natural)
  accent: chalk.hex('#d4a373'),        // Warm sand / desert amber
  success: chalk.hex('#34d399'),       // Soft sage green
  error: chalk.hex('#f43f5e'),         // Soft rose coral
  warning: chalk.hex('#fbbf24'),       // Muted warm amber

  // Diff tokens
  diffAdd: chalk.hex('#34d399'),
  diffDel: chalk.hex('#f43f5e'),
  diffHunk: chalk.hex('#52525b'),
  diffContext: chalk.hex('#71717a'),

  // Structural spine glyphs (open-frame terminal connectors)
  spineTop: chalk.hex('#52525b')('╭─'),
  spineMid: chalk.hex('#3f3f46')('│ '),
  spineBot: chalk.hex('#52525b')('╰─'),
  spineLine: chalk.hex('#3f3f46')('──'),

  // Semantic glyphs
  bullet: chalk.hex('#52525b')('•'),
  arrow: chalk.hex('#52525b')('›'),
  check: chalk.hex('#34d399')('✓'),
  cross: chalk.hex('#f43f5e')('×'),
  alert: chalk.hex('#fbbf24')('!'),

  // Formatting helpers
  code: (text: string | number) => chalk.hex('#d4a373')(String(text)),
  path: (text: string) => chalk.hex('#f4f4f5').bold(text),
  dim: (text: string | number) => chalk.hex('#71717a')(String(text)),
  strong: (text: string | number) => chalk.hex('#f4f4f5').bold(String(text)),

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
