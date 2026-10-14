/**
 * The Native Host's version, read from its package.json (the only place it
 * is written down). CommonJS output: src/version.ts and dist/version.js both
 * sit one level below the package root, hence __dirname + '..'.
 *
 * Same scheme as packages/mcp-server/src/version.ts; all workspaces carry the
 * same version (tests/contract/versions.test.ts).
 */

import * as path from 'node:path';
import { UNKNOWN_VERSION, readPackageVersion } from '@inari-mcp/shared/node';

export const HOST_VERSION: string =
  readPackageVersion(path.resolve(__dirname, '..', 'package.json')) ?? UNKNOWN_VERSION;
