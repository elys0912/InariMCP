/**
 * Extension content script: element location and typing fixes of WP5
 * (review 3.A1 / 6.Critical, 3.A11, 3.A13, 6.High). The helpers are
 * imported from content/dom.ts and content/input.ts (modules without
 * top-level side effects); DOM behaviour itself needs a real browser.
 *
 * TODO(test): in a real DOM (Playwright Firefox): findByText picks the
 *   innermost / enabled / visible match, text split over child elements,
 *   script / style text ignored; generateXPath round-trips for HTML and SVG
 *   elements; pressEnterOn submits via the default button, not when a
 *   keydown handler cancels, not for textarea, "blocked" for two text
 *   fields without a button, "invalid" on constraint failure.
 * TODO(test): performType without locator types into the focused field;
 *   disabled targets fail for fox_click / fox_type; select_option fails on
 *   an unknown option.
 * TODO(test): waitForNetworkIdle timeout → success false with the pending
 *   count; stopObserving of an unknown id fails; inject_observer flags.
 * TODO(test): content-side log batching (timer flush, pagehide flush,
 *   flushLogs / stopLogging hand over pending entries once).
 */

import { beforeAll, describe, expect, it } from 'vitest';

interface ContentFns {
  escapeXPathString(s: string): string;
  textLocatorXPath(text: string): string | null;
  generateXPath(el: unknown): string;
  locatorOf(o: Record<string, unknown>): Record<string, unknown>;
  locatorWithoutText(o: Record<string, unknown>): Record<string, unknown>;
  typingDelay(length: number, requested: unknown, budgetMs: number): number;
}

let fns: ContentFns;

beforeAll(async () => {
  const dom = await import('../../packages/extension/src/content/dom.ts');
  const input = await import('../../packages/extension/src/content/input.ts');
  fns = {
    escapeXPathString: dom.escapeXPathString,
    textLocatorXPath: dom.textLocatorXPath,
    generateXPath: dom.generateXPath as ContentFns['generateXPath'],
    locatorOf: dom.locatorOf as ContentFns['locatorOf'],
    locatorWithoutText: dom.locatorWithoutText as ContentFns['locatorWithoutText'],
    typingDelay: input.typingDelay,
  };
});

describe('3.A1 fox_type: `text` is what to type, not a locator', () => {
  it('the locator of a placeholder-only fox_type has no text (nor other data)', () => {
    const data = { text: 'hello', placeholder: 'Search', clear: true, pressEnter: true, delay: 0 };
    expect(fns.locatorWithoutText(data)).toEqual({ placeholder: 'Search' });
    // fox_click keeps text as its locator
    expect(fns.locatorOf({ text: 'Sign in', doubleClick: false })).toEqual({ text: 'Sign in' });
  });

  it('delay 0 is honoured and long texts stay within the typing budget', () => {
    expect(fns.typingDelay(10, 0, 10_000)).toBe(0);
    expect(fns.typingDelay(10, undefined, 10_000)).toBe(50);
    // 600 characters at the default 50 ms used to take 30 s
    expect(600 * fns.typingDelay(600, 50, 10_000)).toBeLessThanOrEqual(10_000);
  });
});

describe('3.A11 generateXPath quotes ids as XPath literals', () => {
  it('uses concat() for ids with both quote kinds, never CSS escapes', () => {
    expect(fns.generateXPath({ id: `a"b'c` })).toBe(`//*[@id=concat('a"b', "'", 'c')]`);
    expect(fns.generateXPath({ id: 'x.y:1' })).toBe(`//*[@id='x.y:1']`);
  });
});

describe('3.A13 text locator', () => {
  it('matches the whole (normalized) text of the innermost element, quoted safely', () => {
    const xpath = fns.textLocatorXPath("  Don't\n  go ")!;
    expect(xpath).toContain(`contains(normalize-space(.), "Don't go")`);
    expect(xpath).not.toContain('text()');
    expect(xpath).toMatch(/\[not\(\*\[/); // innermost: no child element also matches
    expect(fns.textLocatorXPath('   ')).toBeNull();
  });
});
