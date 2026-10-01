/**
 * action-names.ts is what the Extension bundles from shared
 * (scripts/build-extension.mjs): it must import nothing (zod would add about
 * 110 KB to the Extension's scripts), and the package root must export the
 * same list without going through actions.ts (which imports zod).
 *
 * TODO(test): bundle a module importing BROWSER_ACTIONS from
 *   @kitsune-mcp/shared with esbuild and check that no zod input is in the
 *   metafile (the extension build checks its own bundles the same way).
 */

import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BROWSER_ACTIONS } from '@kitsune-mcp/shared';
import { BROWSER_ACTIONS as NAMES } from '@kitsune-mcp/shared/action-names';

const read = (file: string): string =>
  fs.readFileSync(fileURLToPath(new URL(`../src/${file}`, import.meta.url)), 'utf-8');

describe('action-names (zod-free, for the Extension)', () => {
  it('imports nothing and is exported directly by the package root', () => {
    expect(read('action-names.ts')).not.toMatch(/^\s*(import|export .* from)\b/m);
    expect(read('index.ts')).toMatch(/^export \* from '\.\/action-names\.js';$/m);
    expect(read('actions.ts')).not.toMatch(/^export .* from '\.\/action-names\.js'/m);
    expect(BROWSER_ACTIONS).toBe(NAMES);
  });
});
