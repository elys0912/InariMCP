/**
 * Shared by the tests/scripts test files that touch the file system.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach } from 'vitest';

export const isWin = process.platform === 'win32';

/**
 * A fresh temporary directory for every test of the calling file (or
 * describe), removed after the test. Returns a getter for its path, valid
 * inside a test or a hook.
 */
export function useTempDir(): () => string {
  let dir: string | undefined;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kitsune-setup-'));
  });
  afterEach(() => {
    // Windows: a file just written may still be open (AV scan, indexer) for a moment.
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    dir = undefined;
  });
  return () => {
    if (dir === undefined) throw new Error('useTempDir: the directory exists only inside a test or a hook');
    return dir;
  };
}
