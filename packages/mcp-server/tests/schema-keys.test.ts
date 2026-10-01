import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ZodTypeAny } from 'zod';
import { TOOL_SCHEMAS } from '../src/tools/schemas.js';
import { PUBLIC_TOOLS } from '../src/tools/public-tools.js';

/** Every object key in a schema, nested ones included, as dotted paths. */
function objectKeys(schema: ZodTypeAny, at: string, out: string[]): string[] {
  if (schema instanceof z.ZodObject) {
    for (const [key, field] of Object.entries(schema.shape as Record<string, ZodTypeAny>)) {
      out.push(`${at}.${key}`);
      objectKeys(field, `${at}.${key}`, out);
    }
  } else if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable || schema instanceof z.ZodDefault) {
    objectKeys(schema._def.innerType as ZodTypeAny, at, out);
  } else if (schema instanceof z.ZodEffects) {
    objectKeys(schema._def.schema as ZodTypeAny, at, out);
  } else if (schema instanceof z.ZodArray) {
    objectKeys(schema.element as ZodTypeAny, `${at}[]`, out);
  } else if (schema instanceof z.ZodDiscriminatedUnion || schema instanceof z.ZodUnion) {
    for (const option of schema.options as ZodTypeAny[]) objectKeys(option, at, out);
  } else if (schema instanceof z.ZodRecord) {
    objectKeys(schema._def.valueType as ZodTypeAny, `${at}{}`, out);
  }
  return out;
}

/**
 * Tool arguments go to the Extension as they come out of zod (no key
 * conversion since camelize.ts was removed), and the Extension reads
 * camelCase. A snake_case schema key would silently never arrive.
 */
describe('tool schema keys', () => {
  it('are all camelCase', () => {
    const snake: string[] = [];
    for (const [name, def] of Object.entries(TOOL_SCHEMAS)) {
      const schema = def.inputSchema;
      const shape = schema instanceof z.ZodObject ? (schema.shape as Record<string, unknown>) : {};
      for (const key of Object.keys(shape)) if (key.includes('_')) snake.push(`${name}.${key}`);
    }
    expect(snake).toEqual([]);
  });

  it('are camelCase at every depth, in the operation schemas and in both schemas of the public tools', () => {
    const keys: string[] = [];
    for (const [name, def] of Object.entries(TOOL_SCHEMAS)) objectKeys(def.inputSchema as ZodTypeAny, name, keys);
    for (const [name, tool] of Object.entries(PUBLIC_TOOLS)) {
      objectKeys(tool.callSchema as ZodTypeAny, `${name}(call)`, keys);
      objectKeys(tool.listSchema, `${name}(list)`, keys);
    }
    // Nested objects are reached (steps of fox_eval_chain, option of fox_set_value, ...).
    expect(keys).toContain('fox_eval_chain.steps[].captureConsole');
    expect(keys).toContain('fox_set_value(call).option.index');
    expect(keys).toContain('fox_tab(list).container.cookieStoreId');
    expect(keys.filter((k) => (k.split('.').at(-1) ?? '').includes('_'))).toEqual([]);
  });
});
