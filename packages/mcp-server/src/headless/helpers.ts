/**
 * Pure helpers of the headless backend (no playwright import, so they can be
 * tested and loaded without it).
 */

import type { z } from 'zod';
import { assertReadSelector, BrowserActionSchema, formatZodIssues, type BrowserAction } from '@inari-mcp/shared';
import { GET_ELEMENTS_MAX } from './limits.js';

/**
 * The arguments of `action`, checked against `schema`. Calls through the MCP
 * tools arrive parsed by the tool schemas (tools/schemas.ts), defaults
 * filled in, so the headless schemas require what those guarantee and add
 * no defaults of their own. Anything else (a direct execute() call) fails
 * with the zod issues.
 */
export function parseArgs<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  args: Record<string, unknown>,
  action: string,
): T {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    throw new Error(`Invalid arguments for ${action}: ${formatZodIssues(parsed.error.issues)}`);
  }
  return parsed.data;
}

/** `s` as a literal inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A letter, digit or underscore: what ends a word for find_text entireWord. */
const WORD_CHAR = '[\\p{L}\\p{N}_]';

/**
 * Occurrences of `query` in `text` (non-overlapping), as the Extension's
 * browser.find counts them (fox_find_text): case-insensitive unless
 * caseSensitive; with entireWord, only where no word character adjoins.
 * The query is literal text (no pattern). An empty query counts 0.
 */
export function countOccurrences(text: string, query: string, caseSensitive: boolean, entireWord: boolean): number {
  if (query === '') return 0;
  const body = escapeRegExp(query);
  const source = entireWord ? `(?<!${WORD_CHAR})${body}(?!${WORD_CHAR})` : body;
  return Array.from(text.matchAll(new RegExp(source, caseSensitive ? 'gu' : 'giu'))).length;
}

interface AriaFilter {
  maxDepth?: number;
  includeText?: boolean;
  roles?: string[];
}

/** Spaces of indent per level in Playwright's ariaSnapshot() YAML. */
const ARIA_INDENT = 2;

/**
 * Apply fox_snapshot's maxDepth / includeText / roles to Playwright's
 * ariaSnapshot() YAML. One line is one node, ARIA_INDENT spaces of indent
 * per level. With `roles` the result is a flat list of the matching lines.
 */
export function filterAriaSnapshot(yaml: string, o: AriaFilter): string {
  let lines = yaml.split('\n').filter((l) => l.trim() !== '');
  const depth = (l: string): number => Math.floor((l.length - l.trimStart().length) / ARIA_INDENT);
  const { maxDepth } = o;
  if (maxDepth !== undefined) lines = lines.filter((l) => depth(l) < maxDepth);
  if (o.includeText === false) lines = lines.filter((l) => !/^\s*- text:/.test(l));
  if (o.roles !== undefined && o.roles.length > 0) {
    const wanted = new Set(o.roles.map((r) => r.toLowerCase()));
    lines = lines
      .filter((l) => wanted.has((/^\s*- (\w+)/.exec(l)?.[1] ?? '').toLowerCase()))
      .map((l) => l.trimStart());
  }
  return lines.join('\n');
}

export interface IgnoredParam {
  key: string;
  /** Schema default: a value equal to it is not worth a warning. */
  def?: unknown;
  /** Other values that ask for what headless does anyway (no warning). */
  same?: readonly unknown[];
  /** Ignored only when this holds for the value and the other arguments (default: always). */
  when?: (value: unknown, args: Record<string, unknown>) => boolean;
  note: string;
}

/** Parameters the headless backend does not honour, per action (exported for the tests). */
export const HEADLESS_IGNORED: Readonly<Partial<Record<BrowserAction, readonly IgnoredParam[]>>> = {
  navigate: [{ key: 'waitForLoad', def: true, note: 'always waits for domcontentloaded' }],
  refresh: [{ key: 'bypassCache', def: false, note: 'cache is not bypassed' }],
  screenshot: [
    { key: 'saveToFile', def: true, note: 'the screenshot is always saved to a file' },
    // fox_screenshot timeout is the all_tabs time budget (WP5); scope
    // all_tabs is not supported here, a single capture has no own timeout.
    { key: 'timeout', note: 'it is the all_tabs time budget; all_tabs is not supported in headless mode' },
  ],
  click: [
    { key: 'xpath', note: 'use selector or x+y' },
    { key: 'text', note: 'use selector or x+y' },
    { key: 'doubleClick', def: false, note: 'single click only' },
    { key: 'rightClick', def: false, note: 'left click only' },
  ],
  type: [
    { key: 'placeholder', note: 'use selector' },
    { key: 'name', note: 'use selector' },
    { key: 'id', note: 'use selector' },
    // With a selector, clear is honoured (without it the text is appended).
    {
      key: 'clear',
      def: false,
      when: (_v, args) => typeof args['selector'] !== 'string' || args['selector'] === '',
      note: 'without selector the keys go to the focused element as they are; pass selector to clear',
    },
    { key: 'pressEnter', def: false, note: 'Enter is not pressed; use fox_press_key' },
    { key: 'delay', def: 50, same: [0], note: 'text is entered at once' },
  ],
  press_key: [
    { key: 'xpath', note: 'use selector' },
    { key: 'text', note: 'use selector' },
    { key: 'id', note: 'use selector' },
  ],
  get_elements: [{
    key: 'limit',
    def: 50,
    when: (v) => typeof v === 'number' && v > GET_ELEMENTS_MAX,
    note: `at most ${GET_ELEMENTS_MAX} elements are returned (count is every match)`,
  }],
  find_text: [{ key: 'includeRectData', def: false, note: 'no rect data' }],
  get_tabs: [
    { key: 'urlPattern', note: 'tabs are not filtered' },
    { key: 'includeFavicon', def: false, note: 'no favicon' },
    { key: 'limit', def: 50, note: 'not applied' },
  ],
  highlight: [{ key: 'label', note: 'no label is drawn' }],
  create_tab: [{ key: 'active', def: true, note: 'the new tab always becomes active' }],
  wait_for_network_idle: [{ key: 'idleTime', def: 500, note: 'fixed by the browser engine' }],
  wait_for_navigation: [
    { key: 'urlPattern', note: "any navigation ends the wait; use fox_wait with for='url'" },
  ],
};

/** One warning per parameter that was set to something other than its default and is ignored. */
export function ignoredParamWarnings(action: string, args: Record<string, unknown>): string[] {
  const known = BrowserActionSchema.safeParse(action);
  const params = known.success ? HEADLESS_IGNORED[known.data] ?? [] : [];
  const out: string[] = [];
  for (const p of params) {
    const v = args[p.key];
    if (v === undefined || v === null || v === p.def || p.same?.includes(v)) continue;
    if (p.when !== undefined && !p.when(v, args)) continue;
    out.push(`${p.key}: ignored in headless mode (${p.note})`);
  }
  return out;
}

/** An engine prefix of a Playwright selector (`xpath=`, `internal:role=`, `*css=`): the name its parser accepts before `=`. */
const SELECTOR_ENGINE_RE = /^[a-zA-Z_0-9+:*-]+$/;

/**
 * Why Playwright would not read `selector` as plain CSS, or null. These are
 * the other forms of its selector parser (playwright-core
 * parseSelectorString): a chain with `>>`, an engine prefix (`xpath=`,
 * `text=`, `role=`, `internal:attr=`, also `css=`), a quoted text selector,
 * and an XPath (`//`, `(//`, `..`). Those engines test attributes and states
 * (`@value`, `role=option[selected]`) that readSelectorProblem does not read,
 * so the reading actions take plain CSS only.
 */
export function playwrightDialectProblem(selector: string): string | null {
  if (selector.includes('>>')) return 'it chains selectors with >>';

  const part = selector.trim();
  const eq = part.indexOf('=');
  if (eq !== -1 && SELECTOR_ENGINE_RE.test(part.slice(0, eq).trim())) {
    return `it names a Playwright selector engine (${part.slice(0, eq).trim()}=)`;
  }
  if (part.startsWith('"') || part.startsWith("'")) return 'it is a Playwright text selector (quoted)';
  if (/^\(*\/\//.test(part) || part.startsWith('..')) return 'it is an XPath';
  return null;
}

/**
 * Refuse the selector of a headless reading action: what the Extension
 * refuses (assertReadSelector), and anything Playwright would not read as
 * plain CSS (playwrightDialectProblem).
 */
export function assertHeadlessReadSelector(selector: string): void {
  const problem = playwrightDialectProblem(selector);
  if (problem !== null) {
    throw new Error(`Selector refused: ${problem}; the reading tools take a CSS selector only`);
  }

  assertReadSelector(selector);
}
