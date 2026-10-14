/**
 * Pure helpers of the headless backend (no playwright import, so they can be
 * tested and loaded without it).
 */

import type { z } from 'zod';
import { assertReadSelector, BrowserActionSchema, formatZodIssues, MASKED_VALUE, type BrowserAction } from '@inari-mcp/shared';
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

/** What the masked fields under a snapshot's root show (headless/actions.ts snapshot). */
export interface MaskedSnapshotTexts {
  /** The values of masked input and textarea fields. */
  values: string[];
  /** The label and the text of the selected option of each masked select. */
  selectedOptions: string[];
}

/** Text as an aria snapshot shows it (Playwright's normalizeWhiteSpace). */
function ariaText(text: string): string {
  return text.replace(/[\u200b\u00ad]/g, '').trim().replace(/\s+/g, ' ');
}

/** One character escaped inside a double-quoted YAML value, as Playwright escapes it. */
function escapeYamlChar(c: string): string {
  switch (c) {
    case '\\': return '\\\\';
    case '"': return '\\"';
    case '\b': return '\\b';
    case '\f': return '\\f';
    case '\n': return '\\n';
    case '\r': return '\\r';
    case '\t': return '\\t';
    default: return `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`;
  }
}

/**
 * The line endings by which `text` shows as the value of a node: `: text`,
 * or quoted when YAML needs it (Playwright's yamlEscapeValueIfNeeded).
 */
function valueLineEndings(text: string): string[] {
  // eslint-disable-next-line no-control-regex -- the control characters are what Playwright escapes
  const quoted = `"${text.replace(/[\\"\x00-\x1f\x7f-\x9f]/g, escapeYamlChar)}"`;
  return [`: ${text}`, `: ${quoted}`];
}

/**
 * One line of the snapshot with a masked value replaced, or a masked
 * select's choice left out. An option's name holds its label, its text or
 * both (Firefox names `<option label="Thirty-one">2031</option>`
 * "Thirty-one2031"), so a selected option whose name contains one of
 * `selectedNames` loses its `[selected]`.
 */
function maskAriaLine(line: string, valueEndings: string[], selectedNames: string[]): string {
  const ending = valueEndings.find((e) => line.endsWith(e));
  if (ending !== undefined) return `${line.slice(0, line.length - ending.length)}: ${MASKED_VALUE}`;
  const isSelectedOption = line.trimStart().startsWith('- option "') && line.includes(' [selected]');
  if (isSelectedOption && selectedNames.some((name) => line.includes(name))) {
    return line.replace(' [selected]', '');
  }
  return line;
}

/**
 * Shortest masked value also replaced wherever else it appears in the
 * snapshot (in an accessible name, say). A shorter one would mask ordinary
 * words and numbers of the page.
 */
const MIN_MASKED_ANYWHERE = 4;

/** `text` with every occurrence of each of `values` replaced by MASKED_VALUE. */
function maskEverywhere(text: string, values: string[]): string {
  return values.filter((v) => v.length >= MIN_MASKED_ANYWHERE)
    .reduce((masked, value) => masked.split(value).join(MASKED_VALUE), text);
}

/**
 * Mask what Playwright's ariaSnapshot() shows of masked fields (the rule of
 * shared/src/field-mask.ts): the value of an input or textarea, which it
 * renders after the node (`- textbox "Password": value`, or a `- text:`
 * line below it), becomes `[MASKED]`; the selected option of a select loses
 * its `[selected]`. Then a value of MIN_MASKED_ANYWHERE characters or more
 * is replaced wherever else it is left, such as inside the name of a node
 * that the field labels. The YAML has no link back to the elements, so every
 * line that shows such a value is masked, also one that belongs to another
 * node: it errs on the side of masking.
 */
export function maskAriaSnapshot(yaml: string, masked: MaskedSnapshotTexts): string {
  const shown = (texts: string[]): string[] => texts.map(ariaText).filter((t) => t !== '');
  const values = shown(masked.values);
  const valueEndings = values.flatMap(valueLineEndings);
  // As a name shows inside the double quotes of the YAML.
  const selectedNames = shown(masked.selectedOptions).map((t) => JSON.stringify(t).slice(1, -1));
  if (valueEndings.length === 0 && selectedNames.length === 0) return yaml;
  const byLine = yaml.split('\n').map((line) => maskAriaLine(line, valueEndings, selectedNames)).join('\n');
  return maskEverywhere(byLine, values);
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
