import test from 'node:test';
import assert from 'node:assert/strict';
import {
  theme,
  getActiveTheme,
  setActiveTheme,
  getAvailableThemes,
  PALETTES
} from '../src/ui/theme.js';

test('Theme System - defaults to terracotta palette', () => {
  const current = getActiveTheme();
  assert.equal(current.name, 'terracotta');
  assert.equal(typeof theme.accent('test'), 'string');
  assert.ok(theme.accent('test').includes('test'));
});

test('Theme System - lists available built-in palettes', () => {
  const available = getAvailableThemes();
  assert.ok(available.length >= 6);
  const names = available.map(t => t.name);
  assert.ok(names.includes('terracotta'));
  assert.ok(names.includes('nord'));
  assert.ok(names.includes('emerald'));
  assert.ok(names.includes('monokai'));
  assert.ok(names.includes('dracula'));
  assert.ok(names.includes('minimal'));
});

test('Theme System - switches active palette and updates live glyph getters', () => {
  const switched = setActiveTheme('nord');
  assert.equal(switched, true);
  assert.equal(getActiveTheme().name, 'nord');

  // Verify getters dynamically respond to palette change
  assert.ok(typeof theme.actionDot === 'string');
  assert.ok(typeof theme.promptGlyph === 'string');
  assert.ok(typeof theme.diamond === 'string');
  assert.ok(typeof theme.branch === 'string');

  // Switch to minimal
  setActiveTheme('minimal');
  assert.equal(getActiveTheme().name, 'minimal');

  // Switch back to terracotta
  setActiveTheme('terracotta');
  assert.equal(getActiveTheme().name, 'terracotta');
});

test('Theme System - rejects unknown theme name safely', () => {
  const result = setActiveTheme('non_existent_cyberpunk_neon');
  assert.equal(result, false);
  assert.equal(getActiveTheme().name, 'terracotta');
});

test('Theme System - gauge helper scales correctly with percentage', () => {
  const lowGauge = theme.gauge(20, 8);
  const midGauge = theme.gauge(70, 8);
  const highGauge = theme.gauge(95, 8);

  assert.ok(lowGauge.includes('▰'), 'Low gauge has filled blocks');
  assert.ok(midGauge.includes('▰'), 'Mid gauge has filled blocks');
  assert.ok(highGauge.includes('▰'), 'High gauge has filled blocks');
});
