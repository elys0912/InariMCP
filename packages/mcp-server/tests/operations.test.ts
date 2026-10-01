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
      label: { tool: 'fox_get_text', args: { maxLength: 5 }, replacedBy: 'fox_read' },
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

