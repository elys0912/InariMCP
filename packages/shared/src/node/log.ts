/**
 * Log helpers shared by the daemon, the relays and the Native Host:
 * size-based rotation, line timestamps, and the `[KitsuneMCP:<role>]`
 * stderr logger.
 */

import * as fs from 'node:fs';
import { errnoCode } from '../util.js';

/** Rotate once a log file grows beyond this (5 MB). */
export const MAX_LOG_BYTES = 5 * 1_048_576;

export interface RotateOptions {
  /**
   * Copy to `<file>.old` and truncate in place instead of renaming. For a
   * file another process keeps open for appending (daemon.log): a rename
   * would make it keep writing to `.old` (Node opens files with delete
   * sharing). Lines written in between are lost, which is acceptable.
   */
  copyTruncate?: boolean;
  /** Called with the error when rotation fails (not for a missing file). */
  onError?: (err: unknown) => void;
}

/**
 * When `filePath` is larger than MAX_LOG_BYTES, move its content to
 * `<file>.old` (replacing an older one). Never throws. Returns true when
 * the file is small enough afterwards (or does not exist); false when the
 * rotation failed (e.g. the file is in use on Windows) — the caller decides
 * when to try again.
 */
export function rotateIfLarge(filePath: string, options: RotateOptions = {}): boolean {
  try {
    if (fs.statSync(filePath).size <= MAX_LOG_BYTES) return true;
    const old = `${filePath}.old`;
    // rename replaces an existing .old on POSIX; on Windows remove it first.
    try {
      fs.rmSync(old, { force: true });
    } catch {
      // the copy / rename below reports the real problem
    }
    if (options.copyTruncate) {
      fs.copyFileSync(filePath, old);
      fs.truncateSync(filePath, 0);
    } else {
      fs.renameSync(filePath, old);
    }
    return true;
  } catch (err: unknown) {
    if (errnoCode(err) === 'ENOENT') return true;
    options.onError?.(err);
    return false;
  }
}

/** `2026-09-30T09:41:14.123Z [1234] ` — the line prefix of daemon.log and native-host.log. */
export function logStamp(now: Date = new Date(), pid: number = process.pid): string {
  return `${now.toISOString()} [${pid}] `;
}

/**
 * Put `stamp` in front of every line of `text`. `atLineStart` says whether
 * the previous write ended with a newline (a line may be written in pieces);
 * the returned value is the state for the next write.
 */
export function stampLines(
  text: string,
  atLineStart: boolean,
  stamp: string,
): { text: string; atLineStart: boolean } {
  let out = '';
  let start = atLineStart;
  for (const part of text.split(/(?<=\n)/)) {
    if (part === '') continue;
    out += (start ? stamp : '') + part;
    start = part.endsWith('\n');
  }
  return { text: out, atLineStart: start };
}

/** A logger writing `[KitsuneMCP:<role>] <msg>` (or `[KitsuneMCP] <msg>`) lines to stderr. Never throws. */
export function stderrLogger(role?: string): (msg: string) => void {
  const prefix = role === undefined ? '[KitsuneMCP]' : `[KitsuneMCP:${role}]`;
  return (msg) => {
    try {
      process.stderr.write(`${prefix} ${msg}\n`);
    } catch {
      // stderr closed — nowhere left to report to
    }
  };
}
