/**
 * Command line of dist/index.js. Parsed before anything else runs, so
 * `--help`, `--version` and a mistyped argument never start a relay (which
 * would spawn the daemon, create ~/.kitsune-mcp/api_token and write logs).
 */

import { PACKAGE_VERSION } from './version.js';

export type CliCommand =
  | { kind: 'relay' }
  | { kind: 'daemon' }
  | { kind: 'doctor' }
  | { kind: 'stop-daemon'; force: boolean }
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'error'; message: string };

/** Arguments selecting what the process runs; at most one may be given. */
const MODES: Record<string, 'daemon' | 'doctor' | 'stop-daemon'> = {
  '--daemon': 'daemon',
  '--doctor': 'doctor',
  doctor: 'doctor',
  '--stop-daemon': 'stop-daemon',
};

const HELP_FLAGS = new Set(['-h', '--help']);
const VERSION_FLAGS = new Set(['-v', '--version']);
/** Only with --stop-daemon: do not wait for running tool calls. */
const FORCE_FLAG = '--force';

/**
 * Decide what to run from `process.argv.slice(2)`.
 * Unknown arguments are an error (checked first, so `--daemn --help` does
 * not silently print the help); then --help, then --version, then the mode.
 */
export function parseArgs(argv: readonly string[]): CliCommand {
  const unknown = argv.filter(
    (a) => !Object.hasOwn(MODES, a) && !HELP_FLAGS.has(a) && !VERSION_FLAGS.has(a) && a !== FORCE_FLAG,
  );
  if (unknown.length > 0) {
    return { kind: 'error', message: `unknown argument${unknown.length > 1 ? 's' : ''}: ${unknown.join(' ')}` };
  }
  if (argv.some((a) => HELP_FLAGS.has(a))) return { kind: 'help' };
  if (argv.some((a) => VERSION_FLAGS.has(a))) return { kind: 'version' };

  const modes = new Set(argv.filter((a) => Object.hasOwn(MODES, a)).map((a) => MODES[a]));
  if (modes.size > 1) return { kind: 'error', message: `these options cannot be combined: ${argv.join(' ')}` };
  const [mode] = [...modes];
  const force = argv.includes(FORCE_FLAG);
  if (force && mode !== 'stop-daemon') return { kind: 'error', message: `${FORCE_FLAG} is only valid with --stop-daemon` };
  if (mode === 'stop-daemon') return { kind: 'stop-daemon', force };
  return mode === undefined ? { kind: 'relay' } : { kind: mode };
}

export function helpText(): string {
  return `KitsuneMCP v${PACKAGE_VERSION} — MCP server for Firefox browser automation

Usage: node packages/mcp-server/dist/index.js [option]

  (no option)    stdio MCP relay. This is what Claude Code starts
                 (claude mcp add kitsune-mcp -- node <path>/dist/index.js).
                 Starts the shared daemon when none is running.
  --daemon       shared daemon (HTTP/WebSocket ports). Normally started
                 automatically by a relay or by the Native Host.
  --doctor       check the installation and the running daemon; prints
                 OK / WARN / FAIL / SKIP per item with a fix. Read-only:
                 creates no token, starts no daemon. Exit code 1 when an
                 item FAILs. ("doctor" works too: kitsune-mcp doctor)
  --stop-daemon  stop the running daemon gracefully (signed POST
                 /daemon/shutdown: running tool calls may finish, up to
                 10 s; headless Firefox is closed). Every Claude Code
                 session loses the browser tools until the next call
                 starts a daemon again. Exit code 1 when it did not stop.
                 With --force, running calls are cancelled at once.
  -h, --help     show this help
  -v, --version  print the version

Files: ~/.kitsune-mcp/ (api_token, safety.json, logs/, screenshots/)
Settings: FOX_* environment variables (see README).
`;
}
