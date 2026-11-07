import chalk from 'chalk';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface ThemePalette {
  name: string;
  label: string;
  text: string;
  secondary: string;
  muted: string;
  faint: string;
  subtle: string;
  accent: string;
  success: string;
  error: string;
  warning: string;
}

export const PALETTES: Record<string, ThemePalette> = {
  terracotta: {
    name: 'terracotta',
    label: 'Terracotta (Warm Sand & Slate - Default)',
    text: '#f4f4f5',
    secondary: '#a1a1aa',
    muted: '#71717a',
    faint: '#3f3f46',
    subtle: '#27272a',
    accent: '#d4a373',
    success: '#34d399',
    error: '#f43f5e',
    warning: '#fbbf24'
  },
  nord: {
    name: 'nord',
    label: 'Nord (Arctic Ice & Frost Teal)',
    text: '#eceff4',
    secondary: '#d8dee9',
    muted: '#88c0d0',
    faint: '#4c566a',
    subtle: '#2e3440',
    accent: '#81a1c1',
    success: '#a3be8c',
    error: '#bf616a',
    warning: '#ebcb8b'
  },
  emerald: {
    name: 'emerald',
    label: 'Emerald (Forest Pine & Mint)',
    text: '#f0fdf4',
    secondary: '#86efac',
    muted: '#4ade80',
    faint: '#1e3a2f',
    subtle: '#142820',
    accent: '#10b981',
    success: '#22c55e',
    error: '#ef4444',
    warning: '#eab308'
  },
  monokai: {
    name: 'monokai',
    label: 'Monokai (Warm Olive & Coral)',
    text: '#f8f8f2',
    secondary: '#e6db74',
    muted: '#75715e',
    faint: '#49483e',
    subtle: '#272822',
    accent: '#fd971f',
    success: '#a6e22e',
    error: '#f92672',
    warning: '#e6db74'
  },
  dracula: {
    name: 'dracula',
    label: 'Dracula (Orchid Purple & Cyan)',
    text: '#f8f8f2',
    secondary: '#bd93f9',
    muted: '#6272a4',
    faint: '#44475a',
    subtle: '#282a36',
    accent: '#ff79c6',
    success: '#50fa7b',
    error: '#ff5555',
    warning: '#f1fa8c'
  },
  minimal: {
    name: 'minimal',
    label: 'Minimal (Monochrome & Pure Grayscale)',
    text: '#ffffff',
    secondary: '#cccccc',
    muted: '#888888',
    faint: '#444444',
    subtle: '#222222',
    accent: '#e0e0e0',
    success: '#aaaaaa',
    error: '#ffffff',
    warning: '#bbbbbb'
  }
};

let activePalette: ThemePalette = PALETTES.terracotta;

// Attempt to load persisted theme from global config
try {
  const globalThemeFile = path.join(os.homedir(), '.locode', 'theme');
  if (fs.existsSync(globalThemeFile)) {
    const saved = fs.readFileSync(globalThemeFile, 'utf8').trim();
    if (PALETTES[saved]) activePalette = PALETTES[saved];
  }
} catch {}

export function setActiveTheme(name: string): boolean {
  const key = name.trim().toLowerCase();
  if (PALETTES[key]) {
    activePalette = PALETTES[key];
    try {
      const globalDir = path.join(os.homedir(), '.locode');
      fs.mkdirSync(globalDir, { recursive: true });
      fs.writeFileSync(path.join(globalDir, 'theme'), key, 'utf8');
    } catch {}
    return true;
  }
  return false;
}

export function getActiveTheme(): ThemePalette {
  return activePalette;
}

export function getAvailableThemes(): ThemePalette[] {
  return Object.values(PALETTES);
}

/**
 * Modern Design System & Visual Grammar for Locode.
 *
 * Implements dynamic palette reactivity, geometric frame glyphs,
 * and high-density micro-gauges.
 */
export const theme = {
  // Neutral spectrum (Dynamic)
  text: (s: string | number) => chalk.hex(activePalette.text)(String(s)),
  secondary: (s: string | number) => chalk.hex(activePalette.secondary)(String(s)),
  muted: (s: string | number) => chalk.hex(activePalette.muted)(String(s)),
  faint: (s: string | number) => chalk.hex(activePalette.faint)(String(s)),
  subtle: (s: string | number) => chalk.hex(activePalette.subtle)(String(s)),

  // Semantic accents (Dynamic)
  accent: (s: string | number) => chalk.hex(activePalette.accent)(String(s)),
  success: (s: string | number) => chalk.hex(activePalette.success)(String(s)),
  error: (s: string | number) => chalk.hex(activePalette.error)(String(s)),
  warning: (s: string | number) => chalk.hex(activePalette.warning)(String(s)),

  // Diff tokens
  diffAdd: (s: string | number) => chalk.hex(activePalette.success)(String(s)),
  diffDel: (s: string | number) => chalk.hex(activePalette.error)(String(s)),
  diffHunk: (s: string | number) => chalk.hex(activePalette.muted)(String(s)),
  diffContext: (s: string | number) => chalk.hex(activePalette.muted)(String(s)),

  // Action Tree Glyphs (Getters for live theme updates)
  get actionDot() { return chalk.hex(activePalette.accent)('⏺'); },
  get branch() { return chalk.hex(activePalette.muted)('  ⎿  '); },
  get branchSub() { return chalk.hex(activePalette.faint)('     │ '); },
  get promptGlyph() { return chalk.hex(activePalette.accent).bold('❯'); },
  get diamond() { return chalk.hex(activePalette.accent)('◆'); },

  // Structural spine & box characters
  get spineTop() { return chalk.hex(activePalette.muted)('╭─'); },
  get spineMid() { return chalk.hex(activePalette.faint)('│ '); },
  get spineBot() { return chalk.hex(activePalette.muted)('╰─'); },
  get spineLine() { return chalk.hex(activePalette.faint)('──'); },

  boxTl: '╭',
  boxTr: '╮',
  boxBl: '╰',
  boxBr: '╯',
  boxH: '─',
  boxV: '│',

  // Semantic glyphs
  get bullet() { return chalk.hex(activePalette.faint)('•'); },
  get arrow() { return chalk.hex(activePalette.accent)('›'); },
  get check() { return chalk.hex(activePalette.success)('✓'); },
  get cross() { return chalk.hex(activePalette.error)('×'); },
  get alert() { return chalk.hex(activePalette.warning)('!'); },

  // Formatting helpers
  code: (text: string | number) => chalk.hex(activePalette.accent)(String(text)),
  path: (text: string) => chalk.hex(activePalette.text).bold(text),
  dim: (text: string | number) => chalk.hex(activePalette.muted)(String(text)),
  strong: (text: string | number) => chalk.hex(activePalette.text).bold(String(text)),
  tag: (text: string) => chalk.hex(activePalette.faint)('[') + chalk.hex(activePalette.secondary)(text) + chalk.hex(activePalette.faint)(']'),

  /**
   * Formats line number and vertical gutter rule for diffs
   */
  gutter(lineNo: number | string, width: number = 4): string {
    const padded = String(lineNo).padStart(width);
    return `${chalk.hex(activePalette.muted)(padded)} ${chalk.hex(activePalette.faint)('│')} `;
  },

  /**
   * Generates a sleek Unicode micro-gauge: e.g. [▰▰▰▱▱▱▱▱] 38%
   */
  gauge(pct: number, width: number = 8): string {
    const clamped = Math.max(0, Math.min(100, pct));
    const filled = Math.min(width, Math.round((clamped / 100) * width));
    const unfilled = width - filled;

    let barColor = chalk.hex(activePalette.accent);
    if (clamped > 85) barColor = chalk.hex(activePalette.error);
    else if (clamped > 65) barColor = chalk.hex(activePalette.warning);

    const filledStr = barColor('▰'.repeat(filled));
    const unfilledStr = chalk.hex(activePalette.faint)('▱'.repeat(unfilled));
    return `[${filledStr}${unfilledStr}]`;
  }
};
