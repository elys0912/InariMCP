import { describe, expect, it } from 'vitest';
import { TOOL_SCHEMAS } from '../src/tools/schemas.js';
import { LEGACY_REPLACEMENTS, PUBLIC_TOOLS } from '../src/tools/public-tools.js';
import { callSchemaFor, deprecationNote, resolveOperation } from '../src/tools/operations.js';

describe('public tools and operations', () => {
  it('every operation is a public tool or a replaced name', () => {
    for (const op of Object.keys(TOOL_SCHEMAS)) {
      expect(op in PUBLIC_TOOLS || op in LEGACY_REPLACEMENTS, op).toBe(true);
    }
    expect(Object.keys(PUBLIC_TOOLS)).toHaveLength(21);
  });

  it('fox_tab create with a container runs fox_open_in_container with the old argument names', () => {
    const args = callSchemaFor('fox_tab')!.parse({
      action: 'create', url: 'https://example.test/', container: { cookieStoreId: 'firefox-container-1' },
    }) as Record<string, unknown>;
    const call = resolveOperation('fox_tab', args);
    expect(call.op).toBe('fox_open_in_container');
    expect(call.args).toEqual({ url: 'https://example.test/', cookieStoreId: 'firefox-container-1', active: true });
    expect(call.label).toEqual({ tool: 'fox_tab', args });
  });

  it('a replaced name runs as is and is labelled with its replacement', () => {
    const call = resolveOperation('fox_get_text', { maxLength: 5 });
    expect(call).toEqual({
      op: 'fox_get_text',
      args: { maxLength: 5 },
      label: {
        tool: 'fox_get_text',
        args: { maxLength: 5 },
        replacedBy: 'fox_read',
        auditArgs: { mode: 'text', maxLength: 5 },
      },
    });
    expect(deprecationNote('fox_get_text')).toBe("fox_get_text is deprecated; use fox_read with mode='text'.");
    expect(deprecationNote('fox_audit_page')).toMatch(/not implemented on any backend/);
    expect(deprecationNote('fox_click')).toBeNull();
  });

  it('tool annotations fold the variants: readOnlyHint AND, destructiveHint OR', () => {
    expect(PUBLIC_TOOLS['fox_tab']!.annotations).toEqual({ readOnlyHint: false, destructiveHint: true });
    expect(PUBLIC_TOOLS['fox_get_logs']!.annotations).toEqual({ readOnlyHint: true, destructiveHint: false });
    expect(PUBLIC_TOOLS['fox_interact']!.annotations).toEqual({ readOnlyHint: false, destructiveHint: false });
  });

  it('listSchema is a flat object with the discriminator required', () => {
    const shape = PUBLIC_TOOLS['fox_wait']!.listSchema.shape as Record<string, { isOptional(): boolean; description?: string }>;
    expect(shape['for']!.isOptional()).toBe(false);
    expect(shape['selector']!.isOptional()).toBe(true);
    expect(shape['selector']!.description).toMatch(/^\(for=element; required\)/);
    expect(shape['timeout']!.description).toContain('10000 (element)');
  });
});


// WP-G P-5: a call by a deprecated name is audited in the form the public
// tool takes it, so that it parses as a call of that tool to the same
// operation arguments.
describe('auditArgs of a deprecated name', () => {
  it.each([
    ['fox_find_text', { query: 'Total' }, { by: 'text', text: 'Total' }],
    ['fox_open_in_container', { url: 'https://example.test/', containerName: 'Work' },
      { action: 'create', url: 'https://example.test/', container: { name: 'Work' } }],
    ['fox_select_option', { selector: '#s', index: 2 }, { kind: 'select', selector: '#s', option: { index: 2 } }],
    ['fox_wait_and_act', { condition: 'true', actionScript: '1', timeoutMs: 500 },
      { mode: 'wait_and_act', condition: 'true', actionScript: '1', timeout: 500 }],
  ] as const)('%s: discriminator first, arguments renamed back', (name, called, expected) => {
    const opArgs = callSchemaFor(name)!.parse(called) as Record<string, unknown>;
    const { label } = resolveOperation(name, opArgs);
    expect(label.args).toBe(opArgs);
    expect(label.auditArgs).toMatchObject(expected);
    expect(Object.keys(label.auditArgs!)[0]).toBe(Object.keys(expected)[0]);

    const publicArgs = callSchemaFor(label.replacedBy!)!.parse(label.auditArgs) as Record<string, unknown>;
    expect(resolveOperation(label.replacedBy!, publicArgs)).toMatchObject({ op: name, args: opArgs });
  });
});

// WP-G P-1 (C-3): fox_navigate goes to its url only for goto.
describe('fox_navigate url', () => {
  const navigate = callSchemaFor('fox_navigate')!;

  it('goto, the default action, requires a url', () => {
    expect(navigate.safeParse({ url: 'https://example.test/' }).success).toBe(true);
    expect(navigate.safeParse({ action: 'goto', url: 'https://example.test/' }).success).toBe(true);
    for (const args of [{}, { action: 'goto' }, { action: 'goto', url: '' }]) {
      const parsed = navigate.safeParse(args);
      expect(parsed.success, JSON.stringify(args)).toBe(false);
      expect(parsed.error?.issues[0]?.message).toBe('url is required for goto');
    }
  });

  it.each(['back', 'forward', 'refresh', 'hard_refresh'])('%s refuses a url and runs without one', (action) => {
    expect(navigate.safeParse({ action }).success).toBe(true);
    const parsed = navigate.safeParse({ action, url: 'https://example.test/' });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(['url']);
  });
});

// WP-G T-3: numeric arguments the backends use as counts, sizes or waits
// have a lower bound (0 where "none" makes sense, else 1).
describe('lower bounds of numeric arguments', () => {
  it.each([
    ['fox_evaluate', { mode: 'wait_and_act', condition: 'true', actionScript: '1' }, 'pollIntervalMs', 1],
    ['fox_evaluate', { mode: 'wait_and_act', condition: 'true', actionScript: '1' }, 'timeout', 1],
    ['fox_read', { mode: 'text' }, 'maxLength', 1],
    ['fox_find', { by: 'selector', selector: 'a' }, 'limit', 1],
    ['fox_tabs', { what: 'tabs' }, 'limit', 1],
    ['fox_get_logs', { kind: 'console' }, 'limit', 1],
    ['fox_get_logs', { kind: 'network' }, 'limit', 1],
    ['fox_interact', { action: 'scroll' }, 'amount', 0],
    ['fox_interact', { action: 'highlight', selector: 'a' }, 'duration', 1],
    ['fox_wait', { for: 'network_idle' }, 'idleTime', 0],
    ['fox_screenshot', { scope: 'scroll_capture' }, 'delay', 0],
    ['fox_screenshot', { scope: 'scroll_capture' }, 'maxScrolls', 1],
    ['fox_screenshot', { scope: 'scroll_capture' }, 'scrollStep', 1],
  ] as const)('%s %s: %s accepts %d, not less', (tool, base, key, min) => {
    const schema = callSchemaFor(tool)!;
    expect(schema.safeParse({ ...base, [key]: min }).success).toBe(true);
    expect(schema.safeParse({ ...base, [key]: min - 1 }).success).toBe(false);
  });

  it('fox_set_value select: option.index is not negative', () => {
    const schema = callSchemaFor('fox_set_value')!;
    expect(schema.safeParse({ kind: 'select', selector: '#s', option: { index: 0 } }).success).toBe(true);
    expect(schema.safeParse({ kind: 'select', selector: '#s', option: { index: -1 } }).success).toBe(false);
  });
});
