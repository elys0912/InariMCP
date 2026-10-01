/**
 * The package root of @kitsune-mcp/shared must stay free of Node APIs. The
 * tsconfig enables Node types for the whole package (for src/node; types
 * cannot be scoped per directory), so the compiler would not catch a slip.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const src = fileURLToPath(new URL('../src/', import.meta.url));
const rootFiles = fs.readdirSync(src).filter((f) => f.endsWith('.ts'));

describe('@kitsune-mcp/shared root', () => {
  it.each(rootFiles)('%s uses no Node module or global', (file) => {
    const text = fs.readFileSync(path.join(src, file), 'utf-8');
    expect(text).not.toMatch(/from ['"]node:|require\(|\bprocess\.|\bBuffer\b|from ['"]\.\/node\//);
  });
});
