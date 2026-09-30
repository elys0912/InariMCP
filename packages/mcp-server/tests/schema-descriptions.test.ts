/**
 * Tool descriptions / schemas that must match the Extension's behaviour
 * (review 6.High, 3.A1, 5.7; WP5).
 *
 * TODO(test): every argument name mentioned in a description is a key of
 *   that tool's schema (generic check over TOOL_SCHEMAS).
 */

import { describe, expect, it } from 'vitest';
import type { ZodObject, ZodRawShape } from 'zod';
import { TOOL_SCHEMAS } from '../src/tools/schemas.js';

function shapeOf(tool: string): ZodRawShape {
  return (TOOL_SCHEMAS[tool]!.inputSchema as ZodObject<ZodRawShape>).shape;
}

describe('tool descriptions', () => {
  it('fox_get_tabs names its arguments as the schema does (camelCase)', () => {
    const description = TOOL_SCHEMAS['fox_get_tabs']!.description;
    expect(description).not.toMatch(/url_pattern|current_window_only/);
    for (const key of ['urlPattern', 'currentWindowOnly']) {
      expect(description).toContain(key);
      expect(shapeOf('fox_get_tabs')).toHaveProperty(key);
    }
  });

  it('synthetic-event tools say so; fox_type accepts delay 0', () => {
    for (const tool of ['fox_hover', 'fox_press_key']) {
      expect(TOOL_SCHEMAS[tool]!.description).toContain('isTrusted=false');
    }
    const type = TOOL_SCHEMAS['fox_type']!.inputSchema;
    expect(type.safeParse({ text: 'x', delay: 0 }).success).toBe(true);
    expect(type.safeParse({ text: 'x', delay: -1 }).success).toBe(false);
  });
});
