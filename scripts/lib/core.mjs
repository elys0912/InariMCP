/**
 * Pure helpers shared by scripts/install.mjs and scripts/uninstall.mjs.
 *
 * Nothing here touches the file system, the registry, the network or other
 * processes: every function takes the platform / home directory / environment
 * it works on, so the tests can check Windows, macOS and Linux results on any
 * machine. Side effects live in ./system.mjs.
 *
 * All paths the installer knows about (~/.kitsune-mcp and the Firefox Native
 * Messaging locations) are built here and nowhere else (review 4.C3).
 */

import * as crypto from 'node:crypto';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** Native Messaging host name (extension: browser.runtime.connectNative). */
export const HOST_NAME = 'kitsune_mcp';
/** Name of the MCP server in Claude Code (`claude mcp add <name>`). */
export const CLAUDE_NAME = 'kitsune-mcp';
/** `service` field of the daemon's GET /health answer. */
export const SERVICE_NAME = 'kitsune-mcp';
export const MIN_NODE_MAJOR = 18;
export const CLAUDE_SCOPES = ['user', 'local', 'project'];
export const DEFAULT_HTTP_PORT = 8765;
export const DEFAULT_HTTP_HOST = '127.0.0.1';
/** Highest TCP port number (same as MAX_PORT of @kitsune-mcp/shared). */
export const MAX_PORT = 65_535;
/** Per-user registration Firefox reads on Windows (every edition). */
export const WIN_REG_KEY = `HKCU\\Software\\Mozilla\\NativeMessagingHosts\\${HOST_NAME}`;
/** Flatpak application IDs of Firefox builds (Flathub publishes Release only). */
export const FLATPAK_FIREFOX_IDS = ['org.mozilla.firefox'];

/**
 * `table[key]`; throws for a key the table does not list, so a new value
 * cannot silently get another value's text.
 */
export function lookup(table, key, what) {
  if (!Object.hasOwn(table, key)) throw new Error(`unknown ${what}: ${String(key)}`);
  return table[key];
}

/** path.win32 or path.posix, so results do not depend on the machine running the tests. */
export function pathApi(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Everything under ~/.kitsune-mcp (the packages hard-code the same layout). */
export function dataPaths(platform, home) {
  const p = pathApi(platform);
  const dataDir = p.join(home, '.kitsune-mcp');
  const nativeHostDir = p.join(dataDir, 'native-host');
  return {
    dataDir,
    nativeHostDir,
    wrapperPath: p.join(nativeHostDir, platform === 'win32' ? 'run-host.cmd' : 'run-host.sh'),
    /** Windows only: the manifest the registry value points to. */
    winManifestPath: p.join(nativeHostDir, `${HOST_NAME}.json`),
    logsDir: p.join(dataDir, 'logs'),
    tokenPath: p.join(dataDir, 'api_token'),
  };
}

/** Build output and sources the registration points at. */
export function repoPaths(platform, repoRoot) {
  const p = pathApi(platform);
  const nativeHostPkg = p.join(repoRoot, 'packages', 'native-host');
  return {
    repoRoot,
    nativeHostPkg,
    hostEntry: p.join(nativeHostPkg, 'dist', 'index.js'),
    serverEntry: p.join(repoRoot, 'packages', 'mcp-server', 'dist', 'index.js'),
    extManifest: p.join(repoRoot, 'packages', 'extension', 'manifest.json'),
    projectMcpJson: p.join(repoRoot, '.mcp.json'),
  };
}

/**
 * Where Firefox looks for the host manifest `kitsune_mcp.json`.
 *
 * Windows: one registry value for every edition (Release, ESR, Beta,
 * Developer Edition, Nightly, MSIX); the manifest file itself lives in
 * ~/.kitsune-mcp/native-host. macOS: one directory for every edition.
 * Linux: the classic ~/.mozilla directory for every non-sandboxed edition,
 * plus directories that only some builds read (XDG, Snap, Flatpak); those
 * are returned when the build seems to be present (`exists`), or always with
 * `all` (uninstall removes whatever is there).
 *
 * @param {{platform: string, home: string, env: Record<string, string|undefined>,
 *          exists: (p: string) => boolean, all?: boolean}} o
 * @returns {{id: string, label: string, file: string, registryKey?: string, note?: string}[]}
 */
export function nmManifestTargets({ platform, home, env, exists, all = false }) {
  const p = pathApi(platform);
  const file = (dir) => p.join(dir, `${HOST_NAME}.json`);

  if (platform === 'win32') {
    return [{
      id: 'windows',
      label: 'Firefox (all editions)',
      file: dataPaths(platform, home).winManifestPath,
      registryKey: WIN_REG_KEY,
    }];
  }
  if (platform === 'darwin') {
    return [{
      id: 'macos',
      label: 'Firefox (all editions)',
      file: file(p.join(home, 'Library', 'Application Support', 'Mozilla', 'NativeMessagingHosts')),
    }];
  }

  const targets = [{
    id: 'linux',
    label: 'Firefox (package / tarball: Release, ESR, Developer Edition, Nightly)',
    file: file(p.join(home, '.mozilla', 'native-messaging-hosts')),
  }];

  const xdgConfig = env.XDG_CONFIG_HOME && p.isAbsolute(env.XDG_CONFIG_HOME)
    ? env.XDG_CONFIG_HOME
    : p.join(home, '.config');
  if (all || exists(p.join(xdgConfig, 'mozilla'))) {
    targets.push({
      id: 'linux-xdg',
      label: 'Firefox using the XDG config directory',
      file: file(p.join(xdgConfig, 'mozilla', 'native-messaging-hosts')),
      note: 'read by Firefox builds that keep their data in $XDG_CONFIG_HOME/mozilla instead of ~/.mozilla',
    });
  }

  if (all || exists(p.join(home, 'snap', 'firefox')) || exists('/snap/firefox')) {
    targets.push({
      id: 'snap',
      label: 'Snap Firefox',
      file: file(p.join(home, 'snap', 'firefox', 'common', '.mozilla', 'native-messaging-hosts')),
      note: 'Snap Firefox starts hosts through the xdg-desktop-portal WebExtensions portal, which reads ~/.mozilla/native-messaging-hosts; this copy covers builds that look inside the snap',
    });
  }

  for (const id of FLATPAK_FIREFOX_IDS) {
    const appData = p.join(home, '.var', 'app', id);
    if (
      all ||
      exists(appData) ||
      exists(p.join('/var/lib/flatpak/app', id)) ||
      exists(p.join(home, '.local', 'share', 'flatpak', 'app', id))
    ) {
      targets.push({
        id: `flatpak:${id}`,
        label: `Flatpak Firefox (${id})`,
        file: file(p.join(appData, '.mozilla', 'native-messaging-hosts')),
        note: 'the Flatpak sandbox cannot run node from the host; set widget.use-xdg-desktop-portal.native-messaging = 1 in about:config so Firefox goes through the portal (needs xdg-desktop-portal with WebExtensions support)',
      });
    }
  }
  return targets;
}

// ---------------------------------------------------------------------------
// Generated files
// ---------------------------------------------------------------------------

export function buildManifest({ wrapperPath, geckoId }) {
  return {
    name: HOST_NAME,
    description: 'KitsuneMCP Native Messaging Host',
    path: wrapperPath,
    type: 'stdio',
    allowed_extensions: [geckoId],
  };
}

export function serializeJson(value) {
  return JSON.stringify(value, null, 2) + '\n';
}

export function isAscii(text) {
  return /^[\x00-\x7f]*$/.test(text);
}

/**
 * run-host.cmd. Firefox on Windows starts only .exe / .bat / .cmd, so a
 * batch file starts node. The absolute node path is embedded because Firefox
 * may run with a PATH that has no node; if that node disappears (upgrade)
 * the node on PATH is used instead. Nothing may reach stdout: it is the
 * Native Messaging channel. goto instead of an if ( ) block because
 * "Program Files (x86)" would close the block early.
 *
 * cmd.exe decodes a batch file line by line in the console code page. For
 * paths outside ASCII the file is written as UTF-8 and switches to code
 * page 65001 before the first such line.
 */
export function buildWindowsWrapper({ nativeHostPkg, nodePath, hostEntry }) {
  const esc = (s) => s.replace(/%/g, '%%');
  const lines = ['@echo off'];
  if (!isAscii(nativeHostPkg + nodePath + hostEntry)) lines.push('chcp 65001 >nul');
  lines.push(
    'rem Generated by KitsuneMCP scripts\\install.mjs. Re-run the installer to update.',
    `cd /d "${esc(nativeHostPkg)}"`,
    `if not exist "${esc(nodePath)}" goto pathnode`,
    `"${esc(nodePath)}" "${esc(hostEntry)}" %*`,
    'exit /b %errorlevel%',
    ':pathnode',
    `node "${esc(hostEntry)}" %*`,
  );
  return lines.join('\r\n') + '\r\n';
}

/** Quote for a POSIX shell: it's → 'it'\''s' */
export function shellQuote(s) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** run-host.sh (same fallbacks as the Windows wrapper). */
export function buildPosixWrapper({ nativeHostPkg, nodePath, hostEntry }) {
  return [
    '#!/bin/sh',
    '# Generated by KitsuneMCP scripts/install.mjs. Re-run the installer to update.',
    `cd ${shellQuote(nativeHostPkg)} || exit 1`,
    `if [ -x ${shellQuote(nodePath)} ]; then exec ${shellQuote(nodePath)} ${shellQuote(hostEntry)} "$@"; fi`,
    `exec node ${shellQuote(hostEntry)} "$@"`,
    '',
  ].join('\n');
}

export function buildWrapper(platform, args) {
  return platform === 'win32' ? buildWindowsWrapper(args) : buildPosixWrapper(args);
}

// ---------------------------------------------------------------------------
// "Already registered?" — decided by comparing paths (review 4.B1)
// ---------------------------------------------------------------------------

/** Path equality: normalized, case-insensitive on Windows. */
export function samePath(a, b, platform) {
  if (typeof a !== 'string' || typeof b !== 'string' || a === '' || b === '') return false;
  const p = pathApi(platform);
  const norm = (s) => {
    const n = p.normalize(platform === 'win32' ? s.replace(/\//g, '\\') : s).replace(/[\\/]+$/, '');
    return platform === 'win32' ? n.toLowerCase() : n;
  };
  return norm(a) === norm(b);
}

/**
 * State of an existing host manifest compared with the one we would write.
 * @param {object} expected buildManifest() result
 * @param {string|null} actualText file content, null when absent
 * @returns {{state: 'absent'|'same'|'different'|'invalid', path?: string}}
 */
export function manifestState(expected, actualText, platform) {
  if (actualText === null || actualText === undefined) return { state: 'absent' };
  let actual;
  try {
    actual = JSON.parse(actualText);
  } catch {
    return { state: 'invalid' };
  }
  if (actual === null || typeof actual !== 'object') return { state: 'invalid' };
  const same =
    actual.name === expected.name &&
    actual.type === expected.type &&
    samePath(actual.path, expected.path, platform) &&
    Array.isArray(actual.allowed_extensions) &&
    actual.allowed_extensions.length === expected.allowed_extensions.length &&
    expected.allowed_extensions.every((id) => actual.allowed_extensions.includes(id));
  return { state: same ? 'same' : 'different', path: typeof actual.path === 'string' ? actual.path : undefined };
}

/** Default value of a `reg query <key> /ve` answer (localized "(Default)" label). */
export function parseRegDefaultValue(stdout) {
  for (const line of String(stdout).split(/\r?\n/)) {
    const m = /\sREG_(?:EXPAND_)?SZ(?:\s+(.*))?$/.exec(line);
    if (m) return (m[1] ?? '').trim();
  }
  return null;
}

// ---------------------------------------------------------------------------
// Claude Code registration
// ---------------------------------------------------------------------------

/** Global Claude Code config (holds user and local scoped MCP servers). */
export function claudeConfigPath(platform, home, env) {
  const p = pathApi(platform);
  return env.CLAUDE_CONFIG_DIR
    ? p.join(env.CLAUDE_CONFIG_DIR, '.claude.json')
    : p.join(home, '.claude.json');
}

/**
 * kitsune-mcp entries visible from `repoRoot` (where the installer runs
 * `claude mcp add`): user scope, local scope of repoRoot, project scope
 * (.mcp.json of repoRoot). `otherLocal` lists other directories that have a
 * local-scoped kitsune-mcp.
 */
export function findClaudeEntries({ config, projectMcp, repoRoot, platform }) {
  const found = [];
  const otherLocal = [];
  const pick = (servers) =>
    servers && typeof servers === 'object' && servers[CLAUDE_NAME] && typeof servers[CLAUDE_NAME] === 'object'
      ? servers[CLAUDE_NAME]
      : undefined;
  if (config && typeof config === 'object') {
    const user = pick(config.mcpServers);
    if (user) found.push({ scope: 'user', entry: user });
    if (config.projects && typeof config.projects === 'object') {
      for (const [dir, project] of Object.entries(config.projects)) {
        const entry = pick(project && project.mcpServers);
        if (!entry) continue;
        if (samePath(dir, repoRoot, platform)) found.push({ scope: 'local', entry });
        else otherLocal.push(dir);
      }
    }
  }
  const project = projectMcp && typeof projectMcp === 'object' ? pick(projectMcp.mcpServers) : undefined;
  if (project) found.push({ scope: 'project', entry: project });
  return { found, otherLocal };
}

/**
 * 'same': absolute node + this repository's server entry.
 * 'stale-node': this repository's server entry, but another node (e.g. a bare
 *   "node" resolved through PATH — review 4.B7).
 * 'different': anything else (another clone, another command).
 */
export function claudeEntryState(entry, { nodePath, serverEntry, platform }) {
  const args = Array.isArray(entry && entry.args) ? entry.args : [];
  const argsMatch = args.length === 1 && samePath(args[0], serverEntry, platform);
  if (!argsMatch) return 'different';
  return samePath(entry.command, nodePath, platform) ? 'same' : 'stale-node';
}

export function claudeAddArgs(scope, nodePath, serverEntry) {
  return ['mcp', 'add', '--scope', scope, CLAUDE_NAME, '--', nodePath, serverEntry];
}

export function claudeRemoveArgs(scope) {
  return ['mcp', 'remove', '--scope', scope, CLAUDE_NAME];
}

/** A command line for display (double quotes where needed). */
export function formatCommand(file, args, platform) {
  const q = (a) => {
    // No `%` here: cmd.exe expands %NAME% in a pasted line, quoted or not.
    if (a !== '' && /^[A-Za-z0-9_@+=:,./\\-]+$/.test(a)) return a;
    return platform === 'win32' ? `"${a}"` : shellQuote(a);
  };
  return [file, ...args].map(q).join(' ');
}

/**
 * How to start `file` without a shell. Batch files (.cmd / .bat: npm-installed
 * claude on Windows) need cmd.exe; Node refuses to spawn them directly.
 */
export function commandInvocation(file, args, platform, env) {
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
    const all = [file, ...args];
    if (all.some((a) => /["\r\n]/.test(a))) throw new Error(`cannot pass an argument with a quote to ${file}`);
    // cmd /c expands %NAME% even inside the double quotes.
    if (all.some((a) => a.includes('%'))) throw new Error(`cannot pass an argument with a % to ${file}`);
    const line = all.map((a) => `"${a}"`).join(' ');
    return { file: env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], verbatim: true };
  }
  return { file, args, verbatim: false };
}

// ---------------------------------------------------------------------------
// Node.js
// ---------------------------------------------------------------------------

export function nodeMajor(version) {
  const m = /^v?(\d+)\./.exec(String(version).trim());
  return m ? Number(m[1]) : NaN;
}

/**
 * Name of the version manager `nodePath` belongs to, or null. Such paths
 * change or vanish when the version is switched / removed, which breaks the
 * registration (review 4.B2 / B7).
 */
export function nodeVersionManager(nodePath) {
  const s = String(nodePath).replace(/\\/g, '/').toLowerCase();
  const rules = [
    [/\/\.nvm\//, 'nvm'],
    [/\/appdata\/roaming\/nvm\/v?\d/, 'nvm-windows'],
    [/\/\.?volta\/tools\//, 'Volta'],
    [/fnm_multishells|\/\.?fnm\/|\/fnm\/node-versions\//, 'fnm'],
    [/\/\.asdf\//, 'asdf'],
    [/\/mise\/installs\//, 'mise'],
    [/\/\.nodenv\//, 'nodenv'],
    [/\/n\/versions\//, 'n'],
    [/\/\.nodebrew\//, 'nodebrew'],
    [/\/nodist\//, 'nodist'],
    [/\/scoop\/apps\/nodejs[^/]*\/(?!current\/)[^/]+\//, 'Scoop (versioned directory)'],
    [/\/cellar\/node(@\d+)?\//, 'Homebrew (versioned Cellar directory)'],
  ];
  for (const [re, name] of rules) if (re.test(s)) return name;
  return null;
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

export function isWsl({ platform, env, procVersion }) {
  if (platform !== 'linux') return false;
  return Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP) || /microsoft/i.test(procVersion ?? '');
}

/** `host` without surrounding blanks and IPv6 brackets. */
function bareHost(host) {
  return host.trim().replace(/^\[(.*)\]$/, '$1');
}

/**
 * Same rule as isLoopbackHost of @kitsune-mcp/shared/node (127.0.0.0/8, ::1,
 * localhost, ::ffff:127.0.0.1); tests/scripts checks both agree.
 */
export function isLoopbackHost(host) {
  const h = bareHost(host).toLowerCase();
  return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h) || h === '::ffff:127.0.0.1';
}

/** Same port resolution as the daemon (FOX_HTTP_PORT, legacy CLAUDE_BROWSER_HTTP_PORT). */
export function httpEndpoint(env) {
  const raw = env.FOX_HTTP_PORT ?? env.CLAUDE_BROWSER_HTTP_PORT;
  const n = Number(raw);
  const port = raw && Number.isInteger(n) && n > 0 && n <= MAX_PORT ? n : DEFAULT_HTTP_PORT;
  const host = env.FOX_HOST ?? env.CLAUDE_BROWSER_HOST ?? DEFAULT_HTTP_HOST;
  return { host: isLoopbackHost(host) ? bareHost(host) : DEFAULT_HTTP_HOST, port };
}

/**
 * Firefox installations worth mentioning (a warning only: the registration
 * does not depend on them).
 * @param {{platform: string, home: string, env: object, exists: (p: string) => boolean,
 *          which: (name: string) => string|null}} o
 */
export function detectFirefox({ platform, home, env, exists, which }) {
  const p = pathApi(platform);
  const found = [];
  const add = (edition, where) => {
    if (!found.some((f) => samePath(f.path, where, platform))) found.push({ edition, path: where });
  };
  if (platform === 'win32') {
    const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter(Boolean);
    const dirs = [
      ['Mozilla Firefox', 'Firefox (Release / Beta / ESR)'],
      ['Firefox Developer Edition', 'Firefox Developer Edition'],
      ['Firefox Nightly', 'Firefox Nightly'],
    ];
    for (const root of roots) {
      for (const [dir, edition] of dirs) {
        const exe = p.join(root, dir, 'firefox.exe');
        if (exists(exe)) add(edition, exe);
      }
    }
    if (env.LOCALAPPDATA) {
      const alias = p.join(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'firefox.exe');
      if (exists(alias)) add('Firefox (Microsoft Store)', alias);
    }
  } else if (platform === 'darwin') {
    const apps = [
      ['Firefox.app', 'Firefox (Release / Beta / ESR)'],
      ['Firefox Developer Edition.app', 'Firefox Developer Edition'],
      ['Firefox Nightly.app', 'Firefox Nightly'],
    ];
    for (const root of ['/Applications', p.join(home, 'Applications')]) {
      for (const [app, edition] of apps) {
        const where = p.join(root, app);
        if (exists(where)) add(edition, where);
      }
    }
  } else {
    const bins = [
      ['firefox', 'Firefox'],
      ['firefox-esr', 'Firefox ESR'],
      ['firefox-developer-edition', 'Firefox Developer Edition'],
      ['firefox-devedition', 'Firefox Developer Edition'],
      ['firefox-nightly', 'Firefox Nightly'],
      ['firefox-trunk', 'Firefox Nightly (firefox-trunk)'],
    ];
    for (const [bin, edition] of bins) {
      const where = which(bin);
      if (where) add(edition, where);
    }
    if (exists('/snap/firefox')) add('Firefox (Snap)', '/snap/firefox');
    for (const id of FLATPAK_FIREFOX_IDS) {
      for (const root of ['/var/lib/flatpak/app', p.join(home, '.local', 'share', 'flatpak', 'app')]) {
        const where = p.join(root, id);
        if (exists(where)) add(`Firefox (Flatpak ${id})`, where);
      }
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------

/** `ps -A -ww -o pid= -o args=` */
export function parsePsOutput(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m) out.push({ pid: Number(m[1]), cmd: m[2] });
  }
  return out;
}

/** "<pid>\t<command line>" lines (the WMI query in system.mjs). */
export function parseTabOutput(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^(\d+)\t(.*)$/.exec(line);
    if (m) out.push({ pid: Number(m[1]), cmd: m[2] });
  }
  return out;
}

/**
 * Sort KitsuneMCP processes into this repository's Native Hosts, daemons and
 * relays; KitsuneMCP-looking processes of other checkouts go to `others` (never
 * stopped automatically).
 */
export function classifyProcesses(list, { hostEntry, serverEntry, platform, selfPid }) {
  const norm = (s) => {
    const n = String(s).replace(/\\/g, '/');
    return platform === 'win32' ? n.toLowerCase() : n;
  };
  const host = norm(hostEntry);
  const server = norm(serverEntry);
  const result = { hosts: [], daemons: [], relays: [], others: [] };
  for (const proc of list) {
    if (proc.pid === selfPid) continue;
    const cmd = norm(proc.cmd);
    if (cmd.includes(host)) result.hosts.push(proc);
    else if (cmd.includes(server)) (/\s--daemon(\s|$)/.test(cmd) ? result.daemons : result.relays).push(proc);
    else if (/native-host\/dist\/index\.js|mcp-server\/dist\/index\.js/.test(cmd)) result.others.push(proc);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Daemon authentication (same scheme as packages/*/src/auth.ts; the
// scripts cannot import TypeScript sources — tests/scripts checks the MACs match)
// ---------------------------------------------------------------------------

const AUTH_PROTOCOL = 'kitsune-hmac-v1';
export const AUTH_HEADER = {
  timestamp: 'x-kitsune-timestamp',
  nonce: 'x-kitsune-nonce',
  signature: 'x-kitsune-signature',
};

export function newNonce() {
  return crypto.randomBytes(16).toString('hex');
}

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function computeMac(token, label, ...parts) {
  return crypto.createHmac('sha256', token).update([AUTH_PROTOCOL, label, ...parts].join('\n')).digest('hex');
}

export function macMatches(provided, expected) {
  if (typeof provided !== 'string' || !/^[0-9a-f]{64}$/.test(provided)) return false;
  return crypto.timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(expected, 'hex'));
}

export function signGet(token, urlPath, now = Date.now()) {
  const nonce = newNonce();
  const timestamp = String(now);
  return {
    nonce,
    headers: {
      [AUTH_HEADER.timestamp]: timestamp,
      [AUTH_HEADER.nonce]: nonce,
      [AUTH_HEADER.signature]: computeMac(token, 'http-request', 'GET', urlPath, timestamp, nonce, sha256Hex('')),
    },
  };
}

/** Signed POST with a JSON body (same MAC as auth.ts signRequest). */
export function signPost(token, urlPath, body, now = Date.now()) {
  const nonce = newNonce();
  const timestamp = String(now);
  return {
    nonce,
    headers: {
      [AUTH_HEADER.timestamp]: timestamp,
      [AUTH_HEADER.nonce]: nonce,
      [AUTH_HEADER.signature]: computeMac(token, 'http-request', 'POST', urlPath, timestamp, nonce, sha256Hex(body)),
    },
  };
}

export function responseSignatureValid(token, nonce, status, body, signature) {
  return macMatches(signature, computeMac(token, 'http-response', nonce, String(status), sha256Hex(body)));
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

export class UsageError extends Error {}

/**
 * Minimal option parser. spec.flags: name → [key, value]; spec.values:
 * name → key (takes an argument, `--x v` or `--x=v`). Giving two flags that
 * set the same key to different values is an error.
 */
export function parseArgs(argv, spec, defaults) {
  const opts = { ...defaults };
  const setBy = {};
  const set = (key, value, name) => {
    if (key in setBy && opts[key] !== value) {
      throw new UsageError(`${setBy[key]} and ${name} cannot be used together`);
    }
    opts[key] = value;
    setBy[key] = name;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const long = /^--([a-z][a-z0-9-]*)(?:=(.*))?$/s.exec(arg);
    const short = /^-([a-z])$/.exec(arg);
    const name = long ? long[1] : short ? short[1] : null;
    const display = long ? `--${name}` : `-${name}`;
    if (name === null) throw new UsageError(`unexpected argument: ${arg}`);
    if (spec.flags[name]) {
      if (long && long[2] !== undefined) throw new UsageError(`${display} does not take a value`);
      const [key, value] = spec.flags[name];
      set(key, value, display);
    } else if (spec.values[name] && long) {
      let value = long[2];
      if (value === undefined) {
        if (i + 1 >= argv.length) throw new UsageError(`${display} needs a value`);
        value = argv[++i];
      }
      set(spec.values[name], value, display);
    } else {
      throw new UsageError(`unknown option: ${arg} (see --help)`);
    }
  }
  return opts;
}

const COMMON_FLAGS = {
  'dry-run': ['dryRun', true],
  n: ['dryRun', true],
  yes: ['yes', true],
  y: ['yes', true],
  help: ['help', true],
  h: ['help', true],
  manual: ['manual', true],
};

export function parseInstallArgs(argv) {
  const opts = parseArgs(argv, {
    flags: {
      ...COMMON_FLAGS,
      'register-claude': ['registerClaude', true],
      'no-register-claude': ['registerClaude', false],
      build: ['build', true],
      'skip-build': ['build', false],
    },
    values: { 'claude-scope': 'claudeScope', node: 'node' },
  }, {
    dryRun: false, yes: false, help: false, manual: false,
    registerClaude: false, build: false, claudeScope: 'user', node: undefined,
  });
  if (!CLAUDE_SCOPES.includes(opts.claudeScope)) {
    throw new UsageError(`--claude-scope must be one of ${CLAUDE_SCOPES.join(', ')} (got '${opts.claudeScope}')`);
  }
  if (opts.node !== undefined && opts.node === '') throw new UsageError('--node needs a path');
  return opts;
}

export function parseUninstallArgs(argv) {
  const opts = parseArgs(argv, {
    flags: {
      ...COMMON_FLAGS,
      purge: ['purge', true],
      'unregister-claude': ['claude', 'remove'],
      'keep-claude': ['claude', 'keep'],
      'no-unregister-claude': ['claude', 'keep'],
      'stop-daemon': ['stop', true],
      'no-stop': ['stop', false],
      'no-stop-daemon': ['stop', false],
    },
    values: { grace: 'grace' },
  }, {
    dryRun: false, yes: false, help: false, manual: false,
    purge: false, claude: 'ask', stop: true, grace: '5',
  });
  const grace = Number(opts.grace);
  if (!Number.isFinite(grace) || grace < 0 || grace > 60) {
    throw new UsageError(`--grace must be a number of seconds between 0 and 60 (got '${opts.grace}')`);
  }
  return { ...opts, graceMs: Math.round(grace * 1000) };
}
