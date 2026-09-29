import * as fs from 'node:fs';

/** Rotate once a log file grows beyond this (5 MB), like native-host.log. */
export const MAX_LOG_BYTES = 5 * 1_048_576;

/**
 * When `filePath` is larger than MAX_LOG_BYTES, rename it to `<file>.old`
 * (replacing an older one) so the next open starts a new file. Same scheme
 * as the Native Host's own log (native-host/src/logger.ts).
 *
 * Best-effort: a missing file is fine, and any other failure (e.g. another
 * process holds the file open on Windows) leaves the file as it is — the
 * next call tries again. Never throws.
 */
export function rotateLogIfLarge(filePath: string): void {
  try {
    if (fs.statSync(filePath).size <= MAX_LOG_BYTES) return;
    const old = `${filePath}.old`;
    // rename replaces an existing .old on POSIX; on Windows remove it first.
    fs.rmSync(old, { force: true });
    fs.renameSync(filePath, old);
  } catch {
    // ENOENT, or the file is in use — keep appending
  }
}
