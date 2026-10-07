import { describe, expect, it } from 'vitest';
import { TOOL_SCHEMAS } from '../src/tools/schemas.js';
import { LEGACY_REPLACEMENTS, PUBLIC_TOOLS } from '../src/tools/public-tools.js';
import { callSchemaFor, deprecationNote, resolveOperation } from '../src/tools/operations.js';

describe('public tools and operations', () => {
  it('every operation is a public tool or a replaced name', () => {
    for (const op of Object.keys(TOOL_SCHEMAS)) {
      expect(op in PUBLIC_TOOLS || op in LEGACY_REPLACEMENTS, op).toBe(true);
    }
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
      label: { tool: 'fox_get_text', args: { maxLength: 5 }, replacedBy: 'fox_read' },
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
});

