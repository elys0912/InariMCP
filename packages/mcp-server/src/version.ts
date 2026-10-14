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

import * as path from 'node:path';
import { readPackageVersion, UNKNOWN_VERSION } from '@inari-mcp/shared/node';

/** Directory holding this package's package.json. */
export const PACKAGE_ROOT = path.resolve(__dirname, '..');

/** Shown when package.json cannot be read (a broken install). */
export { UNKNOWN_VERSION, readPackageVersion };

export const PACKAGE_VERSION: string =
  readPackageVersion(path.join(PACKAGE_ROOT, 'package.json')) ?? UNKNOWN_VERSION;
