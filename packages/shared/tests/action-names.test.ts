/**
 * action-names.ts is what the Extension bundles from shared
 * (scripts/build-extension.mjs): it must import nothing (zod would add about
 * 110 KB to the Extension's scripts), and the package root must export the
 * same list without going through actions.ts (which imports zod).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
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

describe('a browser bundle importing BROWSER_ACTIONS from the package root', () => {
  // Same resolution as scripts/build-extension.mjs: the shared sources, not dist.
  const src = fileURLToPath(new URL('../src/', import.meta.url));
  const entries: Record<string, string> = {
    '@kitsune-mcp/shared': path.join(src, 'index.ts'),
    '@kitsune-mcp/shared/action-names': path.join(src, 'action-names.ts'),
  };

  it.each(Object.keys(entries))('from %s contains no zod and no Node helpers', async (specifier) => {
    const result = await build({
      stdin: { contents: `import { BROWSER_ACTIONS } from '${specifier}'; console.log(BROWSER_ACTIONS.length);`, resolveDir: src, loader: 'ts' },
      bundle: true,
      write: false,
      format: 'iife',
      platform: 'browser',
      metafile: true,
      logLevel: 'silent',
      plugins: [{
        name: 'kitsune-shared',
        setup(b) {
          b.onResolve({ filter: /^@kitsune-mcp\/shared(\/|$)/ }, (args) => ({ path: entries[args.path]! }));
        },
      }],
    });
    const inputs = Object.values(result.metafile.outputs).flatMap((o) => Object.keys(o.inputs))
      .map((i) => i.split(path.sep).join('/'));
    expect(inputs.some((i) => i.endsWith('action-names.ts'))).toBe(true);
    expect(inputs.filter((i) => /(^|\/)node_modules\/zod\//.test(i) || /shared\/src\/node\//.test(i))).toEqual([]);
  });
});
