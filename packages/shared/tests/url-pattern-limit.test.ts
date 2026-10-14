/**
 * url-pattern-limit.ts: what a urlPattern may be before it is compiled
 * (Fs-04 / Fo-12). Patterns of the usual shape keep working.
 */

import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MAX_CHOICES, MAX_URL_PATTERN_LENGTH, urlPatternProblem } from '@inari-mcp/shared/url-pattern-limit';

const NESTED = /repeated group contains a quantifier or \|/;
const CHOICES = /more than 7 quantifiers and \| together/;
const WEIGHT = /too many ways to split the URL \(weight over 12/;
const RANGE = /a \{n,m\} with m over 32/;

/** The slowest forms the limits still accept (weight 12, or 7 choices). */
const SLOWEST_ACCEPTED = [
  '.*.*x',
  '.*a?a?a?a?a?a?x',
  '.*.{0,32}x',
  '.{0,32}.{0,32}x',
  '[^/]+[^/]+x',
  '(a+)\\1+x',
];

/** URL-like texts of 256 characters that none of SLOWEST_ACCEPTED matches. */
const LONG_URLS = [
  'a'.repeat(256),
  `https://${'a/'.repeat(124)}`,
  Array.from({ length: 256 }, (_, i) => 'ab/.-_'[i % 6]).join(''),
];

/** Milliseconds of one test() of `pattern` against `text`. */
function msOf(pattern: RegExp, text: string): number {
  const start = performance.now();
  pattern.test(text);
  return performance.now() - start;
}

describe('urlPatternProblem', () => {
  // Ordinary URL patterns.
  it.each([
    '^https://example\\.com/.*$',
    '/path/[0-9]+/edit',
    'https://[^/]+\\.example\\.com/.*',
    '(https?://)?(www\\.)?example\\.com/.*',
    '^https://shop\\.example\\.com/items/\\d+\\?page=\\d{1,3}$',
  ])('accepts the URL pattern %s', (source) => {
    expect(urlPatternProblem(source)).toBeNull();
  });

  it.each([
    'example\\.com',
    '/items/\\d+$',
    '\\d{4}-\\d{2}',
    '(foo|bar)\\.example',
    '(foo|bar)?\\.example',
    '(?:ab)+',
    '(?<n>ab)+',
    '[(+*]+',
    '[\\]+*]+',
    '\\(a+\\)+',
    // {,5} is no quantifier in JavaScript: the characters themselves.
    'a{,5}',
    '(a+){,5}',
    // A back reference repeats no group.
    '(a+)\\1+',
    'a?'.repeat(MAX_CHOICES),
    'x'.repeat(MAX_URL_PATTERN_LENGTH),
  ])('accepts %s', (source) => {
    expect(urlPatternProblem(source)).toBeNull();
  });

  it.each([
    ['(a+)+', NESTED],
    ['(\\w*\\.)*example\\.com', NESTED],
    ['^(.*a){2,}$', NESTED],
    ['((ab)+c)*', NESTED],
    ['(?:[a-z]+)+', NESTED],
    ['(a{3})+', NESTED],
    ['((ab)?)+', NESTED],
    ['(a+)+?', NESTED],
    // Alternatives inside a repeated group, which can overlap.
    ['(a|aa)+$', NESTED],
    ['(\\d|\\d\\d)+x', NESTED],
    // A group repeated a fixed number of times is repeated as well.
    ['(.*){10}x', NESTED],
    ['(a+){8}b', NESTED],
    ['(a?){25}a{25}', NESTED],
    // JavaScript closes [] and [^] at their first ], so the group after them is read.
    ['[^](a+)+', NESTED],
    ['[](a+)+', NESTED],
    // Choices in a row, without a repeated group.
    ['a*a*a*a*a*a*a*a*b', CHOICES],
    ['a?'.repeat(40) + 'a'.repeat(40), CHOICES],
    ['(a|aa)'.repeat(40) + 'b', CHOICES],
    ['.{0,9999}'.repeat(8) + 'x', RANGE],
    ['.{0,33}', RANGE],
    ['.*.*.*x', WEIGHT],
    ['.*.*a?x', WEIGHT],
    ['x'.repeat(MAX_URL_PATTERN_LENGTH + 1), /longer than 256 characters \(257\)/],
  ])('refuses %s', (source, message) => {
    expect(urlPatternProblem(source)).toMatch(message);
  });

  // The extension tests a pattern against every tab, so it has run before:
  // timed after a warm-up, the middle of 3 runs.
  it('the slowest accepted patterns take at most 50 ms on a 256-character URL', () => {
    const slowest = SLOWEST_ACCEPTED.map((source) => {
      expect(urlPatternProblem(source), source).toBeNull();
      const pattern = new RegExp(source);
      pattern.test('aaaa');
      const ms = Math.max(...LONG_URLS.map((text) => [0, 1, 2].map(() => msOf(pattern, text)).sort((a, b) => a - b)[1] ?? 0));
      return { source, ms };
    });
    expect(slowest.filter((s) => s.ms > 50)).toEqual([]);
  });

  it('imports nothing (the Extension bundles it)', () => {
    const text = fs.readFileSync(fileURLToPath(new URL('../src/url-pattern-limit.ts', import.meta.url)), 'utf-8');
    expect(text).not.toMatch(/^import /m);
  });
});
