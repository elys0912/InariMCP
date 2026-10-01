/**
 * scripts/install.mjs / scripts/uninstall.mjs and their helpers.
 *
 * Nothing here registers anything: the registry, processes, the network and
 * Claude Code are stubbed, and file-system work happens in a temp directory.
 *
 * TODO(test): nmManifestTargets — every path per OS: win32 (registry key +
 *   ~/.kitsune-mcp/native-host/kitsune_mcp.json), darwin, linux ~/.mozilla,
 *   XDG ($XDG_CONFIG_HOME set / unset / relative), Snap (~/snap/firefox and
 *   /snap/firefox), Flatpak (~/.var/app, /var/lib/flatpak, ~/.local/share/flatpak),
 *   `all: true` for uninstall.
 * TODO(test): buildWindowsWrapper — '%' escaping, "Program Files (x86)",
 *   non-ASCII paths (chcp 65001 line), CRLF; buildPosixWrapper quoting of "'".
 * TODO(test): parseRegDefaultValue — localized "(既定)" label, REG_EXPAND_SZ,
 *   empty value, key missing.
 * TODO(test): parseArgs — `--x=v` / `--x v`, value missing, flag with =value,
 *   every conflicting pair, --grace bounds, compatibility flags.
 * TODO(test): findClaudeEntries — user / local (Windows path keys with / and \,
 *   case) / project (.mcp.json) / other local directories; CLAUDE_CONFIG_DIR.
 * TODO(test): nodeVersionManager — each manager, Scoop "current" and Homebrew
 *   opt paths not flagged.
 * TODO(test): classifyProcesses — host / daemon / relay / other checkout,
 *   Windows case and slash differences; parsePsOutput / parseTabOutput / wmic csv.
 * TODO(test): commandInvocation — .cmd via cmd.exe, arguments with quotes rejected.
 * TODO(test): stopProcess — SIGTERM honoured, SIGKILL after grace, ESRCH, EPERM.
 * TODO(test): probeDaemon — none / foreign / unverified / verified with pid,
 *   bad response signature ignored.
 * TODO(test): writeFileAtomic — rename retry on EPERM/EBUSY, temp file removed
 *   when the write fails, POSIX mode.
 * TODO(test): removeTreeSafe — refuses symlinks / junctions inside the tree.
 * TODO(test): install non-dry run in a temp home (files written, reg.exe add
 *   arguments, unchanged on second run, --register-claude replace flow,
 *   prompts only with a TTY); uninstall order (NM registration before
 *   stopping the host, host before daemon), --purge, --no-stop.
 * TODO(test): packages/native-host/kitsune_mcp.json template — name / type /
 *   allowed_extensions agree with buildManifest() and the extension's gecko id.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as serverAuth from '@kitsune-mcp/shared/node';
import {
  UsageError, WIN_REG_KEY, buildManifest, claudeEntryState, computeMac, manifestState,
  nmManifestTargets, parseInstallArgs, serializeJson,
} from '../../scripts/lib/core.mjs';
import { writeFileAtomic } from '../../scripts/lib/system.mjs';
import { runInstall } from '../../scripts/install.mjs';
import { runUninstall } from '../../scripts/uninstall.mjs';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kitsune-setup-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('parseInstallArgs', () => {
  it('reads flags and values', () => {
    const o = parseInstallArgs(['-n', '--register-claude', '--claude-scope=local', '--node', '/x/node']);
    expect(o).toMatchObject({ dryRun: true, registerClaude: true, claudeScope: 'local', node: '/x/node', yes: false });
  });

  it('rejects unknown options and conflicting flags', () => {
    expect(() => parseInstallArgs(['--bogus'])).toThrow(UsageError);
    expect(() => parseInstallArgs(['--register-claude', '--no-register-claude'])).toThrow(/cannot be used together/);
  });
});

describe('host manifest', () => {
  it('is the Native Messaging manifest Firefox expects', () => {
    const m = buildManifest({ wrapperPath: 'C:\\Users\\u\\.kitsune-mcp\\native-host\\run-host.cmd', geckoId: 'id@example' });
    expect(JSON.parse(serializeJson(m))).toEqual({
      name: 'kitsune_mcp',
      description: 'KitsuneMCP Native Messaging Host',
      path: 'C:\\Users\\u\\.kitsune-mcp\\native-host\\run-host.cmd',
      type: 'stdio',
      allowed_extensions: ['id@example'],
    });
  });

  it('goes to the registry on Windows and to the Flatpak directory when Flatpak Firefox exists', () => {
    const win = nmManifestTargets({ platform: 'win32', home: 'C:\\Users\\u', env: {}, exists: () => false });
    expect(win).toEqual([expect.objectContaining({
      registryKey: WIN_REG_KEY,
      file: 'C:\\Users\\u\\.kitsune-mcp\\native-host\\kitsune_mcp.json',
    })]);

    const linux = nmManifestTargets({
      platform: 'linux', home: '/home/u', env: {}, exists: (p: string) => p === '/home/u/.var/app/org.mozilla.firefox',
    });
    expect(linux.map((t: { file: string }) => t.file)).toEqual([
      '/home/u/.mozilla/native-messaging-hosts/kitsune_mcp.json',
      '/home/u/.var/app/org.mozilla.firefox/.mozilla/native-messaging-hosts/kitsune_mcp.json',
    ]);
  });
});

describe('already registered? (paths are compared)', () => {
  const expected = buildManifest({ wrapperPath: 'C:\\Users\\u\\.kitsune-mcp\\native-host\\run-host.cmd', geckoId: 'id@example' });

  it('treats the same wrapper path (other case / slashes) as unchanged and another path as different', () => {
    const same = JSON.stringify({ ...expected, path: 'c:/users/u/.kitsune-mcp/native-host/run-host.cmd' });
    expect(manifestState(expected, same, 'win32').state).toBe('same');
    const other = JSON.stringify({ ...expected, path: 'D:\\old\\run-host.cmd' });
    expect(manifestState(expected, other, 'win32')).toEqual({ state: 'different', path: 'D:\\old\\run-host.cmd' });
  });

  it('flags a Claude Code entry that starts a bare "node"', () => {
    const ctx = { nodePath: '/usr/bin/node', serverEntry: '/r/packages/mcp-server/dist/index.js', platform: 'linux' };
    expect(claudeEntryState({ command: 'node', args: ['/r/packages/mcp-server/dist/index.js'] }, ctx)).toBe('stale-node');
    expect(claudeEntryState({ command: '/usr/bin/node', args: ['/r/packages/mcp-server/dist/index.js'] }, ctx)).toBe('same');
  });
});

describe('writeFileAtomic', () => {
  it('replaces the file and leaves no temporary file behind', () => {
    const target = path.join(tmp, 'kitsune_mcp.json');
    fs.writeFileSync(target, 'old');
    writeFileAtomic(target, 'new');
    expect(fs.readFileSync(target, 'utf8')).toBe('new');
    expect(fs.readdirSync(tmp)).toEqual(['kitsune_mcp.json']);
  });
});

describe('daemon authentication copy', () => {
  it('computes the same MACs as @kitsune-mcp/shared/node (auth.ts)', () => {
    const token = 'a'.repeat(64);
    expect(computeMac(token, 'health', 'b'.repeat(32))).toBe(serverAuth.computeMac(token, 'health', 'b'.repeat(32)));
  });
});

/** Stubs for everything outside the temp home. */
function stubDeps(home: string) {
  const out: string[] = [];
  const calls: string[][] = [];
  return {
    out,
    calls,
    deps: {
      home,
      env: { PATH: '' },
      out: (s: string) => out.push(s),
      err: (s: string) => out.push(s),
      isTTY: false,
      run: (file: string, args: string[]) => {
        calls.push([file, ...args]);
        return { status: 1, stdout: '', stderr: '', error: undefined };
      },
      httpGet: async () => null,
      kill: () => {
        throw new Error('must not kill in a dry run');
      },
      readProcVersion: () => '',
    },
  };
}

describe('dry run', () => {
  it('install plans the host files and registration without writing anything', async () => {
    const home = path.join(tmp, 'home');
    fs.mkdirSync(home);
    const { out, calls, deps } = stubDeps(home);
    expect(await runInstall(['--dry-run'], deps)).toBe(0);
    const text = out.join('');
    const nativeHostDir = path.join(home, '.kitsune-mcp', 'native-host');
    expect(text).toContain(`[dry-run] would create ${path.join(nativeHostDir, process.platform === 'win32' ? 'run-host.cmd' : 'run-host.sh')}`);
    if (process.platform === 'win32') expect(text).toContain(`[dry-run] would set ${WIN_REG_KEY}`);
    expect(fs.readdirSync(home)).toEqual([]);
    expect(calls.some((c) => c.includes('add'))).toBe(false);
  });

  it('uninstall plans the removal and keeps the files', async () => {
    const home = path.join(tmp, 'home');
    const nativeHostDir = path.join(home, '.kitsune-mcp', 'native-host');
    fs.mkdirSync(nativeHostDir, { recursive: true });
    fs.writeFileSync(path.join(nativeHostDir, 'run-host.cmd'), '');
    const { out, deps } = stubDeps(home);
    expect(await runUninstall(['--dry-run', '--purge'], deps)).toBe(0);
    const text = out.join('');
    expect(text).toContain(`[dry-run] would delete ${nativeHostDir}`);
    expect(text.indexOf('1. Removing the Firefox Native Messaging registration'))
      .toBeLessThan(text.indexOf('4. Stopping running processes'));
    expect(fs.existsSync(path.join(nativeHostDir, 'run-host.cmd'))).toBe(true);
  });
});
