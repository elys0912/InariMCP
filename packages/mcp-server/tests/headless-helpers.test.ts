import * as fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AnyZodObject, ZodTypeAny } from 'zod';
import {
  assertHeadlessReadSelector,
  countOccurrences,
  filterAriaSnapshot,
  HEADLESS_IGNORED,
  ignoredParamWarnings,
  parseArgs,
  playwrightDialectProblem,
} from '../src/headless/helpers.js';
import { CAPTCHA_SELECTORS } from '../src/headless/actions.js';
import { TOOL_SCHEMAS } from '../src/tools/schemas.js';
import { callSchemaFor, resolveOperation } from '../src/tools/operations.js';
import { readExtensionSource } from '../../../tests/contract/helpers/extension-source.js';
import { HEADLESS_COMMAND_TIMEOUT_MS } from '../src/connection/manager.js';
import {
  ELEMENT_TIMEOUT_MS,
  HISTORY_TIMEOUT_MS,
  NAVIGATE_TIMEOUT_MS,
  SELECT_OPTION_TIMEOUT_MS,
} from '../src/headless/limits.js';

describe('parseArgs', () => {
  const schema = z.object({ selector: z.string(), timeout: z.number() });

  it('returns the arguments the schema describes', () => {
    expect(parseArgs(schema, { selector: '#a', timeout: 5, extra: true }, 'wait_for_element'))
      .toEqual({ selector: '#a', timeout: 5 });
  });

  it('names the action and every field at fault when they do not fit', () => {
    // The field names, not zod's wording (H-27).
    let message = '';
    try {
      parseArgs(schema, { timeout: '5' }, 'wait_for_element');
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toMatch(/^Invalid arguments for wait_for_element: /);
    expect(message).toContain('selector');
    expect(message).toContain('timeout');
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

describe('countOccurrences (find_text, H-7)', () => {
  const TEXT = 'Cat cat concatenate. CAT_x (cat)';

  it('counts case-insensitively by default, case-sensitively on request', () => {
    expect(countOccurrences(TEXT, 'cat', false, false)).toBe(5);
    expect(countOccurrences(TEXT, 'cat', true, false)).toBe(3);
  });

  it('entireWord skips matches adjoined by a letter, digit or underscore', () => {
    expect(countOccurrences(TEXT, 'cat', false, true)).toBe(3);
    expect(countOccurrences('café cafés', 'café', false, true)).toBe(1);
  });

  it('reads the query as literal text', () => {
    expect(countOccurrences('a.b axb', 'a.b', false, false)).toBe(1);
    expect(countOccurrences('path\\', 'path\\', false, false)).toBe(1);
    expect(countOccurrences('say "hi"', '"hi"', false, false)).toBe(1);
    expect(countOccurrences('(x)', '(', false, false)).toBe(1);
  });

  it('counts non-overlapping matches and 0 for an empty query', () => {
    expect(countOccurrences('aaaa', 'aa', false, false)).toBe(2);
    expect(countOccurrences('abc', '', false, false)).toBe(0);
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

  it('type clear is honoured with a selector and warned about without one (H-2)', () => {
    expect(ignoredParamWarnings('type', { clear: true, selector: '#a' })).toEqual([]);
    expect(ignoredParamWarnings('type', { clear: true })).toEqual([expect.stringContaining('clear')]);
  });

  it('get_elements warns only for a limit above what headless returns (H-8)', () => {
    expect(ignoredParamWarnings('get_elements', { limit: 10 })).toEqual([]);
    expect(ignoredParamWarnings('get_elements', { limit: 500 })).toEqual([expect.stringContaining('limit')]);
  });

  it('honoured parameters give no warning (H-7, H-15)', () => {
    expect(ignoredParamWarnings('find_text', { caseSensitive: true, entireWord: true })).toEqual([]);
    expect(ignoredParamWarnings('highlight', { duration: 100 })).toEqual([]);
    expect(ignoredParamWarnings('wait_for_element', { visible: false })).toEqual([]);
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
});

describe('HEADLESS_IGNORED against the tool schemas', () => {
  // Action -> ignored keys, from the exported table (H-17: no longer parsed from the source).
  const table = new Map<string, string[]>(
    Object.entries(HEADLESS_IGNORED).map(([action, params]) => [action, (params ?? []).map((p) => p.key)]),
  );

  // Which operations send which wire action, from the tool calls recorded by
  // tests/contract/tool-golden.test.ts.
  interface Entry {
    id: string;
    tool: string;
    args: Record<string, unknown>;
    command: { action: string; data: Record<string, unknown> } | null;
  }
  const golden = JSON.parse(fs.readFileSync(new URL('../../../tests/golden/tool-commands.json', import.meta.url), 'utf-8')) as Entry[];
  const operationOf = (e: Entry): string =>
    resolveOperation(e.tool, callSchemaFor(e.tool)!.parse(e.args) as Record<string, unknown>).op;
  const toolsOf = (wire: string) => [...new Set(golden.filter((e) => e.command?.action === wire).map(operationOf))];

  it('lists the ignored parameters', () => {
    expect(table.size).toBeGreaterThan(10);
    expect(table.get('type')).toContain('pressEnter');
  });

  it('every ignored key is an argument of a tool sending that action', () => {
    for (const [wire, keys] of table) {
      const tools = toolsOf(wire);
      expect(tools.length, wire).toBeGreaterThan(0);
      for (const key of keys) {
        const known = tools.some((t) => key in (TOOL_SCHEMAS[t]!.inputSchema as AnyZodObject).shape);
        expect(known, `${wire}.${key} (${tools.join(', ')})`).toBe(true);
      }
    }
  });

  it('an argument left at its schema default produces no warning', () => {
    let checked = 0;
    for (const [wire, keys] of table) {
      for (const key of keys) {
        for (const tool of toolsOf(wire)) {
          const field = (TOOL_SCHEMAS[tool]!.inputSchema as AnyZodObject).shape[key] as ZodTypeAny | undefined;
          if (!(field instanceof z.ZodDefault)) continue;
          const def: unknown = (field._def.defaultValue as () => unknown)();
          expect(ignoredParamWarnings(wire, { [key]: def }), `${tool} ${wire}.${key} = ${JSON.stringify(def)}`).toEqual([]);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(10);
  });
});

describe('captcha detection: the same strings as the Extension (H-12)', () => {
  it('every selector and token name of CAPTCHA_SELECTORS appears in content/captcha.ts', () => {
    const extension = readExtensionSource('content/captcha.ts');
    for (const [name, value] of Object.entries(CAPTCHA_SELECTORS)) {
      expect(extension, name).toContain(value);
    }
  });
});

describe('step timeouts stay below the headless command timeout (R-3)', () => {
  it('every single-step timeout, and the two waits of type / set_value together, end first', () => {
    for (const ms of [NAVIGATE_TIMEOUT_MS, HISTORY_TIMEOUT_MS, ELEMENT_TIMEOUT_MS, SELECT_OPTION_TIMEOUT_MS]) {
      expect(ms).toBeLessThan(HEADLESS_COMMAND_TIMEOUT_MS);
    }
    expect(2 * ELEMENT_TIMEOUT_MS).toBeLessThan(HEADLESS_COMMAND_TIMEOUT_MS);
    expect(2 * SELECT_OPTION_TIMEOUT_MS).toBeLessThan(HEADLESS_COMMAND_TIMEOUT_MS);
  });
});

describe('selectors of the headless reading actions: plain CSS only', () => {
  it.each([
    ['an xpath= engine', "xpath=//input[@type='hidden'][starts-with(@value,'a')]"],
    ['an XPath without a prefix', '//input[starts-with(@value,"a")]'],
    ['an XPath in parentheses', '(//option)[1]'],
    ['a parent XPath', '..'],
    ['a role engine', 'role=option[selected]'],
    ['an internal engine', 'internal:role=option[selected=true]'],
    ['a text engine', 'text=Card'],
    ['a css= prefix (still an engine name)', 'css=option'],
    ['an engine with spaces around =', ' xpath = //input'],
    ['a capturing engine', '*css=select'],
    ['a chain', 'select >> internal:role=option[selected]'],
    ['a quoted text selector', '"Card number"'],
  ])('refuses %s', (_what, selector) => {
    expect(playwrightDialectProblem(selector)).not.toBeNull();
    expect(() => assertHeadlessReadSelector(selector)).toThrow(/^Selector refused: .*CSS selector only/);
  });

  it.each([
    ['an id', '#login'],
    ['an attribute with = inside the brackets', 'a[href="https://a.test/?q=1"]'],
    ['a type and a name', 'input[type=hidden][name=csrf]'],
    ['a child combinator', 'ul > li:nth-child(2)'],
  ])('accepts %s', (_what, selector) => {
    expect(playwrightDialectProblem(selector)).toBeNull();
    expect(() => assertHeadlessReadSelector(selector)).not.toThrow();
  });

  it('refuses what the Extension refuses as well', () => {
    expect(() => assertHeadlessReadSelector('option[selected]')).toThrow(/^Selector refused: it tests the value or selected attribute/);
  });
});
