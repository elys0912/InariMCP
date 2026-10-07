/**
 * Process-level error handlers for both roles of dist/index.js.
 *
 * Policy (4.A8):
 *  - uncaughtException → log and exit(1). The process state is unknown
 *    after one, so it is not safe to keep serving. The daemon is restarted
 *    on demand (next relay call, or the Native Host's health monitor); a
 *    relay is restarted by Claude Code. Errors that are expected at run
 *    time (bad frames, bad requests, vanished files) are handled where they
 *    happen and never get here.
 *  - unhandledRejection → log and continue. A forgotten `.catch()` on one
 *    request must not end the daemon for every session.
 *  - stdout 'error' → the relay's stdout is the MCP stream: EPIPE (or a
 *    destroyed stream) means Claude Code went away, so exit(0) quietly;
 *    any other error is logged and exits 1. The daemon's stdout is
 *    discarded (spawned with stdio 'ignore'), so errors are only logged.
 *  - stderr 'error' → ignored: stderr is where we would report it, and a
 *    closed log pipe is no reason to stop.
 */

export type ProcessRole = 'daemon' | 'relay';

export type StdoutErrorAction = 'exit-clean' | 'exit-error' | 'ignore';

/** Error codes meaning "the reader of our stdout is gone". */
const PIPE_GONE = new Set(['EPIPE', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END', 'ECONNRESET']);

export function stdoutErrorAction(role: ProcessRole, err: unknown): StdoutErrorAction {
  if (role === 'daemon') return 'ignore';
  const code = err instanceof Error && 'code' in err ? String(err.code) : '';
  return PIPE_GONE.has(code) ? 'exit-clean' : 'exit-error';
}

function describe(reason: unknown): string {
  return reason instanceof Error ? `${reason.message}\n${reason.stack ?? ''}` : String(reason);
}

export interface ProcessHandlerDeps {
  exit: (code: number) => void;
  log: (line: string) => void;
}

export interface ProcessHandlers {
  uncaughtException: (err: unknown) => void;
  unhandledRejection: (reason: unknown) => void;
  stdoutError: (err: unknown) => void;
}

/** The handlers, with exit/log injectable for tests. */
export function createProcessHandlers(role: ProcessRole, deps: ProcessHandlerDeps): ProcessHandlers {
  const prefix = `[KitsuneMCP:${role}]`;
  return {
    uncaughtException: (err) => {
      deps.log(`${prefix} FATAL uncaughtException: ${describe(err)}`);
      deps.exit(1);
    },
    unhandledRejection: (reason) => {
      deps.log(`${prefix} unhandledRejection (continuing): ${describe(reason)}`);
    },
    stdoutError: (err) => {
      const action = stdoutErrorAction(role, err);
      if (action === 'exit-clean') {
        deps.log(`${prefix} stdout closed by the client — exiting`);
        deps.exit(0);
        return;
      }
      deps.log(`${prefix} stdout error: ${describe(err)}`);
      if (action === 'exit-error') deps.exit(1);
    },
  };
}

export function installProcessHandlers(role: ProcessRole): void {
  const handlers = createProcessHandlers(role, {
    exit: (code) => process.exit(code),
    log: (line) => {
      try {
        process.stderr.write(`${line}\n`);
      } catch {
        // Nowhere left to report to
      }
    },
  });
  process.on('uncaughtException', handlers.uncaughtException);
  process.on('unhandledRejection', handlers.unhandledRejection);
  process.stdout.on('error', handlers.stdoutError);
  process.stderr.on('error', () => { /* see header */ });
}
