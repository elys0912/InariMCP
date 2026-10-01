import { describe, expect, it } from 'vitest';
import { argTimeout, filterAriaSnapshot, ignoredParamWarnings } from '../src/headless/helpers.js';

describe('argTimeout', () => {
  it('accepts timeoutMs and timeout, timeoutMs first', () => {
    expect(argTimeout({ timeoutMs: 500 }, 10_000)).toBe(500);
    expect(argTimeout({ timeout: 700 }, 10_000)).toBe(700);
    expect(argTimeout({ timeoutMs: 500, timeout: 700 }, 10_000)).toBe(500);
  });

  it('falls back for missing, zero, negative and non-numeric values', () => {
    for (const args of [{}, { timeout: 0 }, { timeoutMs: -1 }, { timeout: '5' }, { timeout: NaN }]) {
      expect(argTimeout(args, 1234)).toBe(1234);
    }
  });
});

const YAML = [
  '- heading "Shop" [level=1]',
  '- navigation:',
  '  - link "Home"',
  '  - list:',
  '    - listitem:',
  '      - link "Deep"',
  '- text: Some plain text',
  '- button "Buy"',
].join('\n');

describe('filterAriaSnapshot', () => {
  it('returns every node without filters', () => {
    expect(filterAriaSnapshot(YAML, {})).toBe(YAML);
  });

  it('cuts at maxDepth (depth 0 = top level)', () => {
    expect(filterAriaSnapshot(YAML, { maxDepth: 1 }).split('\n')).toEqual([
      '- heading "Shop" [level=1]',
      '- navigation:',
      '- text: Some plain text',
      '- button "Buy"',
    ]);
    expect(filterAriaSnapshot(YAML, { maxDepth: 2 })).not.toContain('Deep');
  });

  it('drops text nodes when includeText is false', () => {
    expect(filterAriaSnapshot(YAML, { includeText: false })).not.toContain('Some plain text');
    expect(filterAriaSnapshot(YAML, { includeText: true })).toContain('Some plain text');
  });

  it('flattens to the requested roles', () => {
    expect(filterAriaSnapshot(YAML, { roles: ['link', 'button'] }).split('\n')).toEqual([
      '- link "Home"',
      '- link "Deep"',
      '- button "Buy"',
    ]);
  });

  it('combines roles with maxDepth', () => {
    expect(filterAriaSnapshot(YAML, { roles: ['link'], maxDepth: 2 })).toBe('- link "Home"');
  });
});

describe('ignoredParamWarnings', () => {
  it('is silent for defaults and unknown actions', () => {
    expect(ignoredParamWarnings('click', { doubleClick: false, rightClick: false })).toEqual([]);
    expect(ignoredParamWarnings('type', { delay: 50, clear: false, pressEnter: false })).toEqual([]);
    expect(ignoredParamWarnings('no_such_action', { anything: 1 })).toEqual([]);
  });

  it('warns once per ignored parameter set to a non-default value', () => {
    const w = ignoredParamWarnings('type', { pressEnter: true, delay: 10, selector: '#a' });
    expect(w).toHaveLength(2);
    expect(w.join(' ')).toContain('pressEnter');
    expect(w.join(' ')).toContain('delay');
    expect(ignoredParamWarnings('click', { xpath: '//a' })).toHaveLength(1);
  });

  it('screenshot warns only when saveToFile is turned off', () => {
    expect(ignoredParamWarnings('screenshot', { saveToFile: true })).toEqual([]);
    expect(ignoredParamWarnings('screenshot', { saveToFile: false })).toHaveLength(1);
  });

  it('WP5 arguments: type delay 0 is what headless does anyway; screenshot timeout is ignored', () => {
    expect(ignoredParamWarnings('type', { delay: 0 })).toEqual([]);
    expect(ignoredParamWarnings('screenshot', { timeout: 5000 })).toEqual([
      expect.stringContaining('timeout'),
    ]);
  });
  // TODO(test): every key in HEADLESS_IGNORED exists in the tool's schema.
});
