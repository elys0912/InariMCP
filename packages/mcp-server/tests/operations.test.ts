import { describe, expect, it } from 'vitest';
import { PUBLIC_TOOLS } from '../src/tools/public-tools.js';
import { callSchemaFor, deprecationNote, describeTool, resolveOperation } from '../src/tools/operations.js';

// Every operation is a public tool or a replaced name: the type of
// LEGACY_REPLACEMENTS (Record<LegacyOperationName, ...>) checks that.
describe('public tools and operations', () => {
  // InariMCP (AMO): the script and logging tools are gone, under every name.
  it.each([
    'fox_evaluate', 'fox_observer', 'fox_logging', 'fox_get_logs',
    'fox_execute_script', 'fox_eval_chain', 'fox_wait_and_act', 'fox_inject_observer', 'fox_remove_observer',
    'fox_start_logging', 'fox_stop_logging', 'fox_get_console_logs', 'fox_get_network_logs', 'fox_clear_logs',
  ])('%s is not callable', (name) => {
    expect(callSchemaFor(name)).toBeNull();
    expect(describeTool(name)).toBeNull();
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

  // Which variants use / require an argument and that a default is noted at
  // all is checked for every grouped tool in tests/contract/public-tools.test.ts;
  // the spelling of a per-variant default is only checked here.
  it('listSchema notes a per-variant default as "<value> (<variant>)"', () => {
    const shape = PUBLIC_TOOLS['fox_wait']!.listSchema.shape as Record<string, { description?: string }>;
    expect(shape['timeout']!.description).toContain('10000 (element)');
  });

  // G-21 (d): the callers parse with callSchemaFor() first, which refuses
  // both; resolveOperation() itself does not guess.
  it('throws for an unknown variant and for a name that is no tool', () => {
    expect(() => resolveOperation('fox_wait', { for: 'nothing' })).toThrow("fox_wait: unknown for 'nothing'");
    expect(() => resolveOperation('fox_tab', {})).toThrow("fox_tab: unknown action 'undefined'");
    expect(() => resolveOperation('fox_no_such_tool', {})).toThrow('fox_no_such_tool: unknown tool');
  });

  // G-25: the classes as a list next to the joined string.
  it('describeTool gives the classes of every operation a tool can run', () => {
    expect(describeTool('fox_tab')).toMatchObject({ classification: 'act|interact', classifications: ['act', 'interact'] });
    expect(describeTool('fox_get_text')).toMatchObject({ classification: 'observe', classifications: ['observe'] });
    expect(describeTool('fox_no_such_tool')).toBeNull();
  });
});

// G-4: the audit log shows a call the same way whichever name it was made
// by: the defaults of the public tool's schema in both.
describe('audited arguments by public and deprecated name', () => {
  it.each([
    ['fox_get_text', {}, 'fox_read', { mode: 'text' }],
    ['fox_scroll', { direction: 'down' }, 'fox_interact', { action: 'scroll', direction: 'down' }],
    ['fox_wait_for_element', { selector: '#a' }, 'fox_wait', { for: 'element', selector: '#a' }],
  ] as const)('%s and %s', (legacy, legacyArgs, tool, toolArgs) => {
    const viaLegacy = resolveOperation(legacy, callSchemaFor(legacy)!.parse(legacyArgs) as Record<string, unknown>);
    const viaTool = resolveOperation(tool, callSchemaFor(tool)!.parse(toolArgs) as Record<string, unknown>);
    expect(viaLegacy.label.auditArgs).toEqual(viaTool.label.args);
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
    ['fox_read', { mode: 'text' }, 'maxLength', 1],
    ['fox_find', { by: 'selector', selector: 'a' }, 'limit', 1],
    ['fox_tabs', { what: 'tabs' }, 'limit', 1],
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
