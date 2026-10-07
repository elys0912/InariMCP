/**
 * Starting the shared daemon as a detached process — used by the relays and
 * by the Native Host (its plain-spawn path; on Windows it first tries to
 * start the daemon outside Firefox's job object, native-host outside-job.ts).
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { rotateIfLarge } from './log.js';
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from './paths.js';

export interface DetachedDaemonOptions {
  /** mcp-server's dist/index.js. */
  entry: string;
  /** Where the daemon's stderr is appended (daemon.log). */
  logPath: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Reports a spawn error that happens after the call returned. */
  onError?: (err: Error) => void;
}

/**
 * `node <entry> --daemon`, detached, stdin/stdout cut off, stderr appended
 * to `logPath` (rotated first with copy-truncate: a running daemon may hold
 * it open). The child is unref'd, so neither side keeps the other alive.
 *
 * @returns the child PID (undefined if the OS gave none). Throws when the
 *          spawn itself fails synchronously.
 */
export function spawnDetachedDaemon(options: DetachedDaemonOptions): number | undefined {
  let logFd: number | 'ignore' = 'ignore';
  try {
    fs.mkdirSync(path.dirname(options.logPath), { recursive: true, mode: PRIVATE_DIR_MODE });
    rotateIfLarge(options.logPath, { copyTruncate: true });
    logFd = fs.openSync(options.logPath, 'a', PRIVATE_FILE_MODE);
  } catch {
    // Logging is best-effort
  }

  try {
    const child = spawn(process.execPath, [options.entry, '--daemon'], {
      detached: true,
      stdio: ['ignore', 'ignore', logFd],
      windowsHide: true,
      env: options.env ?? process.env,
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    });
    child.on('error', (err) => options.onError?.(err));
    child.unref();
    return child.pid;
  } finally {
    if (typeof logFd === 'number') {
      try {
        fs.closeSync(logFd);
      } catch {
        // ignore
      }
    }
  }
}
