/**
 * The Native Host's version, read from its package.json (the only place it
 * is written down). CommonJS output: src/version.ts and dist/version.js both
 * sit one level below the package root, hence __dirname + '..'.
 *
 * Same scheme as packages/mcp-server/src/version.ts; all workspaces carry the
 * same version (tests/contract/versions.test.ts).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

function readVersion(): string {
  try {
    const pkg: unknown = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf-8'),
    );
    const version = typeof pkg === 'object' && pkg !== null ? (pkg as Record<string, unknown>)['version'] : undefined;
    if (typeof version === 'string') return version;
  } catch {
    // fall through
  }
  return '0.0.0-unknown';
}

export const HOST_VERSION: string = readVersion();
