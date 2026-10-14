/**
 * url-pattern-limit.ts: what a urlPattern may be before it is compiled
 * (Fs-04 / Fo-12). Patterns of the usual shape keep working.
 */

import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MAX_URL_PATTERN_LENGTH, urlPatternProblem } from '@inari-mcp/shared/url-pattern-limit';

describe('urlPatternProblem', () => {
  it.each([
    'example\\.com',
    '^https://a\\.test/',
    'https://[^/]+\\.example\\.com/.*',
    '/items/\\d+$',
    '\\d{4}-\\d{2}',
    '(foo|bar)\\.example',
    '(https?://)?example\\.com',
    '(a{3})+',
    '[(+*]+',
    '\\(a+\\)+',
    'x'.repeat(MAX_URL_PATTERN_LENGTH),
  ])('accepts %s', (source) => {
    expect(urlPatternProblem(source)).toBeNull();
  });

  it.each([
    ['(a+)+', /repeated group contains a repeat/],
    ['(\\w*\\.)*example\\.com', /repeated group contains a repeat/],
    ['^(.*a){2,}$', /repeated group contains a repeat/],
    ['((ab)+c)*', /repeated group contains a repeat/],
    ['(?:[a-z]+)+', /repeated group contains a repeat/],
    ['x'.repeat(MAX_URL_PATTERN_LENGTH + 1), /longer than 256 characters \(257\)/],
  ])('refuses %s', (source, message) => {
    expect(urlPatternProblem(source)).toMatch(message);
  });

  it('imports nothing (the Extension bundles it)', () => {
    const text = fs.readFileSync(fileURLToPath(new URL('../src/url-pattern-limit.ts', import.meta.url)), 'utf-8');
    expect(text).not.toMatch(/^import /m);
  });
});
