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

// ---------------------------------------------------------------------------
// Timestamps for daemon.log
// ---------------------------------------------------------------------------

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

/** `2026-09-30T09:41:14.123Z [1234] ` — the same line prefix as native-host.log. */
export function logStamp(now: Date = new Date(), pid: number = process.pid): string {
  return `${now.toISOString()} [${pid}] `;
}

/**
 * Prefix every line the process writes to stderr with a timestamp and the
 * PID. Used by the daemon, whose stderr is ~/.kitsune-mcp/logs/daemon.log:
 * every module logs with process.stderr.write, so the stream is wrapped once
 * instead of changing each logger.
 */
export function installStderrTimestamps(
  stream: NodeJS.WriteStream = process.stderr,
  stamp: () => string = () => logStamp(),
): void {
  let atLineStart = true;
  const original = stream.write.bind(stream) as (chunk: string, cb?: (err?: Error | null) => void) => boolean;
  const write = (
    chunk: string | Uint8Array,
    encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
    cb?: (err?: Error | null) => void,
  ): boolean => {
    const text =
      typeof chunk === 'string'
        ? typeof encodingOrCb === 'string' && encodingOrCb !== 'utf8' && encodingOrCb !== 'utf-8'
          ? Buffer.from(chunk, encodingOrCb).toString('utf-8')
          : chunk
        : Buffer.from(chunk).toString('utf-8');
    const stamped = stampLines(text, atLineStart, stamp());
    atLineStart = stamped.atLineStart;
    return original(stamped.text, typeof encodingOrCb === 'function' ? encodingOrCb : cb);
  };
  stream.write = write as typeof stream.write;
}
