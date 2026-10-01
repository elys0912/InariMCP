import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runChecks, type CheckResult, type DoctorDeps, type HttpReply } from '../src/doctor/checks.js';
import { AUTH_HEADER, DAEMON_PROTOCOL_VERSION, MAC_LABEL, computeMac, responseMac } from '@kitsune-mcp/shared/node';
import { PACKAGE_VERSION } from '../src/version.js';

const TOKEN = 'a'.repeat(64);
const repoRoot = path.resolve(__dirname, '..', '..', '..');

// Keep the doctor away from the real ~/.kitsune-mcp and ~/.claude.json.
let home: string;
let cwd: string;
const savedEnv = { ...process.env };
beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'kitsune-doctor-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kitsune-doctor-cwd-'));
  process.env['HOME'] = home;
  process.env['USERPROFILE'] = home;
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('FOX_') || k.startsWith('CLAUDE_BROWSER_') || k === 'CLAUDE_CONFIG_DIR') delete process.env[k];
  }
});
afterAll(() => {
  process.env = savedEnv;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});
beforeEach(() => {
  fs.rmSync(path.join(home, '.kitsune-mcp'), { recursive: true, force: true });
});

interface FakeDaemon {
  /** Token the fake daemon holds (proves /health, signs /daemon/info). */
  token: string;
  health?: Record<string, unknown>;
  info?: Record<string, unknown>;
}

function deps(daemon: FakeDaemon | undefined): DoctorDeps {
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
          service: 'kitsune-mcp',
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
  };
}

function byId(results: CheckResult[], id: string): CheckResult {
  const r = results.find((x) => x.id === id);
  if (r === undefined) throw new Error(`no result ${id}`);
  return r;
}

function writeToken(token: string): void {
  fs.mkdirSync(path.join(home, '.kitsune-mcp'), { recursive: true });
  fs.writeFileSync(path.join(home, '.kitsune-mcp', 'api_token'), token, { mode: 0o600 });
}

describe('doctor', () => {
  it('daemon alive but api_token gone → token FAIL; nothing is created (scenario table)', async () => {
    const results = await runChecks(deps({ token: TOKEN }));
    expect(byId(results, 'token')).toMatchObject({ status: 'FAIL' });
    expect(byId(results, 'token').detail).toContain('daemon is running');
    expect(byId(results, 'daemon')).toMatchObject({ status: 'WARN' });
    // read-only: no ~/.kitsune-mcp, no token, no safety.json
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
    expect(byId(results, 'settings').detail).toContain("FOX_READ_ONLY: session '(unset)', daemon '1'");
    expect(byId(results, 'browsers').detail).toContain('2 Native Hosts');
  });

  it('a daemon that cannot prove the token → FAIL; broken safety.json → FAIL', async () => {
    writeToken(TOKEN);
    fs.writeFileSync(path.join(home, '.kitsune-mcp', 'safety.json'), '{ "read_only": tru');
    const results = await runChecks(deps({ token: 'b'.repeat(64) }));
    expect(byId(results, 'daemon')).toMatchObject({ status: 'FAIL' });
    expect(byId(results, 'safety-config')).toMatchObject({ status: 'FAIL' });
  });

  // TODO(test): native-messaging — HKCU/HKLM parsing of `reg query` (incl. cp932 output), manifest name/type/allowed_extensions, missing wrapper
  // TODO(test): nm-wrapper — wrapper of another checkout (WARN), pinned node gone (WARN), .sh quoting
  // TODO(test): claude — entries from user / local (projects[cwd]) / .mcp.json, other checkout, CLAUDE_CONFIG_DIR
  // TODO(test): browsers — 0 browsers with uptime < 60 s vs later; build — stale / missing dist
  // TODO(test): screenshots — relative / non-default FOX_SCREENSHOTS_DIR; logs — "max start attempts" after the last host start
  // TODO(test): token file mode on POSIX; powershell language modes; foreign / incompatible /health
  // TODO(test): runDoctor exit code (1 on FAIL) and output format
});
