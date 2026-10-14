import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runChecks, type CheckResult, type DoctorDeps, type HttpReply, type RunResult } from '../src/doctor/checks.js';
import { formatResults, runDoctor } from '../src/doctor/run.js';
import { AUTH_HEADER, DAEMON_PROTOCOL_VERSION, MAC_LABEL, computeMac, responseMac } from '@inari-mcp/shared/node';
import { PACKAGE_VERSION } from '../src/version.js';

const TOKEN = 'a'.repeat(64);
const repoRoot = path.resolve(__dirname, '..', '..', '..');

/** This checkout's entry points, the way the checks compute them. */
const serverEntry = path.join(repoRoot, 'packages', 'mcp-server', 'dist', 'index.js');
const hostEntry = path.join(repoRoot, 'packages', 'native-host', 'dist', 'index.js');

/** The extension id the host manifest must allow (read like geckoId() does). */
const geckoId = (JSON.parse(fs.readFileSync(path.join(repoRoot, 'packages', 'extension', 'manifest.json'), 'utf-8')) as {
  browser_specific_settings: { gecko: { id: string } };
}).browser_specific_settings.gecko.id;

const NM_HOST_NAME = 'inari_mcp';
const posix = process.platform !== 'win32';

// Keep the doctor away from the real ~/.inari-mcp and ~/.claude.json.
let home: string;
let cwd: string;
const savedEnv = { ...process.env };
/** Temporary directories created by single tests; removed at the end. */
const temps: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

/** Remove the environment the doctor reads, so each test starts from nothing. */
function clearDoctorEnv(): void {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('FOX_') || k.startsWith('CLAUDE_BROWSER_') || k === 'CLAUDE_CONFIG_DIR') delete process.env[k];
  }
}

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'inari-doctor-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'inari-doctor-cwd-'));
  process.env['HOME'] = home;
  process.env['USERPROFILE'] = home;
  clearDoctorEnv();
});
afterAll(() => {
  process.env = savedEnv;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  fs.rmSync(path.join(home, '.inari-mcp'), { recursive: true, force: true });
  fs.rmSync(path.join(home, '.claude.json'), { force: true });
  fs.rmSync(path.join(home, '.mozilla'), { recursive: true, force: true });
  fs.rmSync(path.join(cwd, '.mcp.json'), { force: true });
  clearDoctorEnv();
});

interface FakeDaemon {
  /** Token the fake daemon holds (proves /health, signs /daemon/info). */
  token: string;
  health?: Record<string, unknown>;
  info?: Record<string, unknown>;
}

function deps(daemon: FakeDaemon | undefined, extra: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    platform: process.platform,
    nodeVersion: process.versions.node,
    cwd,
    repoRoot,
    run: () => ({ status: 1, stdout: '', error: 'not run in tests' }),
    get: async (urlPath, headers): Promise<HttpReply | undefined> => {
      if (daemon === undefined) return undefined;
      const nonce = headers[AUTH_HEADER.nonce]!;
      if (urlPath === '/health') {
        const body = {
          status: 'ok',
          service: 'inari-mcp',
          version: PACKAGE_VERSION,
          protocol: DAEMON_PROTOCOL_VERSION,
          ready: true,
          browsers_connected: 1,
          uptime: 600,
          proof: computeMac(daemon.token, MAC_LABEL.health, nonce),
          ...daemon.health,
        };
        return { status: 200, headers: {}, raw: Buffer.from(JSON.stringify(body)) };
      }
      const raw = Buffer.from(JSON.stringify({ settings: {}, nativeHosts: 1, ...daemon.info }));
      return { status: 200, headers: { [AUTH_HEADER.signature]: responseMac(daemon.token, nonce, 200, raw) }, raw };
    },
    ...extra,
  };
}

function byId(results: CheckResult[], id: string): CheckResult {
  const r = results.find((x) => x.id === id);
  if (r === undefined) throw new Error(`no result ${id}`);
  return r;
}

function writeToken(token: string): void {
  fs.mkdirSync(path.join(home, '.inari-mcp'), { recursive: true });
  fs.writeFileSync(path.join(home, '.inari-mcp', 'api_token'), token, { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Fakes for the Windows-only paths: reg.exe and the PowerShell probe are never
// started, and no registry key is read or written.
// ---------------------------------------------------------------------------

interface RegOptions {
  /** Name of the default value as reg.exe prints it (cp932 output is already decoded). */
  valueName?: string;
  /** REG_EXPAND_SZ instead of REG_SZ. */
  expand?: boolean;
  /** spawn error reported for the hives without a value. */
  error?: string;
  /** PowerShell's answer for checkPowerShell. */
  powershell?: RunResult;
}

/** A `run` that answers `reg query` from a table of hives, and PowerShell. */
function fakeRun(hives: Partial<Record<'HKCU' | 'HKLM', string>>, opts: RegOptions = {}): DoctorDeps['run'] {
  return (cmd, args): RunResult => {
    if (cmd === 'powershell.exe') return opts.powershell ?? { status: 1, stdout: '', error: 'no powershell in tests' };
    if (cmd !== 'reg' || args[0] !== 'query') throw new Error(`unexpected command ${cmd}`);
    const key = args[1] ?? '';
    const hive = key.startsWith('HKCU') ? 'HKCU' : 'HKLM';
    const value = hives[hive];
    if (value === undefined) return { status: 1, stdout: '', ...(opts.error !== undefined ? { error: opts.error } : {}) };
    const type = opts.expand === true ? 'REG_EXPAND_SZ' : 'REG_SZ';
    // reg.exe prints CRLF and indents the value line.
    return { status: 0, stdout: `\r\n${key}\r\n    ${opts.valueName ?? '(Default)'}    ${type}    ${value}\r\n\r\n` };
  };
}

interface ManifestOptions {
  manifest?: Record<string, unknown>;
  /** Do not create the file the manifest's `path` points at. */
  noWrapper?: boolean;
  /** Content of the wrapper (default: one that starts this checkout). */
  wrapper?: string;
  wrapperName?: string;
}

/** A host manifest (and its wrapper) in a fresh directory. */
function writeNmManifest(opts: ManifestOptions = {}): { dir: string; manifestPath: string; wrapperPath: string } {
  const dir = tempDir('inari-doctor-nm-');
  const wrapperPath = path.join(dir, opts.wrapperName ?? 'inari_mcp.bat');
  if (opts.noWrapper !== true) fs.writeFileSync(wrapperPath, opts.wrapper ?? `node "${hostEntry}" %*\r\n`);
  const manifestPath = path.join(dir, `${NM_HOST_NAME}.json`);
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({
      name: NM_HOST_NAME,
      description: 'InariMCP Native Host',
      path: wrapperPath,
      type: 'stdio',
      allowed_extensions: [geckoId],
      ...opts.manifest,
    }),
  );
  return { dir, manifestPath, wrapperPath };
}

/** Deps of a Windows machine whose HKCU registration points at `manifestPath`. */
function winDeps(manifestPath: string, daemon?: FakeDaemon, opts: RegOptions = {}): DoctorDeps {
  return deps(daemon, { platform: 'win32', run: fakeRun({ HKCU: manifestPath }, opts) });
}

/** A host manifest where Firefox looks on Linux ($HOME/.mozilla), for the POSIX wrapper. */
function writeLinuxNmManifest(opts: ManifestOptions = {}): { manifestPath: string; wrapperPath: string } {
  const dir = path.join(home, '.mozilla', 'native-messaging-hosts');
  fs.mkdirSync(dir, { recursive: true });
  const wrapperDir = tempDir('inari-doctor-wrap-');
  const wrapperPath = path.join(wrapperDir, opts.wrapperName ?? 'inari_mcp.sh');
  if (opts.noWrapper !== true) fs.writeFileSync(wrapperPath, opts.wrapper ?? `exec node '${hostEntry}' "$@"\n`);
  const manifestPath = path.join(dir, `${NM_HOST_NAME}.json`);
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({ name: NM_HOST_NAME, path: wrapperPath, type: 'stdio', allowed_extensions: [geckoId], ...opts.manifest }),
  );
  return { manifestPath, wrapperPath };
}

function writeClaudeConfig(value: unknown, dir = home): string {
  const file = path.join(dir, '.claude.json');
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

/** A repository with the four packages, each with a src/ and (optionally) a dist/. */
function fakeRepo(opts: { dist?: 'fresh' | 'stale' | 'missing' } = {}): string {
  const root = tempDir('inari-doctor-repo-');
  const now = Date.now();
  for (const name of ['shared', 'mcp-server', 'native-host', 'extension']) {
    const pkg = path.join(root, 'packages', name);
    fs.mkdirSync(path.join(pkg, 'src'), { recursive: true });
    const src = path.join(pkg, 'src', 'index.ts');
    fs.writeFileSync(src, '');
    fs.utimesSync(src, now / 1000, now / 1000);
    if (opts.dist === 'missing') continue;
    fs.mkdirSync(path.join(pkg, 'dist'), { recursive: true });
    const dist = path.join(pkg, 'dist', 'index.js');
    fs.writeFileSync(dist, '');
    const when = (opts.dist === 'stale' ? now - 600_000 : now + 600_000) / 1000;
    fs.utimesSync(dist, when, when);
  }
  return root;
}

describe('doctor', () => {
  it('daemon alive but api_token gone → token FAIL; nothing is created (scenario table)', async () => {
    const results = await runChecks(deps({ token: TOKEN }));
    expect(byId(results, 'token')).toMatchObject({ status: 'FAIL' });
    expect(byId(results, 'token').detail).toContain('daemon is running');
    expect(byId(results, 'daemon')).toMatchObject({ status: 'WARN' });
    // read-only: no ~/.inari-mcp, no token, no safety.json
    expect(fs.readdirSync(home)).toEqual([]);
  });

  it('verified daemon: other version, settings differ, two Native Hosts → WARN each', async () => {
    writeToken(TOKEN);
    const results = await runChecks(deps({
      token: TOKEN,
      health: { version: '0.0.1' },
      info: { nativeHosts: 2, settings: { FOX_READ_ONLY: '1' } },
    }));
    expect(byId(results, 'daemon')).toMatchObject({ status: 'WARN' });
    expect(byId(results, 'daemon').detail).toContain('v0.0.1');
    expect(byId(results, 'settings').detail).toContain("FOX_READ_ONLY: this session 'off', daemon 'on'");
    expect(byId(results, 'browsers').detail).toContain('2 Native Hosts');
  });

  it('a daemon that cannot prove the token → FAIL; broken safety.json → FAIL', async () => {
    writeToken(TOKEN);
    fs.writeFileSync(path.join(home, '.inari-mcp', 'safety.json'), '{ "read_only": tru');
    const results = await runChecks(deps({ token: 'b'.repeat(64) }));
    expect(byId(results, 'daemon')).toMatchObject({ status: 'FAIL' });
    expect(byId(results, 'safety-config')).toMatchObject({ status: 'FAIL' });
  });
});

describe('doctor: native-messaging', () => {
  it('reads the manifest path from HKCU and reports HKLM as also registered', async () => {
    const first = writeNmManifest();
    const second = writeNmManifest();
    const results = await runChecks(deps(undefined, {
      platform: 'win32',
      run: fakeRun({ HKCU: first.manifestPath, HKLM: second.manifestPath }),
    }));
    const nm = byId(results, 'native-messaging');
    expect(nm.status).toBe('OK');
    expect(nm.detail).toContain(first.manifestPath);
    expect(nm.detail).toContain('HKCU\\Software\\Mozilla\\NativeMessagingHosts\\inari_mcp');
    expect(nm.detail).toContain(`also registered: ${second.manifestPath}`);
  });

  it('falls back to HKLM when HKCU has no value', async () => {
    const { manifestPath } = writeNmManifest();
    const results = await runChecks(deps(undefined, { platform: 'win32', run: fakeRun({ HKLM: manifestPath }) }));
    const nm = byId(results, 'native-messaging');
    expect(nm.status).toBe('OK');
    expect(nm.detail).toContain('HKLM\\Software\\Mozilla\\NativeMessagingHosts\\inari_mcp');
  });

  it('parses a localized (cp932) reg query and expands %USERPROFILE% in REG_EXPAND_SZ', async () => {
    // The decoded cp932 output names the default value "(既定)"; the path is a REG_EXPAND_SZ.
    const dir = path.join(home, 'nm');
    fs.mkdirSync(dir, { recursive: true });
    const wrapperPath = path.join(dir, 'inari_mcp.bat');
    fs.writeFileSync(wrapperPath, `node "${hostEntry}" %*\r\n`);
    const manifestPath = path.join(dir, `${NM_HOST_NAME}.json`);
    fs.writeFileSync(manifestPath, JSON.stringify({
      name: NM_HOST_NAME, path: wrapperPath, type: 'stdio', allowed_extensions: [geckoId],
    }));
    const results = await runChecks(deps(undefined, {
      platform: 'win32',
      run: fakeRun({ HKCU: path.join('%USERPROFILE%', 'nm', `${NM_HOST_NAME}.json`) }, { valueName: '(既定)', expand: true }),
    }));
    const nm = byId(results, 'native-messaging');
    expect(nm.status).toBe('OK');
    expect(nm.detail).toContain(manifestPath);
  });

  it('no registration at all → WARN (headless needs none) with the reg query error', async () => {
    const results = await runChecks(deps(undefined, {
      platform: 'win32',
      run: fakeRun({}, { error: 'spawn reg ENOENT' }),
    }));
    const nm = byId(results, 'native-messaging');
    expect(nm.status).toBe('WARN');
    expect(nm.detail).toContain('inari_mcp is not registered');
    expect(nm.detail).toContain('reg query failed: spawn reg ENOENT');
    expect(nm.fix).toContain('npm run setup');
    expect(nm.fix).toContain('headless');
    // Without a usable manifest the wrapper cannot be judged.
    expect(byId(results, 'nm-wrapper')).toMatchObject({ status: 'SKIP' });
  });

  it('manifest with a wrong name / type / allowed_extensions → FAIL listing every problem', async () => {
    const { manifestPath } = writeNmManifest({
      manifest: { name: 'inari_mcp_old', type: 'pipe', allowed_extensions: ['someone-else@example.com'] },
    });
    const nm = byId(await runChecks(winDeps(manifestPath)), 'native-messaging');
    expect(nm.status).toBe('FAIL');
    expect(nm.detail).toContain("name is 'inari_mcp_old'");
    expect(nm.detail).toContain("type is 'pipe'");
    expect(nm.detail).toContain(`allowed_extensions lacks ${geckoId}`);
  });

  it('manifest pointing at a missing wrapper → FAIL; a relative path → FAIL', async () => {
    const missing = writeNmManifest({ noWrapper: true });
    const gone = byId(await runChecks(winDeps(missing.manifestPath)), 'native-messaging');
    expect(gone.status).toBe('FAIL');
    expect(gone.detail).toContain(`wrapper ${missing.wrapperPath} does not exist`);

    const relative = writeNmManifest({ manifest: { path: 'inari_mcp.bat' } });
    const rel = byId(await runChecks(winDeps(relative.manifestPath)), 'native-messaging');
    expect(rel.status).toBe('FAIL');
    expect(rel.detail).toContain("path 'inari_mcp.bat' is not absolute");
  });

  it('a manifest that is not JSON → FAIL naming the registry key', async () => {
    const { dir, manifestPath } = writeNmManifest();
    fs.writeFileSync(manifestPath, '{ "name": ');
    const nm = byId(await runChecks(winDeps(manifestPath)), 'native-messaging');
    expect(nm.status).toBe('FAIL');
    expect(nm.detail).toContain('invalid JSON');
    expect(nm.detail).toContain('registered in HKCU');
    expect(dir).toBe(path.dirname(manifestPath));
  });
});

describe('doctor: nm-wrapper', () => {
  it('a wrapper of another checkout → WARN naming the other Native Host', async () => {
    const other = 'C:\\other-checkout\\packages\\native-host\\dist\\index.js';
    const { manifestPath, wrapperPath } = writeNmManifest({ wrapper: `node "${other}" %*\r\n` });
    const w = byId(await runChecks(winDeps(manifestPath)), 'nm-wrapper');
    expect(w.status).toBe('WARN');
    expect(w.detail).toContain(wrapperPath);
    expect(w.detail).toContain(other);
    expect(w.fix).toContain('registered last');
  });

  it('the node pinned in a .bat wrapper is gone → WARN about the PATH fallback', async () => {
    const pinned = path.join(os.tmpdir(), 'inari-doctor-no-such-node', 'node.exe');
    const wrapper = [
      '@echo off',
      `if not exist "${pinned}" goto pathnode`,
      `"${pinned}" "${hostEntry}" %*`,
      ':pathnode',
      `node "${hostEntry}" %*`,
      '',
    ].join('\r\n');
    const { manifestPath } = writeNmManifest({ wrapper });
    const w = byId(await runChecks(winDeps(manifestPath)), 'nm-wrapper');
    expect(w.status).toBe('WARN');
    expect(w.detail).toContain('node pinned in the wrapper is gone');
    expect(w.detail).toContain(pinned);
  });

  it('a .bat wrapper with a node that exists → OK', async () => {
    const dir = tempDir('inari-doctor-node-');
    const pinned = path.join(dir, 'node.exe');
    fs.writeFileSync(pinned, '');
    const wrapper = `@echo off\r\nif not exist "${pinned}" goto pathnode\r\n"${pinned}" "${hostEntry}" %*\r\n`;
    const { manifestPath } = writeNmManifest({ wrapper });
    const w = byId(await runChecks(winDeps(manifestPath)), 'nm-wrapper');
    expect(w.status).toBe('OK');
    expect(w.detail).toContain(pinned);
  });

  it(".sh wrapper: the node path is read through the shell's '\\'' quoting", async () => {
    const dir = tempDir("inari-doctor-q-");
    // A directory whose name contains a single quote: the installer writes it as '\''.
    const nodeDir = path.join(dir, "no'de");
    fs.mkdirSync(nodeDir);
    const pinned = path.join(nodeDir, 'node');
    fs.writeFileSync(pinned, '');
    const quoted = pinned.replace(/'/g, "'\\''");
    const wrapper = ['#!/bin/sh', `if [ -x '${quoted}' ]; then`, `  exec '${quoted}' '${hostEntry}' "$@"`, 'fi', `exec node '${hostEntry}' "$@"`, ''].join('\n');
    const { manifestPath } = writeLinuxNmManifest({ wrapper });
    const results = await runChecks(deps(undefined, { platform: 'linux' }));
    expect(byId(results, 'native-messaging').detail).toContain(manifestPath);
    const w = byId(results, 'nm-wrapper');
    expect(w.status).toBe('OK');
    expect(w.detail).toContain(quoted);
  });

  it('.sh wrapper whose quoted node is gone → WARN with the unquoted path', async () => {
    const nodeDir = path.join(tempDir('inari-doctor-q-'), "no'de");
    const pinned = path.join(nodeDir, 'node');
    const quoted = pinned.replace(/'/g, "'\\''");
    const wrapper = ['#!/bin/sh', `if [ -x '${quoted}' ]; then`, `  exec '${quoted}' '${hostEntry}' "$@"`, 'fi', ''].join('\n');
    writeLinuxNmManifest({ wrapper });
    const w = byId(await runChecks(deps(undefined, { platform: 'linux' })), 'nm-wrapper');
    expect(w.status).toBe('WARN');
    expect(w.detail).toContain('node pinned in the wrapper is gone');
    expect(w.detail).toContain(pinned);
  });
});

describe('doctor: claude registrations', () => {
  const entryFor = (script: string): Record<string, unknown> => ({ command: 'node', args: [script] });

  it('reads the user scope from ~/.claude.json', async () => {
    writeClaudeConfig({ mcpServers: { 'inari-mcp': entryFor(serverEntry) } });
    const c = byId(await runChecks(deps(undefined)), 'claude');
    expect(c.status).toBe('OK');
    expect(c.detail).toContain('inari-mcp (user): node ');
    expect(c.detail).toContain('claude mcp get is not run');
  });

  it('reads the local scope from projects[cwd] and ignores other projects', async () => {
    writeClaudeConfig({
      projects: {
        [cwd]: { mcpServers: { 'inari-mcp': entryFor(serverEntry) } },
        [path.join(os.tmpdir(), 'another-project')]: { mcpServers: { 'inari-mcp': entryFor('C:\\elsewhere\\index.js') } },
      },
    });
    const c = byId(await runChecks(deps(undefined)), 'claude');
    expect(c.status).toBe('OK');
    expect(c.detail).toContain('inari-mcp (local)');
    expect(c.detail).not.toContain('elsewhere');
  });

  it('reads the project scope from ./.mcp.json, by the dist/index.js path even under another name', async () => {
    fs.writeFileSync(path.join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { fox: entryFor(serverEntry) } }));
    const c = byId(await runChecks(deps(undefined)), 'claude');
    expect(c.status).toBe('OK');
    expect(c.detail).toContain('fox (project)');
  });

  it('an entry of another checkout → WARN with the re-registration commands', async () => {
    const other = path.join(os.tmpdir(), 'other', 'packages', 'mcp-server', 'dist', 'index.js');
    writeClaudeConfig({ mcpServers: { 'inari-mcp': entryFor(other) } });
    const c = byId(await runChecks(deps(undefined)), 'claude');
    expect(c.status).toBe('WARN');
    expect(c.detail).toContain(`not this checkout's ${serverEntry}`);
    expect(c.fix).toContain('claude mcp remove inari-mcp -s user');
    expect(c.fix).toContain(`claude mcp add --scope user inari-mcp -- node "${serverEntry}"`);
  });

  it('no entry anywhere → WARN naming the config file that was read', async () => {
    const c = byId(await runChecks(deps(undefined)), 'claude');
    expect(c.status).toBe('WARN');
    expect(c.detail).toContain(path.join(home, '.claude.json'));
    expect(c.detail).toContain('./.mcp.json');
  });

  it('CLAUDE_CONFIG_DIR moves the config file', async () => {
    const dir = tempDir('inari-doctor-claude-');
    // The home file would be wrong; CLAUDE_CONFIG_DIR wins.
    writeClaudeConfig({ mcpServers: { 'inari-mcp': entryFor('C:\\home\\index.js') } });
    writeClaudeConfig({ mcpServers: { 'inari-mcp': entryFor(serverEntry) } }, dir);
    process.env['CLAUDE_CONFIG_DIR'] = dir;
    const c = byId(await runChecks(deps(undefined)), 'claude');
    expect(c.status).toBe('OK');
    expect(c.detail).not.toContain('C:\\home\\index.js');
  });

  it('a broken ~/.claude.json is reported, not thrown', async () => {
    fs.writeFileSync(path.join(home, '.claude.json'), '{ "mcpServers": ');
    const c = byId(await runChecks(deps(undefined)), 'claude');
    expect(c.status).toBe('WARN');
    expect(c.detail).toContain('invalid JSON');
  });

  it("the registration's env is the session for the settings comparison", async () => {
    writeToken(TOKEN);
    writeClaudeConfig({
      projects: { [cwd]: { mcpServers: { 'inari-mcp': { ...entryFor(serverEntry), env: { FOX_READ_ONLY: '1' } } } } },
    });
    const results = await runChecks(deps({ token: TOKEN, info: { settings: { FOX_READ_ONLY: '1' } } }));
    expect(byId(results, 'settings')).toMatchObject({ status: 'OK' });
    expect(byId(results, 'settings').detail).toContain('the Claude Code registration env');
  });

  it('R-2: compares effective values like the relay: true and 1, old and new names agree', async () => {
    writeToken(TOKEN);
    writeClaudeConfig({
      projects: {
        [cwd]: {
          mcpServers: {
            'inari-mcp': { ...entryFor(serverEntry), env: { CLAUDE_BROWSER_READ_ONLY: 'yes' } },
          },
        },
      },
    });
    const results = await runChecks(deps({
      token: TOKEN,
      info: {
        settings: { FOX_READ_ONLY: '1' },
        effectiveSettings: { FOX_READ_ONLY: 'on' },
      },
    }));
    expect(byId(results, 'settings')).toMatchObject({ status: 'OK' });
  });

  it('R-2: an effective difference is still a WARN', async () => {
    writeToken(TOKEN);
    writeClaudeConfig({
      projects: { [cwd]: { mcpServers: { 'inari-mcp': { ...entryFor(serverEntry), env: { FOX_READ_ONLY: 'true' } } } } },
    });
    const results = await runChecks(deps({ token: TOKEN, info: { effectiveSettings: { FOX_READ_ONLY: 'off' } } }));
    expect(byId(results, 'settings')).toMatchObject({ status: 'WARN' });
    expect(byId(results, 'settings').detail).toContain("FOX_READ_ONLY: this session 'on', daemon 'off'");
  });
});

describe('doctor: browsers and build', () => {
  it('no browser while the daemon is young → WARN about the reconnect backoff', async () => {
    writeToken(TOKEN);
    const results = await runChecks(deps({ token: TOKEN, health: { browsers_connected: 0, uptime: 12 } }));
    const b = byId(results, 'browsers');
    expect(b.status).toBe('WARN');
    expect(b.detail).toContain('the daemon is up only 12s');
    expect(b.fix).toContain('wait a minute');
  });

  it('no browser after a minute → WARN about Firefox and the extension', async () => {
    writeToken(TOKEN);
    const results = await runChecks(deps({ token: TOKEN, health: { browsers_connected: 0, uptime: 61 } }));
    const b = byId(results, 'browsers');
    expect(b.status).toBe('WARN');
    expect(b.detail).toBe('no browser connected');
    expect(b.fix).toContain('about:debugging');
  });

  it('a connected headless browser → OK with the Native Host count', async () => {
    writeToken(TOKEN);
    const results = await runChecks(deps({ token: TOKEN, info: { nativeHosts: 1, headless: true } }));
    expect(byId(results, 'browsers')).toMatchObject({ status: 'OK' });
    expect(byId(results, 'browsers').detail).toContain('1 connected (Native Hosts: 1, headless)');
  });

  it('no daemon to ask → SKIP', async () => {
    expect(byId(await runChecks(deps(undefined)), 'browsers')).toMatchObject({ status: 'SKIP' });
  });

  it('build: dist missing → FAIL listing every package', async () => {
    const b = byId(await runChecks(deps(undefined, { repoRoot: fakeRepo({ dist: 'missing' }) })), 'build');
    expect(b.status).toBe('FAIL');
    expect(b.detail).toBe('dist missing: shared, mcp-server, native-host, extension');
    expect(b.fix).toContain('npm run build');
  });

  it('build: sources newer than dist → WARN', async () => {
    const b = byId(await runChecks(deps(undefined, { repoRoot: fakeRepo({ dist: 'stale' }) })), 'build');
    expect(b.status).toBe('WARN');
    expect(b.detail).toContain('sources newer than dist: shared, mcp-server, native-host, extension');
    expect(b.fix).toContain('reload the Extension');
  });

  it('build: dist newer than src → OK', async () => {
    const b = byId(await runChecks(deps(undefined, { repoRoot: fakeRepo({ dist: 'fresh' }) })), 'build');
    expect(b).toMatchObject({ status: 'OK' });
  });
});

describe('doctor: safety-config (the daemon\'s own validator)', () => {
  function writeSafety(content: string, dir = path.join(home, '.inari-mcp')): string {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'safety.json');
    fs.writeFileSync(file, content);
    return file;
  }

  // R2-B S-1 / R-5: an unknown key used to be a WARN ("ignored keys") while
  // the daemon dropped it; the daemon now refuses the file, so does the doctor.
  it('an unknown key → FAIL naming it; the fix says every tool is refused', async () => {
    writeSafety('{ "readonly": true }');
    const s = byId(await runChecks(deps(undefined)), 'safety-config');
    expect(s.status).toBe('FAIL');
    expect(s.detail).toContain('readonly');
    expect(s.fix).toContain('config_error');
  });

  it('a partial container_scope → OK (the daemon fills in the defaults)', async () => {
    writeSafety('{ "container_scope": { "container_name": "Foo" } }');
    const s = byId(await runChecks(deps(undefined)), 'safety-config');
    expect(s.status).toBe('OK');
  });

  it('a blank FOX_SAFETY_CONFIG falls through to CLAUDE_BROWSER_SAFETY_CONFIG, as in the daemon', async () => {
    const file = writeSafety('{ "read_only": true }', tempDir('inari-doctor-safety-'));
    process.env['FOX_SAFETY_CONFIG'] = ' ';
    process.env['CLAUDE_BROWSER_SAFETY_CONFIG'] = file;
    const s = byId(await runChecks(deps(undefined)), 'safety-config');
    expect(s.status).toBe('OK');
    expect(s.detail).toContain(file);
  });

  it("the running daemon's path wins; its blank FOX_ value falls through to the legacy one", async () => {
    writeToken(TOKEN);
    const file = writeSafety('{ "audit_log": "yes" }', tempDir('inari-doctor-safety-'));
    const s = byId(await runChecks(deps({
      token: TOKEN,
      info: { settings: { FOX_SAFETY_CONFIG: '', CLAUDE_BROWSER_SAFETY_CONFIG: file } },
    })), 'safety-config');
    expect(s.status).toBe('FAIL');
    expect(s.detail).toContain(file);
    expect(s.detail).toContain('audit_log: Expected boolean');
  });
});

describe('doctor: screenshots and logs', () => {
  it('no FOX_SCREENSHOTS_DIR → OK with the default directory', async () => {
    const s = byId(await runChecks(deps(undefined)), 'screenshots');
    expect(s.status).toBe('OK');
    expect(s.detail).toContain(path.join(home, '.inari-mcp', 'screenshots'));
    expect(s.detail).toContain('not created yet');
  });

  it("a relative FOX_SCREENSHOTS_DIR → WARN: the two processes' working directories differ", async () => {
    process.env['FOX_SCREENSHOTS_DIR'] = 'shots';
    const s = byId(await runChecks(deps(undefined)), 'screenshots');
    expect(s.status).toBe('WARN');
    expect(s.detail).toContain("this session uses the relative FOX_SCREENSHOTS_DIR='shots'");
    expect(s.fix).toBe('use an absolute path');
  });

  it('an absolute, non-default FOX_SCREENSHOTS_DIR → WARN: Firefox may use another one', async () => {
    const dir = path.join(os.tmpdir(), 'inari-shots');
    process.env['FOX_SCREENSHOTS_DIR'] = dir;
    const s = byId(await runChecks(deps(undefined)), 'screenshots');
    expect(s.status).toBe('WARN');
    expect(s.detail).toContain(`this session uses ${dir}`);
    expect(s.fix).toContain('set the same FOX_SCREENSHOTS_DIR for Firefox');
  });

  // R2-B C-3 / L-5: a blank value is unset, as the daemon reads it.
  it('a blank FOX_SCREENSHOTS_DIR → OK with the default directory', async () => {
    process.env['FOX_SCREENSHOTS_DIR'] = '  ';
    const s = byId(await runChecks(deps(undefined)), 'screenshots');
    expect(s.status).toBe('OK');
    expect(s.detail).toContain(path.join(home, '.inari-mcp', 'screenshots'));
  });

  it("the running daemon's FOX_SCREENSHOTS_DIR wins over the session's", async () => {
    writeToken(TOKEN);
    const mine = path.join(os.tmpdir(), 'inari-shots-session');
    const theirs = path.join(os.tmpdir(), 'inari-shots-daemon');
    process.env['FOX_SCREENSHOTS_DIR'] = mine;
    const s = byId(await runChecks(deps({ token: TOKEN, info: { settings: { FOX_SCREENSHOTS_DIR: theirs } } })), 'screenshots');
    expect(s.status).toBe('WARN');
    expect(s.detail).toContain(`the running daemon uses ${theirs}`);
    expect(s.detail).not.toContain(mine);
  });

  it('"max start attempts" after the last host start → WARN that it gave up', async () => {
    const logs = path.join(home, '.inari-mcp', 'logs');
    fs.mkdirSync(logs, { recursive: true });
    fs.writeFileSync(path.join(logs, 'native-host.log'), [
      '2026-10-01T09:00:00.000Z Native Host v0.1.4',
      '2026-10-01T09:00:01.000Z daemon did not answer',
      '2026-10-01T09:00:30.000Z giving up: max start attempts (10) reached',
      '',
    ].join('\n'));
    const l = byId(await runChecks(deps(undefined)), 'logs');
    expect(l.status).toBe('WARN');
    expect(l.detail).toContain('the Native Host gave up starting the daemon (2026-10-01T09:00:30.000Z)');
    expect(l.detail).toContain('native-host.log');
    expect(l.fix).toContain('daemon.log');
  });

  it('a host start after "max start attempts" → OK again', async () => {
    const logs = path.join(home, '.inari-mcp', 'logs');
    fs.mkdirSync(logs, { recursive: true });
    fs.writeFileSync(path.join(logs, 'native-host.log'), [
      '2026-10-01T09:00:30.000Z giving up: max start attempts (10) reached',
      '2026-10-01T09:10:00.000Z InariMCP Native Host v0.1.4 starting (PID 1)',
      '',
    ].join('\n'));
    const l = byId(await runChecks(deps(undefined)), 'logs');
    expect(l.status).toBe('OK');
    expect(l.detail).toContain('native-host.log');
  });

  it('no log files yet → OK', async () => {
    const l = byId(await runChecks(deps(undefined)), 'logs');
    expect(l.status).toBe('OK');
    expect(l.detail).toContain('no log files yet');
  });
});

describe('doctor: token, powershell, foreign daemons', () => {
  it('a token readable by other users → WARN with the chmod commands (POSIX only)', async () => {
    writeToken(TOKEN);
    fs.chmodSync(path.join(home, '.inari-mcp', 'api_token'), 0o644);
    const t = byId(await runChecks(deps(undefined, { platform: 'linux' })), 'token');
    expect(t.status).toBe('WARN');
    expect(t.detail).toContain('readable by other users');
    expect(t.fix).toContain(`chmod 600 ${path.join(home, '.inari-mcp', 'api_token')}`);
  });

  it.runIf(posix)('a token with mode 600 in a 700 directory → OK with the mode', async () => {
    writeToken(TOKEN);
    fs.chmodSync(path.join(home, '.inari-mcp'), 0o700);
    fs.chmodSync(path.join(home, '.inari-mcp', 'api_token'), 0o600);
    const t = byId(await runChecks(deps(undefined, { platform: 'linux' })), 'token');
    expect(t.status).toBe('OK');
    expect(t.detail).toContain('mode 600');
  });

  it('on Windows the file mode is not judged', async () => {
    writeToken(TOKEN);
    const t = byId(await runChecks(deps(undefined, { platform: 'win32', run: fakeRun({}) })), 'token');
    expect(t.status).toBe('OK');
    expect(t.detail).toContain('file modes do not apply on Windows');
  });

  it('an empty api_token → FAIL', async () => {
    fs.mkdirSync(path.join(home, '.inari-mcp'), { recursive: true });
    fs.writeFileSync(path.join(home, '.inari-mcp', 'api_token'), '   ');
    const t = byId(await runChecks(deps(undefined)), 'token');
    expect(t.status).toBe('FAIL');
    expect(t.detail).toContain('is empty');
  });

  it('PowerShell in FullLanguage → OK', async () => {
    const results = await runChecks(deps(undefined, {
      platform: 'win32',
      run: fakeRun({}, { powershell: { status: 0, stdout: 'FullLanguage' } }),
    }));
    const p = byId(results, 'powershell');
    expect(p.status).toBe('OK');
    expect(p.detail).toContain('FullLanguage');
  });

  it('PowerShell in ConstrainedLanguage → WARN about Add-Type', async () => {
    const results = await runChecks(deps(undefined, {
      platform: 'win32',
      run: fakeRun({}, { powershell: { status: 0, stdout: 'ConstrainedLanguage\r\n' } }),
    }));
    const p = byId(results, 'powershell');
    expect(p.status).toBe('WARN');
    expect(p.detail).toContain('runs in ConstrainedLanguage (Add-Type blocked)');
    expect(p.fix).toContain('native-host.log');
  });

  it('PowerShell that cannot be started → WARN with the reason', async () => {
    const results = await runChecks(deps(undefined, {
      platform: 'win32',
      run: fakeRun({}, { powershell: { status: null, stdout: '', error: 'spawn powershell.exe ENOENT' } }),
    }));
    const p = byId(results, 'powershell');
    expect(p.status).toBe('WARN');
    expect(p.detail).toContain('not usable (spawn powershell.exe ENOENT)');
  });

  it('PowerShell is not probed off Windows', async () => {
    expect(byId(await runChecks(deps(undefined, { platform: 'linux' })), 'powershell')).toMatchObject({ status: 'SKIP' });
  });

  it('another program on the port → daemon FAIL, browsers SKIP, token untouched', async () => {
    const results = await runChecks(deps(undefined, {
      get: async (): Promise<HttpReply> => ({ status: 200, headers: {}, raw: Buffer.from('<html>hello</html>') }),
    }));
    const d = byId(results, 'daemon');
    expect(d.status).toBe('FAIL');
    expect(d.detail).toContain('does not answer as InariMCP');
    expect(d.fix).toContain('FOX_HTTP_PORT');
    expect(byId(results, 'browsers')).toMatchObject({ status: 'SKIP' });
    expect(byId(results, 'token')).toMatchObject({ status: 'OK' });
  });

  it('a /health of the right service but another protocol → daemon FAIL', async () => {
    writeToken(TOKEN);
    const results = await runChecks(deps({ token: TOKEN, health: { protocol: 1, version: '0.0.9' } }));
    const d = byId(results, 'daemon');
    expect(d.status).toBe('FAIL');
    expect(d.detail).toContain('daemon of another protocol (protocol 1, version 0.0.9');
    expect(d.detail).toContain(`needs ${String(DAEMON_PROTOCOL_VERSION)}`);
    // An incompatible daemon is not asked about browsers or settings.
    expect(byId(results, 'browsers')).toMatchObject({ status: 'SKIP' });
    expect(byId(results, 'settings')).toMatchObject({ status: 'SKIP' });
  });

  it('a daemon that answers but is not ready → WARN', async () => {
    writeToken(TOKEN);
    const d = byId(await runChecks(deps({ token: TOKEN, health: { ready: false } })), 'daemon');
    expect(d.status).toBe('WARN');
    expect(d.detail).toContain('still starting');
  });
});

describe('doctor: runDoctor', () => {
  let written: string[];
  beforeEach(() => {
    written = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array): boolean => {
      written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
      return true;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exits 1 when an item FAILs, and prints a header, every item and the summary', async () => {
    const code = await runDoctor(deps({ token: TOKEN }, { platform: 'linux' }));
    expect(code).toBe(1);
    const out = written.join('');
    expect(out).toContain(`InariMCP doctor v${PACKAGE_VERSION} (linux, node v${process.versions.node})`);
    // Ids are padded to the longest one ('native-messaging'), fix lines line up with the details.
    expect(out).toMatch(/^FAIL {2}token {13}the daemon is running/m);
    expect(out).toMatch(/^ {24}fix: end the process listening on port /m);
    expect(out).toMatch(/\n\d+ OK, \d+ WARN, [1-9]\d* FAIL, \d+ SKIP\n$/);
  });

  it('exits 0 when nothing FAILs', async () => {
    const { manifestPath } = writeNmManifest();
    const code = await runDoctor(winDeps(manifestPath, undefined, { powershell: { status: 0, stdout: 'FullLanguage' } }));
    const out = written.join('');
    expect(out).not.toContain('FAIL  ');
    expect(code).toBe(0);
  });

  it('exits 0 when the only problem is a missing registration (headless-only setups)', async () => {
    const code = await runDoctor(deps(undefined, {
      platform: 'win32',
      run: fakeRun({}, { powershell: { status: 0, stdout: 'FullLanguage' } }),
    }));
    const out = written.join('');
    expect(out).toMatch(/^WARN {2}native-messaging {2}inari_mcp is not registered/m);
    expect(out).not.toContain('FAIL  ');
    expect(code).toBe(0);
  });
  // TODO(test): Linux / macOS with no manifest in any directory → WARN; a registered manifest whose file is missing stays FAIL

  it('formatResults aligns the ids and prints fix lines only for non-OK items', () => {
    const out = formatResults([
      { id: 'node', status: 'OK', detail: 'v24', fix: 'never printed' },
      { id: 'native-messaging', status: 'FAIL', detail: 'gone', fix: 're-run the installer' },
      { id: 'logs', status: 'SKIP', detail: 'nothing' },
    ]);
    expect(out).toBe([
      'OK    node              v24',
      'FAIL  native-messaging  gone',
      '                        fix: re-run the installer',
      'SKIP  logs              nothing',
      '',
      '1 OK, 0 WARN, 1 FAIL, 1 SKIP',
      '',
    ].join('\n'));
  });
});
