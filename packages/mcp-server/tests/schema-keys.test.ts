import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { TOOL_SCHEMAS } from '../src/tools/schemas.js';

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
  // TODO(test): nested object keys (e.g. all_tabs options) and non-ZodObject input schemas
});
