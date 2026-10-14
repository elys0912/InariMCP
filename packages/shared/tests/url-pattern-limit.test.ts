/**
 * url-pattern-limit.ts: what a urlPattern may be before it is compiled
 * (Fs-04 / Fo-12). Patterns of the usual shape keep working.
 */

import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MAX_UNBOUNDED_REPEATS, MAX_URL_PATTERN_LENGTH, urlPatternProblem } from '@inari-mcp/shared/url-pattern-limit';

const NESTED = /repeated group contains a quantifier or \|/;
const UNBOUNDED = /more than 7 unbounded repeats/;

describe('urlPatternProblem', () => {
  it.each([
    'example\\.com',
    '^https://a\\.test/',
    'https://[^/]+\\.example\\.com/.*',
    '/items/\\d+$',
    '\\d{4}-\\d{2}',
    '(foo|bar)\\.example',
    '(https?://)?example\\.com',
    '(foo|bar)?\\.example',
    '(?:ab)+',
    '[(+*]+',
    '[\\]+*]+',
    '\\(a+\\)+',
    'a*'.repeat(MAX_UNBOUNDED_REPEATS),
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
    ['a*a*a*a*a*a*a*a*b', UNBOUNDED],
    ['.+x{2,}' + '.*'.repeat(6), UNBOUNDED],
    ['x'.repeat(MAX_URL_PATTERN_LENGTH + 1), /longer than 256 characters \(257\)/],
  ])('refuses %s', (source, message) => {
    expect(urlPatternProblem(source)).toMatch(message);
  });

  it('imports nothing (the Extension bundles it)', () => {
    const text = fs.readFileSync(fileURLToPath(new URL('../src/url-pattern-limit.ts', import.meta.url)), 'utf-8');
    expect(text).not.toMatch(/^import /m);
  });
});
