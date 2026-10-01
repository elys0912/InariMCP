import * as fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AnyZodObject, ZodTypeAny } from 'zod';
import { argTimeout, filterAriaSnapshot, ignoredParamWarnings } from '../src/headless/helpers.js';
import { TOOL_SCHEMAS } from '../src/tools/schemas.js';

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
});

describe('HEADLESS_IGNORED against the tool schemas', () => {
  // The table is not exported: read its action / key pairs from the source.
  const source = fs.readFileSync(new URL('../src/headless/helpers.ts', import.meta.url), 'utf-8');
  const block = source.slice(source.indexOf('const HEADLESS_IGNORED'), source.indexOf('export function ignoredParamWarnings'));
  const table = new Map<string, string[]>();
  let action = '';
  for (const line of block.split(/\r?\n/)) {
    const a = /^ {2}(\w+): \[/.exec(line);
    if (a) { action = a[1]!; table.set(action, []); }
    for (const k of line.matchAll(/key: '(\w+)'/g)) table.get(action)!.push(k[1]!);
  }

  // Which tools send which wire action, as recorded by tests/contract/tool-golden.test.ts.
  interface Entry { id: string; tool: string; command: { action: string; data: Record<string, unknown> } | null }
  const golden = JSON.parse(fs.readFileSync(new URL('../../../tests/golden/tool-commands.json', import.meta.url), 'utf-8')) as Entry[];
  const toolsOf = (wire: string) => [...new Set(golden.filter((e) => e.command?.action === wire).map((e) => e.tool))];

  it('was read from the source', () => {
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
