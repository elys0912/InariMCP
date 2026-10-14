/**
 * Tool descriptions / schemas that must match the Extension's behaviour
 * (review 6.High, 3.A1, 5.7; WP5).
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ZodRawShape, ZodTypeAny } from 'zod';
import { TOOL_SCHEMAS } from '../src/tools/schemas.js';
import { PUBLIC_TOOLS } from '../src/tools/public-tools.js';

function shapeOf(tool: keyof typeof PUBLIC_TOOLS): ZodRawShape {
  return PUBLIC_TOOLS[tool].listSchema.shape;
}

describe('tool descriptions', () => {
  it('fox_tabs names its arguments as the schema does (camelCase)', () => {
    const description = PUBLIC_TOOLS.fox_tabs.description;
    expect(description).not.toMatch(/url_pattern|current_window_only/);
    for (const key of ['urlPattern', 'currentWindowOnly']) {
      expect(description).toContain(key);
      expect(shapeOf('fox_tabs')).toHaveProperty(key);
    }
  });

  it('synthetic-event tools say so; fox_type accepts delay 0', () => {
    for (const tool of ['fox_click', 'fox_type', 'fox_press_key', 'fox_interact'] as const) {
      expect(PUBLIC_TOOLS[tool].description).toContain('isTrusted=false');
    }
    const type = TOOL_SCHEMAS['fox_type']!.inputSchema;
    expect(type.safeParse({ text: 'x', delay: 0 }).success).toBe(true);
    expect(type.safeParse({ text: 'x', delay: -1 }).success).toBe(false);
  });
});

/**
 * Identifiers in descriptions that are not arguments: result fields, page
 * and browser API names, JavaScript keywords and the like.
 */
const NOT_ARGUMENTS = new Set([
  'fullPageCaptured', 'currentPageReached', 'ariaSnapshot', 'querySelectorAll', 'ariaLabel',
  'centerX', 'centerY', 'windowId', 'isTrusted', 'return', '$prev', 'reCAPTCHA', 'hCaptcha',
  'contextualIdentities', 'cookieStoreId',
]);

/** Argument names of a schema at any depth. */
function argumentNames(schema: ZodTypeAny, out = new Set<string>()): Set<string> {
  if (schema instanceof z.ZodObject) {
    for (const [key, field] of Object.entries(schema.shape as Record<string, ZodTypeAny>)) {
      out.add(key);
      argumentNames(field, out);
    }
  } else if (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault) {
    argumentNames(schema._def.innerType as ZodTypeAny, out);
  } else if (schema instanceof z.ZodArray) {
    argumentNames(schema.element as ZodTypeAny, out);
  }
  return out;
}

/** camelCase words and back-quoted identifiers of a description. */
function identifiers(description: string): string[] {
  const words = new Set([...description.matchAll(/\b([a-z]+[A-Z][A-Za-z0-9]*)\b/g)].map((m) => m[1]!));
  for (const m of description.matchAll(/`([A-Za-z$][\w$]*)`/g)) words.add(m[1]!);
  return [...words];
}

describe('arguments named in tool descriptions', () => {
  const tools: Array<[string, string, ZodTypeAny]> = Object.entries(PUBLIC_TOOLS)
    .map(([n, t]) => [n, t.description, t.listSchema] as [string, string, ZodTypeAny]);

  it.each(tools)('%s: every camelCase or quoted identifier is an argument or a known non-argument', (_n, description, schema) => {
    const args = argumentNames(schema);
    expect(identifiers(description).filter((w) => !args.has(w) && !NOT_ARGUMENTS.has(w))).toEqual([]);
  });

  it('the non-argument list has no argument names', () => {
    const all = new Set<string>();
    for (const [, , schema] of tools) for (const a of argumentNames(schema)) all.add(a);
    // cookieStoreId is a result field of fox_list_containers and an argument elsewhere.
    expect([...NOT_ARGUMENTS].filter((w) => all.has(w) && w !== 'cookieStoreId')).toEqual([]);
  });
});
