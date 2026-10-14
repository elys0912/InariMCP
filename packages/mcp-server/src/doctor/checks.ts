/**
 * `inari-mcp --doctor`: the checks.
 *
 * Every check reads only. Nothing here creates ~/.inari-mcp or the API
 * token, writes a log, starts a daemon or runs `claude` (whose `mcp get`
 * would start the MCP server). The only processes started are `reg query`
 * (Windows registry) and a one-line PowerShell probe; the only requests are
 * GET /health and a signed GET /daemon/info, sent without X-Inari-Relay so
 * the doctor does not count as a Claude Code session for the idle timer.
 *
 * Each check returns OK / WARN / FAIL (SKIP when it cannot be decided, e.g.
 * no daemon to ask) with one line of detail and, unless OK, one line saying
 * what to do. Output formatting and the real dependencies are in run.ts.
 */

import * as fs from 'node:fs';
import type * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { ENV, ENV_DEFAULTS, isRecord } from '@inari-mcp/shared';

import { AUTH_HEADER, DAEMON_PROTOCOL_VERSION, MAC_LABEL, computeMac, macMatches, newNonce, signRequest, verifyResponse } from '@inari-mcp/shared/node';
import {
  apiTokenPath,
  daemonLogPath,
  dataDir as inariDataDir,
  inariHealth,
  logsDir,
  nativeHostLogPath,
  protocolText,
  type HealthVerdict,
} from '@inari-mcp/shared/node';
import { DAEMON_SETTING_KEYS, compareDaemonSettings, readApiTokenFile, resolveDaemonHost, resolveHttpPort } from '../utils/endpoint.js';
import { resolveFoxEnv } from '../utils/headless-env.js';
import { MAX_LOG_BYTES } from '../utils/log-file.js';
import { HEALTH_PROBE_TIMEOUT_MS } from '../daemon/probe.js';
import { getAuditLogPath, parseSafetyConfig } from '../safety/config.js';
import { PACKAGE_VERSION, readPackageVersion } from '../version.js';
import { errorMessage } from '../utils/errors.js';

export type Status = 'OK' | 'WARN' | 'FAIL' | 'SKIP';

export interface CheckResult {
  id: string;
  status: Status;
  detail: string;
  /** What to do (WARN / FAIL). */
  fix?: string;
}

export interface RunResult {
  status: number | null;
  stdout: string;
  error?: string;
}

export interface HttpReply {
  status: number;
  headers: http.IncomingHttpHeaders;
  raw: Buffer;
}

/** Everything the checks take from outside, replaceable in tests. */
export interface DoctorDeps {
  platform: NodeJS.Platform;
  /** process.versions.node */
  nodeVersion: string;
  cwd: string;
  /** Repository root (holds package.json and packages/). */
  repoRoot: string;
  /** Run a program (no shell). Used for `reg query` and the PowerShell probe. */
  run(cmd: string, args: string[], timeoutMs: number): RunResult;
  /** GET on the daemon's HTTP port; undefined when nothing answers. */
  get(urlPath: string, headers: Record<string, string>, timeoutMs: number): Promise<HttpReply | undefined>;
}

// ---------------------------------------------------------------------------
// Context gathered once
// ---------------------------------------------------------------------------

/** What answered GET /health (same classes as native-host server-launcher.ts). */
export type HealthKind = HealthVerdict['kind'];

export interface DaemonState {
  kind: HealthKind;
  health?: Record<string, unknown>;
  /** GET /daemon/info, only when its answer carried a valid signature. */
  info?: Record<string, unknown>;
}

export interface ClaudeEntry {
  name: string;
  scope: 'user' | 'local' | 'project';
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface DoctorContext {
  deps: DoctorDeps;
  dataDir: string;
  tokenPath: string;
  token: string | undefined;
  baseUrl: string;
  port: number;
  daemon: DaemonState;
  claude: { configPath: string; entries: ClaudeEntry[]; error?: string };
  nm: NmRegistrations;
}

/** The graceful way to stop the daemon (signed POST /daemon/shutdown through the relay CLI). */
const STOP_DAEMON = 'stop the daemon with `node packages/mcp-server/dist/index.js --stop-daemon`';
/** For daemons --stop-daemon cannot talk to (older protocol, no token, impostor). */
function stopByPid(ctx: DoctorContext): string {
  return `end the process listening on port ${ctx.port} by PID`;
}
const KIB = 1024;
const MIB = 1024 * KIB;
/** The Native Host's WebSocket reconnect backoff tops out at this. */
const RECONNECT_BACKOFF_MAX_S = ENV_DEFAULTS.BACKOFF_MAX_MS / 1000;
const REG_QUERY_TIMEOUT_MS = 5_000;
/** Starting powershell.exe can take several seconds on a cold machine. */
const POWERSHELL_PROBE_TIMEOUT_MS = 15_000;
/** How much of the end of a log the doctor reads. */
const LOG_TAIL_BYTES = 64 * KIB;
/**
 * A log is rotated once it passes MAX_LOG_BYTES; one past twice that size
 * has not been rotated (an old build, or a writer that does not rotate).
 */
const UNROTATED_LOG_BYTES = 2 * MAX_LOG_BYTES;
const NM_HOST_NAME = 'inari_mcp';
const CLAUDE_SERVER_NAME = 'inari-mcp';
/** Node.js major assumed when package.json has no readable engines.node. */
const DEFAULT_NODE_MAJOR = 20;
const DEFAULT_NODE_ENGINES = `>=${DEFAULT_NODE_MAJOR}.0.0`;
/**
 * Lines the doctor looks for in native-host.log. They mirror the Native
 * Host's own log calls (native-host/src/index.ts: "InariMCP Native Host
 * v<version> starting"; server-launcher.ts and health-monitor.ts: "max start
 * attempts ..."); a change there must be made here too.
 */
const HOST_START_MARKER = 'Native Host v';
const HOST_GAVE_UP_MARKER = 'max start attempts';

function parseJson(raw: string | Buffer): unknown {
  try {
    return JSON.parse(raw.toString());
  } catch {
    return undefined;
  }
}

function readJsonFile(file: string): { value?: unknown; error?: string } {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf-8');
  } catch (err: unknown) {
    return { error: err instanceof Error && 'code' in err && typeof err.code === 'string' ? err.code : String(err) };
  }
  try {
    return { value: JSON.parse(text.replace(/^\uFEFF/, '')) };
  } catch (err: unknown) {
    return { error: `invalid JSON (${errorMessage(err)})` };
  }
}

/** Ask the daemon, the way the Native Host judges it: strict /health, protocol, nonce proof. */
export async function probeDaemon(deps: DoctorDeps, token: string | undefined): Promise<DaemonState> {
  const nonce = newNonce();
  const reply = await deps.get('/health', { [AUTH_HEADER.nonce]: nonce }, HEALTH_PROBE_TIMEOUT_MS);
  if (reply === undefined) return { kind: 'down' };
  const health = parseJson(reply.raw);
  if (inariHealth(reply.status, health) === undefined || !isRecord(health)) return { kind: 'foreign' };
  if (health['protocol'] !== DAEMON_PROTOCOL_VERSION) return { kind: 'incompatible', health };
  if (token === undefined) return { kind: 'unverified', health };
  if (!macMatches(health['proof'], computeMac(token, MAC_LABEL.health, nonce))) return { kind: 'impostor', health };

  const signed = signRequest(token, 'GET', '/daemon/info');
  const infoReply = await deps.get('/daemon/info', signed.headers, HEALTH_PROBE_TIMEOUT_MS);
  if (
    infoReply !== undefined &&
    infoReply.status === 200 &&
    verifyResponse(token, signed.nonce, infoReply.status, infoReply.raw, infoReply.headers[AUTH_HEADER.signature])
  ) {
    const info = parseJson(infoReply.raw);
    if (isRecord(info)) return { kind: 'ok', health, info };
  }
  return { kind: 'ok', health };
}

function claudeConfigPath(): string {
  const dir = process.env['CLAUDE_CONFIG_DIR'];
  return dir ? path.join(dir, '.claude.json') : path.join(os.homedir(), '.claude.json');
}

function toEntry(name: string, scope: ClaudeEntry['scope'], raw: unknown): ClaudeEntry | undefined {
  if (!isRecord(raw)) return undefined;
  const args = Array.isArray(raw['args']) ? raw['args'].filter((a): a is string => typeof a === 'string') : [];
  const env: Record<string, string> = {};
  if (isRecord(raw['env'])) {
    for (const [k, v] of Object.entries(raw['env'])) if (typeof v === 'string') env[k] = v;
  }
  return { name, scope, command: typeof raw['command'] === 'string' ? raw['command'] : '', args, env };
}

/** An MCP server entry that is InariMCP: by name, or by running some mcp-server/dist/index.js. */
function isInariEntry(e: ClaudeEntry): boolean {
  return e.name === CLAUDE_SERVER_NAME || e.args.some((a) => /mcp-server[\\/]dist[\\/]index\.js$/i.test(a));
}

function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  const norm = (p: string): string => {
    const r = path.resolve(p);
    return platform === 'win32' ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

/**
 * InariMCP entries of Claude Code's configuration, read from the files
 * (`claude mcp get` would start the server to test the connection).
 */
export function readClaudeRegistrations(deps: DoctorDeps): DoctorContext['claude'] {
  const configPath = claudeConfigPath();
  const entries: ClaudeEntry[] = [];
  const collect = (servers: unknown, scope: ClaudeEntry['scope']): void => {
    if (!isRecord(servers)) return;
    for (const [name, raw] of Object.entries(servers)) {
      const e = toEntry(name, scope, raw);
      if (e !== undefined && isInariEntry(e)) entries.push(e);
    }
  };

  let error: string | undefined;
  if (fs.existsSync(configPath)) {
    const { value, error: err } = readJsonFile(configPath);
    if (err !== undefined) error = `${configPath}: ${err}`;
    if (isRecord(value)) {
      collect(value['mcpServers'], 'user');
      if (isRecord(value['projects'])) {
        for (const [dir, project] of Object.entries(value['projects'])) {
          if (isRecord(project) && samePath(dir, deps.cwd, deps.platform)) collect(project['mcpServers'], 'local');
        }
      }
    }
  }
  const projectFile = path.join(deps.cwd, '.mcp.json');
  if (fs.existsSync(projectFile)) {
    const { value } = readJsonFile(projectFile);
    if (isRecord(value)) collect(value['mcpServers'], 'project');
  }
  return { configPath, entries, ...(error !== undefined ? { error } : {}) };
}

/** The daemon's URL for the messages; a refused FOX_HOST (not loopback) is named with the reason instead. */
function daemonBaseUrl(port: number): string {
  try {
    return `http://${resolveDaemonHost()}:${port}`;
  } catch (err) {
    return `(no daemon address: ${err instanceof Error ? err.message : String(err)})`;
  }
}

export async function gatherContext(deps: DoctorDeps): Promise<DoctorContext> {
  const dataDir = inariDataDir();
  const tokenPath = apiTokenPath();
  const token = readApiTokenFile(tokenPath);
  const port = resolveHttpPort();
  return {
    deps,
    dataDir,
    tokenPath,
    token,
    port,
    baseUrl: daemonBaseUrl(port),
    daemon: await probeDaemon(deps, token),
    claude: readClaudeRegistrations(deps),
    nm: findNmRegistrations(deps),
  };
}

// ---------------------------------------------------------------------------
// Helpers for the checks
// ---------------------------------------------------------------------------

function pkgDir(ctx: DoctorContext, name: string): string {
  return path.join(ctx.deps.repoRoot, 'packages', name);
}

/** Where this checkout's entry points are. */
function serverEntry(ctx: DoctorContext): string {
  return path.join(pkgDir(ctx, 'mcp-server'), 'dist', 'index.js');
}

function hostEntry(ctx: DoctorContext): string {
  return path.join(pkgDir(ctx, 'native-host'), 'dist', 'index.js');
}

function formatBytes(n: number): string {
  if (n >= MIB) return `${(n / MIB).toFixed(1)} MB`;
  if (n >= KIB) return `${Math.round(n / KIB)} KB`;
  return `${n} B`;
}

function statOrUndefined(file: string): fs.Stats | undefined {
  try {
    return fs.statSync(file);
  } catch {
    return undefined;
  }
}

/** Newest mtime (ms) of files below `dir` matching `accept`, 0 when none. */
function newestMtime(dir: string, accept: (name: string) => boolean): number {
  let newest = 0;
  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name !== 'node_modules') walk(full);
      } else if (accept(e.name)) {
        const st = statOrUndefined(full);
        if (st !== undefined && st.mtimeMs > newest) newest = st.mtimeMs;
      }
    }
  };
  walk(dir);
  return newest;
}

/** The daemon's value of one of DAEMON_SETTING_KEYS ('' = unset), when /daemon/info was read. */
function daemonSetting(ctx: DoctorContext, key: string): string | undefined {
  const settings = ctx.daemon.info?.['settings'];
  if (!isRecord(settings)) return undefined;
  const v = settings[key];
  return typeof v === 'string' ? v : '';
}

/**
 * A setting as the daemon reads it (resolveFoxEnv: blank = unset), from the
 * running daemon's settings when they were read, else from the environment a
 * session would start it with.
 */
function daemonSettingValue(
  ctx: DoctorContext,
  key: string,
): { value: string | undefined; fromDaemon: boolean } {
  const settings = ctx.daemon.info?.['settings'];
  if (isRecord(settings)) {
    return { value: resolveFoxEnv({ [key]: daemonSetting(ctx, key) ?? '' }, key), fromDaemon: true };
  }
  return { value: resolveFoxEnv(sessionEnv(ctx), key), fromDaemon: false };
}

/** Environment a relay started by Claude Code would have: this shell's, plus the registration's `env`. */
function sessionEnv(ctx: DoctorContext): Record<string, string | undefined> {
  const entry = ctx.claude.entries.find((e) => e.scope === 'local') ??
    ctx.claude.entries.find((e) => e.scope === 'project') ??
    ctx.claude.entries.find((e) => e.scope === 'user');
  const out: Record<string, string | undefined> = {};
  for (const key of DAEMON_SETTING_KEYS) out[key] = entry?.env[key] ?? process.env[key];
  return out;
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

/** The first number of an engines range (`>=20` → 20), if any. */
function majorOf(range: string): number | undefined {
  const digits = /(\d+)/.exec(range)?.[1];
  return digits === undefined ? undefined : Number(digits);
}

export function checkNode(ctx: DoctorContext): CheckResult {
  const { value } = readJsonFile(path.join(ctx.deps.repoRoot, 'package.json'));
  const declared = isRecord(value) && isRecord(value['engines']) && typeof value['engines']['node'] === 'string'
    ? value['engines']['node']
    : undefined;
  const declaredMajor = declared === undefined ? undefined : majorOf(declared);
  const [engines, min] = declared !== undefined && declaredMajor !== undefined
    ? [declared, declaredMajor]
    : [DEFAULT_NODE_ENGINES, DEFAULT_NODE_MAJOR];
  const major = Number(ctx.deps.nodeVersion.split('.')[0]);
  if (major >= min) return { id: 'node', status: 'OK', detail: `v${ctx.deps.nodeVersion} (engines ${engines})` };
  return {
    id: 'node',
    status: 'FAIL',
    detail: `v${ctx.deps.nodeVersion} is older than ${engines}`,
    fix: `install Node.js ${min} or later, then re-run the installer (the Native Host wrapper pins the node path)`,
  };
}

export function checkVersions(ctx: DoctorContext): CheckResult {
  const files: Record<string, string> = {
    root: 'package.json',
    shared: 'packages/shared/package.json',
    'mcp-server': 'packages/mcp-server/package.json',
    'native-host': 'packages/native-host/package.json',
    extension: 'packages/extension/package.json',
    'manifest.json': 'packages/extension/manifest.json',
  };
  const found: Record<string, string> = {};
  for (const [label, rel] of Object.entries(files)) {
    found[label] = readPackageVersion(path.join(ctx.deps.repoRoot, rel)) ?? 'missing';
  }
  const distinct = new Set(Object.values(found));
  if (distinct.size === 1 && !distinct.has('missing')) {
    return { id: 'versions', status: 'OK', detail: `${[...distinct][0]} (${Object.keys(found).join(', ')})` };
  }
  return {
    id: 'versions',
    status: 'WARN',
    detail: Object.entries(found).map(([k, v]) => `${k} ${v}`).join(', '),
    fix: 'update the whole checkout (git pull / re-extract), npm run build, then reload the Extension',
  };
}

export function checkBuild(ctx: DoctorContext): CheckResult {
  const isSource = (n: string): boolean => /\.(ts|html|css)$/.test(n) && !n.endsWith('.d.ts');
  const isOutput = (n: string): boolean => /\.(js|html|css)$/.test(n);
  const missing: string[] = [];
  const stale: string[] = [];
  for (const name of ['shared', 'mcp-server', 'native-host', 'extension']) {
    const dir = pkgDir(ctx, name);
    const src = newestMtime(path.join(dir, 'src'), isSource);
    const dist = newestMtime(path.join(dir, 'dist'), isOutput);
    if (dist === 0) missing.push(name);
    else if (src > dist) stale.push(name);
  }
  if (missing.length > 0) {
    return { id: 'build', status: 'FAIL', detail: `dist missing: ${missing.join(', ')}`, fix: 'run npm run build' };
  }
  if (stale.length > 0) {
    return {
      id: 'build',
      status: 'WARN',
      detail: `sources newer than dist: ${stale.join(', ')}`,
      fix: `run npm run build, then ${STOP_DAEMON} and reload the Extension so the new build is used`,
    };
  }
  return { id: 'build', status: 'OK', detail: 'dist is newer than src in every package' };
}

export interface NmRegistration {
  /** Registry key or directory. */
  where: string;
  manifestPath: string;
}

export interface NmRegistrations {
  /** The manifest Firefox reads (HKCU before HKLM, user directory before system ones). */
  used?: NmRegistration;
  others: NmRegistration[];
  note?: string;
}

/** Native Messaging host manifests Firefox would find, the one it uses first. */
export function findNmRegistrations(deps: DoctorDeps): NmRegistrations {
  const { platform } = deps;
  const home = os.homedir();
  const found: NmRegistration[] = [];
  let note: string | undefined;

  if (platform === 'win32') {
    for (const hive of ['HKCU', 'HKLM']) {
      const key = `${hive}\\Software\\Mozilla\\NativeMessagingHosts\\${NM_HOST_NAME}`;
      const r = deps.run('reg', ['query', key, '/ve'], REG_QUERY_TIMEOUT_MS);
      if (r.error !== undefined && hive === 'HKCU') note = `reg query failed: ${r.error}`;
      if (r.status !== 0) continue;
      const m = /REG_(?:EXPAND_)?SZ[ \t]+(.+?)[ \t]*$/m.exec(r.stdout);
      if (m?.[1] !== undefined) {
        const value = m[1].replace(/%([^%]+)%/g, (all, name: string) => process.env[name] ?? all);
        found.push({ where: key, manifestPath: value });
      }
    }
  } else {
    const dirs = platform === 'darwin'
      ? [
          path.join(home, 'Library', 'Application Support', 'Mozilla', 'NativeMessagingHosts'),
          '/Library/Application Support/Mozilla/NativeMessagingHosts',
        ]
      : [
          path.join(home, '.mozilla', 'native-messaging-hosts'),
          '/usr/lib/mozilla/native-messaging-hosts',
          '/usr/lib64/mozilla/native-messaging-hosts',
          // Sandboxed Firefox builds read only their own directory
          path.join(home, '.var', 'app', 'org.mozilla.firefox', '.mozilla', 'native-messaging-hosts'),
          path.join(home, 'snap', 'firefox', 'common', '.mozilla', 'native-messaging-hosts'),
        ];
    for (const dir of dirs) {
      const file = path.join(dir, `${NM_HOST_NAME}.json`);
      if (fs.existsSync(file)) found.push({ where: dir, manifestPath: file });
    }
  }
  const [used, ...others] = found;
  return { ...(used !== undefined ? { used } : {}), others, ...(note !== undefined ? { note } : {}) };
}

function geckoId(ctx: DoctorContext): string | undefined {
  const { value } = readJsonFile(path.join(pkgDir(ctx, 'extension'), 'manifest.json'));
  if (!isRecord(value)) return undefined;
  const bss = value['browser_specific_settings'];
  const gecko = isRecord(bss) ? bss['gecko'] : undefined;
  return isRecord(gecko) && typeof gecko['id'] === 'string' ? gecko['id'] : undefined;
}

/** `path` of the host manifest Firefox uses, when it is an existing absolute file. */
function registeredWrapper(ctx: DoctorContext): string | undefined {
  if (ctx.nm.used === undefined) return undefined;
  const { value } = readJsonFile(ctx.nm.used.manifestPath);
  const p = isRecord(value) && typeof value['path'] === 'string' ? value['path'] : '';
  return p !== '' && path.isAbsolute(p) && fs.existsSync(p) ? p : undefined;
}

export function checkNativeMessaging(ctx: DoctorContext): CheckResult {
  const id = 'native-messaging';
  const { used, others, note } = ctx.nm;
  const fixInstall = 'run the installer: npm run setup (Windows / Unix; options: node scripts/install.mjs --help)';
  if (used === undefined) {
    // Only the extension route (Firefox) needs the registration: a WARN, so
    // a headless-only setup does not fail. A broken registration still FAILs.
    return {
      id,
      status: 'WARN',
      detail: `${NM_HOST_NAME} is not registered${note !== undefined ? ` (${note})` : ''}`,
      fix: `needed for the extension route (Firefox), not for headless only: ${fixInstall}`,
    };
  }
  const { value, error } = readJsonFile(used.manifestPath);
  if (error !== undefined || !isRecord(value)) {
    return { id, status: 'FAIL', detail: `${used.manifestPath}: ${error ?? 'not a JSON object'} (registered in ${used.where})`, fix: fixInstall };
  }
  const problems: string[] = [];
  if (value['name'] !== NM_HOST_NAME) problems.push(`name is '${String(value['name'])}'`);
  if (value['type'] !== 'stdio') problems.push(`type is '${String(value['type'])}'`);
  const expectedId = geckoId(ctx);
  const allowed = Array.isArray(value['allowed_extensions']) ? value['allowed_extensions'] : [];
  if (expectedId !== undefined && !allowed.includes(expectedId)) problems.push(`allowed_extensions lacks ${expectedId}`);
  const wrapper = typeof value['path'] === 'string' ? value['path'] : '';
  if (wrapper === '' || !path.isAbsolute(wrapper)) problems.push(`path '${wrapper}' is not absolute`);
  else if (!fs.existsSync(wrapper)) problems.push(`wrapper ${wrapper} does not exist`);

  const alsoFound = others.length > 0 ? `; also registered: ${others.map((o) => o.manifestPath).join(', ')}` : '';
  if (problems.length > 0) {
    return { id, status: 'FAIL', detail: `${used.manifestPath}: ${problems.join('; ')}`, fix: fixInstall };
  }
  return { id, status: 'OK', detail: `${used.manifestPath} (${used.where})${alsoFound}` };
}

/**
 * The wrapper the manifest points to starts this checkout's Native Host with
 * a node that still exists. Several checkouts (or a WSL and a Windows one)
 * each register the same host name; the last installer run wins without any
 * message, so a different checkout here is reported.
 */
export function checkNmWrapper(ctx: DoctorContext): CheckResult {
  const id = 'nm-wrapper';
  const wrapper = registeredWrapper(ctx);
  if (wrapper === undefined) return { id, status: 'SKIP', detail: 'no usable host manifest (see native-messaging)' };
  let content: string;
  try {
    content = fs.readFileSync(wrapper, 'utf-8');
  } catch (err: unknown) {
    return { id, status: 'FAIL', detail: `cannot read ${wrapper}: ${String(err)}`, fix: 're-run the installer' };
  }
  const win = ctx.deps.platform === 'win32';
  const norm = (s: string): string => (win ? s.replace(/%%/g, '%').replace(/\//g, '\\').toLowerCase() : s.replace(/'\\''/g, "'"));
  const expected = hostEntry(ctx);
  if (!norm(content).includes(norm(expected))) {
    const other = /["']([^"'\r\n]*native-host[\\/]dist[\\/]index\.js)["']/i.exec(content)?.[1];
    return {
      id,
      status: 'WARN',
      detail: `${wrapper} starts ${other ?? 'another Native Host'}, not ${expected}`,
      fix: 'Firefox uses the checkout registered last: re-run the installer from the checkout you want to use',
    };
  }
  const pinned = (win ? /if not exist "([^"]+)" goto pathnode/i : /if \[ -x '((?:[^']|'\\'')+)' \]/).exec(content)?.[1];
  if (pinned !== undefined) {
    const nodePath = win ? pinned.replace(/%%/g, '%') : pinned.replace(/'\\''/g, "'");
    if (!fs.existsSync(nodePath)) {
      return {
        id,
        status: 'WARN',
        detail: `node pinned in the wrapper is gone (${nodePath}); it falls back to node on Firefox's PATH`,
        fix: 're-run the installer to pin the current node',
      };
    }
  }
  return { id, status: 'OK', detail: `${wrapper} starts this checkout${pinned !== undefined ? ` with ${pinned}` : ''}` };
}

function findOnPath(name: string, platform: NodeJS.Platform): string | undefined {
  const dirs = (process.env['PATH'] ?? '').split(path.delimiter).filter((d) => d !== '');
  dirs.push(path.join(os.homedir(), '.local', 'bin'));
  const exts = platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const file = path.join(dir, name + ext);
      const st = statOrUndefined(file);
      if (st?.isFile()) return file;
    }
  }
  return undefined;
}

export function checkClaude(ctx: DoctorContext): CheckResult {
  const id = 'claude';
  const entry = serverEntry(ctx);
  const register = `claude mcp add --scope user ${CLAUDE_SERVER_NAME} -- node "${entry}"`;
  const cli = findOnPath('claude', ctx.deps.platform);
  const cliNote = cli === undefined ? '; claude CLI not found in PATH' : '';
  const { entries, error, configPath } = ctx.claude;
  if (entries.length === 0) {
    return {
      id,
      status: 'WARN',
      detail: `no ${CLAUDE_SERVER_NAME} entry in ${configPath} or ./.mcp.json${error !== undefined ? ` (${error})` : ''}${cliNote}`,
      fix: `register it: ${register}`,
    };
  }
  const wrong = entries.filter((e) => {
    const script = e.args.find((a) => /index\.js$/i.test(a));
    return script === undefined || !samePath(path.resolve(ctx.deps.cwd, script), entry, ctx.deps.platform);
  });
  const list = entries.map((e) => `${e.name} (${e.scope}): ${[e.command, ...e.args].join(' ')}`).join('; ');
  const [firstWrong] = wrong;
  if (firstWrong !== undefined) {
    return {
      id,
      status: 'WARN',
      detail: `${list} — not this checkout's ${entry}${cliNote}`,
      fix: `re-register: claude mcp remove ${firstWrong.name} -s ${firstWrong.scope}, then ${register}`,
    };
  }
  return { id, status: 'OK', detail: `${list}${cliNote} (read from the config; claude mcp get is not run: it starts the server)` };
}

export function checkPowerShell(ctx: DoctorContext): CheckResult {
  const id = 'powershell';
  if (ctx.deps.platform !== 'win32') return { id, status: 'SKIP', detail: 'only used on Windows' };
  const r = ctx.deps.run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '[Console]::Out.Write($ExecutionContext.SessionState.LanguageMode)'],
    POWERSHELL_PROBE_TIMEOUT_MS,
  );
  const mode = r.stdout.trim();
  if (r.status === 0 && mode === 'FullLanguage') {
    return { id, status: 'OK', detail: 'available (FullLanguage): the daemon is started outside Firefox\'s job' };
  }
  const why = r.status === 0 ? `runs in ${mode || 'an unknown language mode'} (Add-Type blocked)` : `not usable (${r.error ?? `exit code ${String(r.status)}`})`;
  return {
    id,
    status: 'WARN',
    detail: `PowerShell ${why}: the Native Host falls back to WMI / Task Scheduler to start the daemon (the installer does not need PowerShell)`,
    fix: 'if closing Firefox stops the daemon, check native-host.log for the breakaway route',
  };
}

export function checkDaemon(ctx: DoctorContext): CheckResult {
  const id = 'daemon';
  const { kind, health } = ctx.daemon;
  const version = typeof health?.['version'] === 'string' ? health['version'] : 'unknown';
  const stop = `${STOP_DAEMON} (and restart Firefox); the next tool call starts the installed daemon`;
  switch (kind) {
    case 'down':
      return {
        id,
        status: 'WARN',
        detail: `nothing answers on ${ctx.baseUrl}`,
        fix: 'normal when unused: a Claude Code tool call or Firefox starts it; if it does not come up, read daemon.log',
      };
    case 'foreign':
      return {
        id,
        status: 'FAIL',
        detail: `${ctx.baseUrl}/health does not answer as Inari MCP (another program holds the port)`,
        fix: `stop that program, or set ${ENV.FOX_HTTP_PORT} / ${ENV.FOX_WS_PORT} to free ports for both Claude Code and Firefox`,
      };
    case 'incompatible':
      return {
        id,
        status: 'FAIL',
        detail: `daemon of another protocol (protocol ${protocolText(health?.['protocol'])}, version ${version}; this build needs ${DAEMON_PROTOCOL_VERSION})`,
        fix: `${stopByPid(ctx)} (an older daemon has no --stop-daemon); then restart Firefox; the next tool call starts the installed daemon`,
      };
    case 'impostor':
      return {
        id,
        status: 'FAIL',
        detail: `the daemon on ${ctx.baseUrl} cannot prove it holds ${ctx.tokenPath}`,
        fix: `api_token was replaced after it started, or another program impersonates it: ${stopByPid(ctx)} (--stop-daemon cannot sign for it), then restart Firefox`,
      };
    case 'unverified':
      return { id, status: 'WARN', detail: `v${version} answers, proof not checked (no api_token)`, fix: 'see the token item' };
    case 'ok': {
      const uptime = typeof health?.['uptime'] === 'number' ? `, up ${health['uptime']}s` : '';
      if (version !== PACKAGE_VERSION) {
        return {
          id,
          status: 'WARN',
          detail: `daemon v${version} is running, this checkout is v${PACKAGE_VERSION}${uptime}`,
          fix: stop,
        };
      }
      if (health?.['ready'] === false) {
        return { id, status: 'WARN', detail: `v${version} still starting (headless backend?)${uptime}`, fix: 'wait and run the doctor again' };
      }
      return { id, status: 'OK', detail: `v${version}, protocol ${DAEMON_PROTOCOL_VERSION}, proof verified${uptime}` };
    }
    default: {
      const unhandled: never = kind;
      throw new Error(`unhandled daemon state ${String(unhandled)}`);
    }
  }
}

export function checkToken(ctx: DoctorContext): CheckResult {
  const id = 'token';
  const st = statOrUndefined(ctx.tokenPath);
  const alive = ctx.daemon.kind !== 'down' && ctx.daemon.kind !== 'foreign';
  if (st === undefined) {
    if (alive) {
      return {
        id,
        status: 'FAIL',
        detail: `the daemon is running but ${ctx.tokenPath} is missing: relays and the Native Host report it as unavailable`,
        fix: `${stopByPid(ctx)} (--stop-daemon needs the token; a new daemon writes a new one), then restart Firefox`,
      };
    }
    return { id, status: 'OK', detail: `${ctx.tokenPath} not created yet (the daemon creates it on start)` };
  }
  if (ctx.token === undefined) {
    return { id, status: 'FAIL', detail: `${ctx.tokenPath} is empty`, fix: `delete it and ${stopByPid(ctx)}` };
  }
  if (ctx.deps.platform === 'win32') {
    return { id, status: 'OK', detail: `${ctx.tokenPath} present (file modes do not apply on Windows; the profile ACL protects it)` };
  }
  const loose = [
    (st.mode & 0o077) !== 0 ? `chmod 600 ${ctx.tokenPath}` : undefined,
    ((statOrUndefined(ctx.dataDir)?.mode ?? 0) & 0o077) !== 0 ? `chmod 700 ${ctx.dataDir}` : undefined,
  ].filter((s): s is string => s !== undefined);
  if (loose.length > 0) {
    return { id, status: 'WARN', detail: `${ctx.tokenPath} is readable by other users`, fix: loose.join('; ') };
  }
  return { id, status: 'OK', detail: `${ctx.tokenPath} present, mode ${(st.mode & 0o777).toString(8)}` };
}

/**
 * Same rule as the relay (compareDaemonSettings): effective values, so
 * `true` / `1` and old / new variable names are not reported as different.
 */
export function checkSettings(ctx: DoctorContext): CheckResult {
  const id = 'settings';
  const { info } = ctx.daemon;
  const diffs = info === undefined ? null : compareDaemonSettings(sessionEnv(ctx), info);
  if (diffs === null) {
    return { id, status: 'SKIP', detail: 'daemon settings not readable (daemon down or not verified)' };
  }
  const source = ctx.claude.entries.length > 0 ? 'this shell + the Claude Code registration env' : 'this shell';
  if (diffs.length > 0) {
    return {
      id,
      status: 'WARN',
      detail: `${diffs.join('; ')} (session = ${source})`,
      fix: `the running daemon's settings apply to every session: ${STOP_DAEMON} and start a session with the wanted settings (a daemon started by Firefox has Firefox's environment)`,
    };
  }
  return { id, status: 'OK', detail: `daemon settings match ${source}` };
}

export function checkBrowsers(ctx: DoctorContext): CheckResult {
  const id = 'browsers';
  const { health, info } = ctx.daemon;
  if (ctx.daemon.kind !== 'ok' && ctx.daemon.kind !== 'unverified') {
    return { id, status: 'SKIP', detail: 'no compatible daemon to ask' };
  }
  const count = typeof health?.['browsers_connected'] === 'number' ? health['browsers_connected'] : 0;
  const uptime = typeof health?.['uptime'] === 'number' ? health['uptime'] : Infinity;
  const nativeHosts = typeof info?.['nativeHosts'] === 'number' ? info['nativeHosts'] : undefined;
  const headless = info?.['headless'] === true;
  if (count === 0) {
    if (uptime < RECONNECT_BACKOFF_MAX_S) {
      return {
        id,
        status: 'WARN',
        detail: `no browser yet; the daemon is up only ${uptime}s and the Native Host reconnects with a backoff of up to ${RECONNECT_BACKOFF_MAX_S}s`,
        fix: 'wait a minute and run the doctor again',
      };
    }
    return {
      id,
      status: 'WARN',
      detail: 'no browser connected',
      fix: 'start Firefox with the Inari MCP extension (a temporary add-on must be loaded again in about:debugging after each restart); see native-host.log',
    };
  }
  if (nativeHosts !== undefined && nativeHosts > 1) {
    return {
      id,
      status: 'WARN',
      detail: `${nativeHosts} Native Hosts connected (several Firefox profiles or instances): commands go to the one connected first`,
      fix: 'close the other Firefox profile or disable the extension there',
    };
  }
  return {
    id,
    status: 'OK',
    detail: `${count} connected${nativeHosts !== undefined ? ` (Native Hosts: ${nativeHosts}${headless ? ', headless' : ''})` : ''}`,
  };
}

export function checkSafetyConfig(ctx: DoctorContext): CheckResult {
  const id = 'safety-config';
  const { value: configured, fromDaemon } = daemonSettingValue(ctx, ENV.FOX_SAFETY_CONFIG);
  const file = configured !== undefined ? path.resolve(ctx.deps.cwd, configured) : path.join(ctx.dataDir, 'safety.json');
  const relative = configured !== undefined && !path.isAbsolute(configured)
    ? ` (relative ${ENV.FOX_SAFETY_CONFIG} depends on the daemon's working directory)`
    : '';
  if (!fs.existsSync(file)) {
    return { id, status: relative ? 'WARN' : 'OK', detail: `${file} not present (the daemon writes the defaults on first start)${relative}`, ...(relative ? { fix: 'use an absolute path' } : {}) };
  }
  const broken = 'fix or delete the file: while it does not load, the daemon refuses every tool (config_error)';
  const { value, error } = readJsonFile(file);
  if (error !== undefined) return { id, status: 'FAIL', detail: `${file}: ${error}`, fix: broken };
  // The daemon's own validator (safety/config.ts): unknown keys are errors there too.
  const parsed = parseSafetyConfig(value);
  if (!parsed.ok) return { id, status: 'FAIL', detail: `${file}: ${parsed.error}`, fix: broken };
  if (relative) return { id, status: 'WARN', detail: `${file}: valid${relative}`, fix: 'use an absolute path' };
  return { id, status: 'OK', detail: `${file} valid${fromDaemon ? ' (path used by the running daemon)' : ''}` };
}

/**
 * The daemon lists screenshots in its FOX_SCREENSHOTS_DIR, the Native Host
 * saves them in its own, taken from Firefox's environment. The doctor cannot
 * see Firefox's environment, so a non-default value is reported as a risk.
 */
export function checkScreenshots(ctx: DoctorContext): CheckResult {
  const id = 'screenshots';
  const { value: configured, fromDaemon } = daemonSettingValue(ctx, ENV.FOX_SCREENSHOTS_DIR);
  const defaultDir = path.join(ctx.dataDir, 'screenshots');
  const whose = fromDaemon ? 'the running daemon' : 'this session';
  if (configured === undefined) {
    const exists = fs.existsSync(defaultDir) ? 'exists' : 'not created yet';
    return { id, status: 'OK', detail: `default ${defaultDir} (${exists}) for both the daemon and the Native Host` };
  }
  if (!path.isAbsolute(configured)) {
    return {
      id,
      status: 'WARN',
      detail: `${whose} uses the relative ${ENV.FOX_SCREENSHOTS_DIR}='${configured}': the daemon and the Native Host resolve it from different working directories`,
      fix: 'use an absolute path',
    };
  }
  return {
    id,
    status: 'WARN',
    detail: `${whose} uses ${configured}; the Native Host saves into its own ${ENV.FOX_SCREENSHOTS_DIR} from Firefox's environment (default ${defaultDir}), which the doctor cannot see`,
    fix: `set the same ${ENV.FOX_SCREENSHOTS_DIR} for Firefox, or unset it everywhere`,
  };
}

/** Last lines of a file (at most `bytes`), '' when unreadable. */
function tail(file: string, bytes = LOG_TAIL_BYTES): string {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf-8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function checkLogs(): CheckResult {
  const id = 'logs';
  const logs = logsDir();
  const rawHostLog = process.env[ENV.FOX_NATIVE_HOST_LOG]?.trim();
  const hostLog = rawHostLog ? path.resolve(rawHostLog) : nativeHostLogPath();
  const files = [daemonLogPath(), hostLog, getAuditLogPath()];
  const sizes: string[] = [];
  const oversized: string[] = [];
  for (const file of files) {
    const st = statOrUndefined(file);
    if (st === undefined) continue;
    sizes.push(`${path.basename(file)} ${formatBytes(st.size)}`);
    if (!file.endsWith('.jsonl') && st.size > UNROTATED_LOG_BYTES) oversized.push(path.basename(file));
  }
  const detail = `${logs}: ${sizes.length > 0 ? sizes.join(', ') : 'no log files yet'}`;

  // The Native Host stops trying after ENV_DEFAULTS.MAX_RESTART_ATTEMPTS and
  // says so only in its log (scenario table: no notice).
  const hostTail = tail(hostLog);
  const gaveUp = hostTail.lastIndexOf(HOST_GAVE_UP_MARKER);
  const restarted = hostTail.lastIndexOf(HOST_START_MARKER);
  if (gaveUp > restarted) {
    const line = hostTail.slice(hostTail.lastIndexOf('\n', gaveUp) + 1, gaveUp);
    return {
      id,
      status: 'WARN',
      detail: `the Native Host gave up starting the daemon (${line.split(' ')[0] || 'see native-host.log'}); ${detail}`,
      fix: 'read daemon.log for why the daemon did not start, fix it, then restart Firefox',
    };
  }
  if (oversized.length > 0) {
    return { id, status: 'WARN', detail: `${oversized.join(', ')} not rotated; ${detail}`, fix: `${STOP_DAEMON} and quit Firefox, then delete or move the large file` };
  }
  return { id, status: 'OK', detail };
}

/** In output order. */
export const CHECKS: ReadonlyArray<(ctx: DoctorContext) => CheckResult> = [
  checkNode,
  checkVersions,
  checkBuild,
  checkNativeMessaging,
  checkNmWrapper,
  checkClaude,
  checkPowerShell,
  checkDaemon,
  checkToken,
  checkSettings,
  checkBrowsers,
  checkSafetyConfig,
  checkScreenshots,
  checkLogs,
];

export async function runChecks(deps: DoctorDeps): Promise<CheckResult[]> {
  const ctx = await gatherContext(deps);
  return CHECKS.map((check) => {
    try {
      return check(ctx);
    } catch (err: unknown) {
      return { id: check.name, status: 'FAIL' as const, detail: `check crashed: ${errorMessage(err)}` };
    }
  });
}
