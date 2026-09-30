/**
 * Contract: one version for the whole repository. The root package.json,
 * every workspace package.json and the Extension's manifest.json carry the
 * same version, and the runtime constants are read from package.json (no
 * literal copies in the sources).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PACKAGE_VERSION } from '../../packages/mcp-server/src/version.js';
import { HOST_VERSION } from '../../packages/native-host/src/version.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function versionOf(rel: string): unknown {
  return (JSON.parse(fs.readFileSync(path.join(root, rel), 'utf-8')) as Record<string, unknown>)['version'];
}

const FILES = [
  'package.json',
  'packages/shared/package.json',
  'packages/mcp-server/package.json',
  'packages/native-host/package.json',
  'packages/extension/package.json',
  'packages/extension/manifest.json',
];

describe('versions', () => {
  it('all package.json files and manifest.json agree', () => {
    const versions = Object.fromEntries(FILES.map((f) => [f, versionOf(f)]));
    const expected = versionOf('packages/extension/manifest.json');
    expect(versions).toEqual(Object.fromEntries(FILES.map((f) => [f, expected])));
  });

  it('runtime constants come from package.json', () => {
    expect(PACKAGE_VERSION).toBe(versionOf('packages/mcp-server/package.json'));
    expect(HOST_VERSION).toBe(versionOf('packages/native-host/package.json'));
  });

  // TODO(test): no version literal (/'\d+\.\d+\.\d+'/) left in packages/*/src outside version.ts
  // TODO(test): GET /health and /daemon/info report PACKAGE_VERSION; Native Host status reports HOST_VERSION
});
