/**
 * Native Host logging.
 *
 * The Native Host is a Firefox child process: its stderr goes nowhere a user
 * can see. Every line is therefore written to stderr (as before) and also
 * appended to a log file:
 *
 *   FOX_NATIVE_HOST_LOG unset / empty → ~/.kitsune-mcp/logs/native-host.log
 *   FOX_NATIVE_HOST_LOG=0 | off | false | none → file logging disabled
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
import * as os from 'node:os';
import * as path from 'node:path';
import { ENV } from '@kitsune-mcp/shared';

const PREFIX = '[KitsuneMCP:NativeHost]';
/** Rotate once the file grows beyond this (5 MB). */
export const MAX_LOG_BYTES = 5 * 1_048_576;
/** After a failed rotation, try again no sooner than this (not on every line). */
export const ROTATE_RETRY_MS = 60_000;

const DISABLED_VALUES = new Set(['0', 'off', 'false', 'no', 'none']);

/** Resolved log file path, or undefined when file logging is disabled. */
export function resolveLogPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env[ENV.FOX_NATIVE_HOST_LOG]?.trim();
  if (raw === undefined || raw === '') {
    return path.join(os.homedir(), '.kitsune-mcp', 'logs', 'native-host.log');
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
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Non-POSIX filesystems
  }
}

/**
 * Rename `filePath` to `<file>.old` when it is larger than MAX_LOG_BYTES.
 * Also used for daemon.log (server-launcher.ts), which a running daemon keeps
 * open for appending: with `copyTruncate` the content is copied to
 * `<file>.old` and the file truncated in place, so the daemon keeps writing to
 * the right file (lines written in between are lost, which is acceptable).
 * Returns true when the file is small enough afterwards (or does not exist).
 */
export function rotateIfLarge(filePath: string, copyTruncate = false): boolean {
  try {
    const st = fs.statSync(filePath);
    if (st.size <= MAX_LOG_BYTES) return true;
    // rename replaces an existing .old on POSIX; on Windows remove it first.
    const old = `${filePath}.old`;
    try {
      fs.rmSync(old, { force: true });
    } catch {
      // ignore — rename below reports the real problem
    }
    if (copyTruncate) {
      // The file is held open by another process: a rename would only make it
      // keep writing to `.old` (Node opens files with delete sharing).
      fs.copyFileSync(filePath, old);
      fs.truncateSync(filePath, 0);
    } else {
      fs.renameSync(filePath, old);
    }
    return true;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return true;
    // e.g. another host process (second Firefox profile) holds the file
    // open on Windows. Keep appending; the caller decides when to retry.
    stderrNote(`log rotation skipped: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

function openSink(filePath: string): FileSink | null {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    rotateIfLarge(filePath);
    const fd = fs.openSync(filePath, 'a', 0o600);
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
  writeToFile(`${new Date().toISOString()} [${process.pid}] ${line}`);
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
