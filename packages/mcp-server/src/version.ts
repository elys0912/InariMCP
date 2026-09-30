/**
 * The version of this package, read from its package.json — the only place
 * a version number is written down (the daemon's /health and /daemon/info,
 * the relay's MCP serverInfo, the startup banner and `--version` all use
 * PACKAGE_VERSION).
 *
 * The package compiles to CommonJS (no "type" in package.json), so the file
 * is located with __dirname: src/version.ts (tests) and dist/version.js
 * (runtime) both sit one level below the package root.
 *
 * All workspaces and the Extension's manifest.json carry the same version;
 * tests/contract/versions.test.ts keeps them equal.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Directory holding this package's package.json. */
export const PACKAGE_ROOT = path.resolve(__dirname, '..');

/** Shown when package.json cannot be read (a broken install). */
export const UNKNOWN_VERSION = '0.0.0-unknown';

/** `version` of a package.json / manifest.json, or undefined when unreadable. */
export function readPackageVersion(jsonPath: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const version = (parsed as Record<string, unknown>)['version'];
    return typeof version === 'string' ? version : undefined;
  } catch {
    return undefined;
  }
}

export const PACKAGE_VERSION: string =
  readPackageVersion(path.join(PACKAGE_ROOT, 'package.json')) ?? UNKNOWN_VERSION;
