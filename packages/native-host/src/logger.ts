/**
 * Native Host logging.
 *
 * The Native Host is a Firefox child process: its stderr goes nowhere a user
 * can see. Every line is therefore written to stderr (as before) and also
 * appended to a log file:
 *
 *   FOX_NATIVE_HOST_LOG unset / blank → ~/.kitsune-mcp/logs/native-host.log
 *   FOX_NATIVE_HOST_LOG=0 | off | false | no | none → file logging disabled
 *   FOX_NATIVE_HOST_LOG=<path>        → that file
 *
 * Hardening / housekeeping:
 *  - directory created 0o700, file 0o600 (POSIX; ignored on Windows) — the
 *    same policy as screenshot-store.ts
 *  - when the file exceeds MAX_LOG_BYTES it is renamed to `<file>.old`
 *    (replacing an older one) and a new file is started, as the fork source
 *    did. Checked at startup and while writing.
 *  - a failed rotation (e.g. another process holds the file open on Windows)
 *    is retried at most once per ROTATE_RETRY_MS, not on every line.
 *  - a failure to open / write the file never breaks the host: file logging
 *    is switched off and a note goes to stderr.
 *
 * Callers must never pass secrets (API token, header values) to log().
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ENV } from '@kitsune-mcp/shared';
import {
  MAX_LOG_BYTES,
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE,
  logStamp,
  nativeHostLogPath,
  rotateIfLarge as rotateFile,
} from '@kitsune-mcp/shared/node';

const PREFIX = '[KitsuneMCP:NativeHost]';
export { MAX_LOG_BYTES };
/** After a failed rotation, try again no sooner than this (not on every line). */
export const ROTATE_RETRY_MS = 60_000;

const DISABLED_VALUES = new Set(['0', 'off', 'false', 'no', 'none']);

/** Resolved log file path, or undefined when file logging is disabled. */
export function resolveLogPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env[ENV.FOX_NATIVE_HOST_LOG]?.trim();
  if (raw === undefined || raw === '') {
    return nativeHostLogPath();
  }
  if (DISABLED_VALUES.has(raw.toLowerCase())) return undefined;
  return path.resolve(raw);
}

interface FileSink {
  path: string;
  fd: number;
  size: number;
}

/** undefined = not opened yet, null = disabled (by config or after an error). */
let sink: FileSink | null | undefined;
/** Earliest time (ms) the next rotation attempt is allowed after a failed one. */
let nextRotateAttempt = 0;

function stderrNote(msg: string): void {
  try {
    process.stderr.write(`${PREFIX} ${msg}\n`);
  } catch {
    // stderr closed — nothing else to do
  }
}

function tighten(filePath: string): void {
  try {
    fs.chmodSync(filePath, PRIVATE_FILE_MODE);
  } catch {
    // Non-POSIX filesystems
  }
}

/**
 * Rotate `filePath` when it is larger than MAX_LOG_BYTES (shared/node log.ts).
 * `copyTruncate` for daemon.log, which a running daemon keeps open.
 * A failure is noted on stderr; returns false then (the caller decides when
 * to retry), true when the file is small enough or does not exist.
 */
export function rotateIfLarge(filePath: string, copyTruncate = false): boolean {
  return rotateFile(filePath, {
    copyTruncate,
    // e.g. another host process (second Firefox profile) holds the file open on Windows
    onError: (err) => stderrNote(`log rotation skipped: ${err instanceof Error ? err.message : String(err)}`),
  });
}

function openSink(filePath: string): FileSink | null {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: PRIVATE_DIR_MODE });
    rotateIfLarge(filePath);
    const fd = fs.openSync(filePath, 'a', PRIVATE_FILE_MODE);
    tighten(filePath);
    const size = fs.fstatSync(fd).size;
    // Still too large: the rotation failed, so do not retry on every line.
    if (size > MAX_LOG_BYTES) nextRotateAttempt = Date.now() + ROTATE_RETRY_MS;
    return { path: filePath, fd, size };
  } catch (err: unknown) {
    stderrNote(
      `file logging disabled (${filePath}): ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

function getSink(): FileSink | null {
  if (sink === undefined) {
    const filePath = resolveLogPath();
    sink = filePath === undefined ? null : openSink(filePath);
  }
  return sink;
}

function closeSink(s: FileSink): void {
  try {
    fs.closeSync(s.fd);
  } catch {
    // already closed
  }
}

function writeToFile(line: string): void {
  let s = getSink();
  if (s === null) return;

  if (s.size > MAX_LOG_BYTES && Date.now() >= nextRotateAttempt) {
    closeSink(s);
    sink = openSink(s.path);
    s = sink;
    if (s === null) return;
  }

  try {
    const buf = Buffer.from(line, 'utf-8');
    fs.writeSync(s.fd, buf);
    s.size += buf.length;
  } catch (err: unknown) {
    closeSink(s);
    sink = null;
    stderrNote(`file logging disabled after write error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Log one line to stderr and to the log file. */
export function log(msg: string): void {
  const line = `${PREFIX} ${msg}\n`;
  try {
    process.stderr.write(line);
  } catch {
    // stderr closed
  }
  writeToFile(`${logStamp()}${line}`);
}

/** Forget the open file and any retry delay (tests). */
export function resetLoggerForTests(): void {
  if (sink) closeSink(sink);
  sink = undefined;
  nextRotateAttempt = 0;
}

/** Path of the active log file (undefined when disabled). For the startup banner. */
export function activeLogPath(): string | undefined {
  const s = getSink();
  return s === null ? undefined : s.path;
}
