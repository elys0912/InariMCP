/**
 * Process-level error handlers of the Native Host.
 *
 * Policy (4.A8, same as the MCP server's utils/process-handlers.ts):
 *  - uncaughtException → log and exit(1). The state is unknown after one;
 *    Firefox starts a new Native Host when the Extension reconnects.
 *  - unhandledRejection → log and continue (one lost promise must not cut
 *    the Extension off).
 *  - stdout 'error' → stdout is the Native Messaging channel to Firefox.
 *    EPIPE (or a destroyed stream) means Firefox closed it: exit(0) quietly.
 *    Any other error is logged and exits 1 — without stdout we cannot
 *    answer the Extension.
 *  - stderr 'error' → ignored (Firefox's console; nothing to do about it).
 *
 * The daemon is never stopped from here (it serves other sessions too).
 */

export type StdoutErrorAction = 'exit-clean' | 'exit-error';

/** Error codes meaning "Firefox is no longer reading our stdout". */
const PIPE_GONE = new Set(['EPIPE', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END', 'ECONNRESET', 'EOF']);

export function stdoutErrorAction(err: unknown): StdoutErrorAction {
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

export function createProcessHandlers(deps: ProcessHandlerDeps): ProcessHandlers {
  const exit = deps.exit;
  return {
    uncaughtException: (err) => {
      deps.log(`FATAL uncaughtException: ${describe(err)}`);
      exit(1);
    },
    unhandledRejection: (reason) => {
      deps.log(`unhandledRejection (continuing): ${describe(reason)}`);
    },
    stdoutError: (err) => {
      if (stdoutErrorAction(err) === 'exit-clean') {
        deps.log('stdout closed by Firefox — exiting');
        exit(0);
        return;
      }
      deps.log(`stdout error: ${describe(err)}`);
      exit(1);
    },
  };
}

export function installProcessHandlers(log: (line: string) => void): void {
  const handlers = createProcessHandlers({ exit: (code) => process.exit(code), log });
  process.on('uncaughtException', handlers.uncaughtException);
  process.on('unhandledRejection', handlers.unhandledRejection);
  process.stdout.on('error', handlers.stdoutError);
  process.stderr.on('error', () => { /* see header */ });
}
