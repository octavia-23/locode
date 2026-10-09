import chalk from 'chalk';

/**
 * Reika-inspired Minimalist Design System for Locode.
 * 
 * Aesthetic Principles:
 * - Natural, muted zinc and slate neutrals (no harsh neon colors).
 * - Zero saturated cyan/blue slop.
 * - Understated warm amber/sand accent.
 * - Soft sage green and coral rose for diffs and status.
 * - Typography-driven hierarchy with clean whitespace instead of heavy ASCII boxes.
 */
export const theme = {
  // Neutral spectrum
  text: chalk.hex('#f4f4f5'),          // Crisp off-white
  secondary: chalk.hex('#a1a1aa'),     // Muted zinc
  muted: chalk.hex('#71717a'),         // Darker zinc / metadata
  faint: chalk.hex('#3f3f46'),         // Hairline borders and dividers
  subtle: chalk.hex('#27272a'),        // Background-level elements

  // Semantic accents (low-saturation, natural)
  accent: chalk.hex('#d4a373'),        // Warm sand / desert amber
  success: chalk.hex('#34d399'),       // Soft sage green
  error: chalk.hex('#f43f5e'),         // Soft rose coral
  warning: chalk.hex('#fbbf24'),       // Muted warm yellow

  // Diff tokens
  diffAdd: chalk.hex('#34d399'),
  diffDel: chalk.hex('#f43f5e'),
  diffHunk: chalk.hex('#52525b'),
  diffContext: chalk.hex('#71717a'),

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
};
