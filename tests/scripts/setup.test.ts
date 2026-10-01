/**
 * scripts/install.mjs / scripts/uninstall.mjs and their helpers.
 *
 * Nothing here registers anything: the registry, processes, the network and
 * Claude Code are stubbed, and file-system work happens in a temp directory.
 */

import { spawn, spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as serverAuth from '@kitsune-mcp/shared/node';
import {
  AUTH_HEADER, CLAUDE_NAME, HOST_NAME, UsageError, WIN_REG_KEY, buildManifest, buildPosixWrapper,
  buildWindowsWrapper, buildWrapper, claudeConfigPath, claudeEntryState, classifyProcesses,
  commandInvocation, computeMac, dataPaths, findClaudeEntries, formatCommand, manifestState, nmManifestTargets,
  nodeVersionManager, parseArgs, parseInstallArgs, parsePsOutput, parseRegDefaultValue,
  parseTabOutput, parseUninstallArgs, serializeJson, shellQuote, signPost,
} from '../../scripts/lib/core.mjs';
import {
  defaultDeps, httpGet, listNodeProcesses, probeDaemon, removeTreeSafe, stopProcess, writeFileAtomic,
} from '../../scripts/lib/system.mjs';
import { manualForPlatform, manualMarkdown } from '../../scripts/lib/texts.mjs';
import { runInstall } from '../../scripts/install.mjs';
import { runUninstall } from '../../scripts/uninstall.mjs';
import { interpretCallResponse, truncate } from '../../scripts/e2e/smoke-core.mjs';

const isWin = process.platform === 'win32';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kitsune-setup-'));
});
afterEach(() => {
  // Windows: a file just written may still be open (AV scan, indexer) for a moment.
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

describe('parseArgs', () => {
  const spec = {
    flags: { on: ['mode', 'on'], off: ['mode', 'off'], v: ['verbose', true] },
    values: { name: 'name' },
  };
  const defaults = { mode: 'auto', verbose: false, name: undefined };

  it('accepts --x=v and --x v', () => {
    expect(parseArgs(['--name=a'], spec, defaults)).toMatchObject({ name: 'a' });
    expect(parseArgs(['--name', 'b'], spec, defaults)).toMatchObject({ name: 'b' });
    expect(parseArgs(['--name='], spec, defaults)).toMatchObject({ name: '' });
    expect(parseArgs(['--name', '--on'], spec, defaults)).toMatchObject({ name: '--on', mode: 'auto' });
  });

  it('keeps the defaults when nothing is given', () => {
    expect(parseArgs([], spec, defaults)).toEqual(defaults);
  });

  it('rejects a missing value, a value on a flag, and unknown or positional arguments', () => {
    expect(() => parseArgs(['--name'], spec, defaults)).toThrow(/--name needs a value/);
    expect(() => parseArgs(['--on=1'], spec, defaults)).toThrow(/--on does not take a value/);
    expect(() => parseArgs(['--nope'], spec, defaults)).toThrow(/unknown option: --nope/);
    expect(() => parseArgs(['file.txt'], spec, defaults)).toThrow(/unexpected argument: file\.txt/);
    expect(() => parseArgs(['-V'], spec, defaults)).toThrow(UsageError);
    expect(() => parseArgs(['-ab'], spec, defaults)).toThrow(UsageError);
    // a short name is only looked up in flags, never in values
    expect(() => parseArgs(['-n', 'x'], spec, defaults)).toThrow(/unknown option: -n/);
  });

  it('refuses two options that set the same key to different values, but repeats are fine', () => {
    expect(() => parseArgs(['--on', '--off'], spec, defaults)).toThrow(/--on and --off cannot be used together/);
    expect(() => parseArgs(['--name', 'a', '--name', 'b'], spec, defaults)).toThrow(/--name and --name cannot be used together/);
    expect(parseArgs(['--on', '--on'], spec, defaults)).toMatchObject({ mode: 'on' });
    expect(parseArgs(['--name', 'a', '--name=a'], spec, defaults)).toMatchObject({ name: 'a' });
  });
});

describe('parseInstallArgs', () => {
  it('reads flags and values', () => {
    const o = parseInstallArgs(['-n', '--register-claude', '--claude-scope=local', '--node', '/x/node']);
    expect(o).toMatchObject({ dryRun: true, registerClaude: true, claudeScope: 'local', node: '/x/node', yes: false });
  });

  it('has the documented defaults and short flags', () => {
    expect(parseInstallArgs([])).toEqual({
      dryRun: false, yes: false, help: false, manual: false,
      registerClaude: false, build: false, claudeScope: 'user', node: undefined,
    });
    expect(parseInstallArgs(['-n', '-y', '-h'])).toMatchObject({ dryRun: true, yes: true, help: true });
    expect(parseInstallArgs(['--dry-run', '--manual', '--build'])).toMatchObject({ dryRun: true, manual: true, build: true });
  });

  it('rejects unknown options and conflicting flags', () => {
    expect(() => parseInstallArgs(['--bogus'])).toThrow(UsageError);
    expect(() => parseInstallArgs(['--register-claude', '--no-register-claude'])).toThrow(/cannot be used together/);
    expect(() => parseInstallArgs(['--build', '--skip-build'])).toThrow(/cannot be used together/);
  });

  it('validates --claude-scope and --node', () => {
    for (const scope of ['user', 'local', 'project']) {
      expect(parseInstallArgs(['--claude-scope', scope])).toMatchObject({ claudeScope: scope });
    }
    expect(() => parseInstallArgs(['--claude-scope=global'])).toThrow(/--claude-scope must be one of user, local, project/);
    expect(() => parseInstallArgs(['--node='])).toThrow(/--node needs a path/);
    expect(() => parseInstallArgs(['--node'])).toThrow(/--node needs a value/);
  });
});

describe('parseUninstallArgs', () => {
  it('has the documented defaults', () => {
    expect(parseUninstallArgs([])).toMatchObject({
      dryRun: false, yes: false, purge: false, claude: 'ask', stop: true, grace: '5', graceMs: 5000,
    });
  });

  it('accepts the compatibility spellings', () => {
    expect(parseUninstallArgs(['--no-stop'])).toMatchObject({ stop: false });
    expect(parseUninstallArgs(['--no-stop-daemon'])).toMatchObject({ stop: false });
    expect(parseUninstallArgs(['--no-stop', '--no-stop-daemon'])).toMatchObject({ stop: false });
    expect(parseUninstallArgs(['--keep-claude'])).toMatchObject({ claude: 'keep' });
    expect(parseUninstallArgs(['--no-unregister-claude'])).toMatchObject({ claude: 'keep' });
    expect(parseUninstallArgs(['--unregister-claude'])).toMatchObject({ claude: 'remove' });
    expect(parseUninstallArgs(['--stop-daemon'])).toMatchObject({ stop: true });
  });

  it('refuses conflicting flags', () => {
    expect(() => parseUninstallArgs(['--unregister-claude', '--keep-claude'])).toThrow(/cannot be used together/);
    expect(() => parseUninstallArgs(['--stop-daemon', '--no-stop'])).toThrow(/cannot be used together/);
  });

  it('checks the --grace bounds and converts to milliseconds', () => {
    expect(parseUninstallArgs(['--grace', '0'])).toMatchObject({ graceMs: 0 });
    expect(parseUninstallArgs(['--grace', '60'])).toMatchObject({ graceMs: 60_000 });
    expect(parseUninstallArgs(['--grace=2.5'])).toMatchObject({ graceMs: 2500 });
    for (const bad of ['-1', '61', 'abc', 'Infinity', '60.1']) {
      expect(() => parseUninstallArgs([`--grace=${bad}`])).toThrow(/--grace must be a number of seconds between 0 and 60/);
    }
  });
});

// ---------------------------------------------------------------------------
// Manifest locations
// ---------------------------------------------------------------------------

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

describe('nmManifestTargets', () => {
  const never = () => false;
  const files = (t: { file: string }[]) => t.map((x) => x.file);
  const ids = (t: { id: string }[]) => t.map((x) => x.id);

  it('win32: one registry value and the manifest under ~/.kitsune-mcp', () => {
    const t = nmManifestTargets({ platform: 'win32', home: 'C:\\Users\\u', env: {}, exists: never });
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({
      id: 'windows',
      registryKey: 'HKCU\\Software\\Mozilla\\NativeMessagingHosts\\kitsune_mcp',
      file: dataPaths('win32', 'C:\\Users\\u').winManifestPath,
    });
    // `all` changes nothing on Windows: there is only one location.
    expect(nmManifestTargets({ platform: 'win32', home: 'C:\\Users\\u', env: {}, exists: () => true, all: true })).toEqual(t);
  });

  it('darwin: one directory for every edition, and no registry key', () => {
    const t = nmManifestTargets({ platform: 'darwin', home: '/Users/u', env: {}, exists: never, all: true });
    expect(files(t)).toEqual(['/Users/u/Library/Application Support/Mozilla/NativeMessagingHosts/kitsune_mcp.json']);
    expect(t[0].registryKey).toBeUndefined();
    expect(t[0].id).toBe('macos');
  });

  it('linux: only ~/.mozilla when nothing else is detected', () => {
    const t = nmManifestTargets({ platform: 'linux', home: '/home/u', env: {}, exists: never });
    expect(files(t)).toEqual(['/home/u/.mozilla/native-messaging-hosts/kitsune_mcp.json']);
  });

  it('linux: XDG uses $XDG_CONFIG_HOME when absolute and ~/.config otherwise', () => {
    const xdg = (env: Record<string, string>, present: string) =>
      files(nmManifestTargets({ platform: 'linux', home: '/home/u', env, exists: (p: string) => p === present }));

    expect(xdg({ XDG_CONFIG_HOME: '/custom/cfg' }, '/custom/cfg/mozilla'))
      .toContain('/custom/cfg/mozilla/native-messaging-hosts/kitsune_mcp.json');
    // relative value: ignored, ~/.config is used instead
    expect(xdg({ XDG_CONFIG_HOME: 'relative/cfg' }, '/home/u/.config/mozilla'))
      .toContain('/home/u/.config/mozilla/native-messaging-hosts/kitsune_mcp.json');
    expect(xdg({}, '/home/u/.config/mozilla'))
      .toContain('/home/u/.config/mozilla/native-messaging-hosts/kitsune_mcp.json');
    // the directory is not there: no XDG target
    expect(xdg({ XDG_CONFIG_HOME: '/custom/cfg' }, '/nowhere')).toHaveLength(1);
  });

  it('linux: Snap is added for ~/snap/firefox or /snap/firefox', () => {
    for (const present of ['/home/u/snap/firefox', '/snap/firefox']) {
      const t = nmManifestTargets({ platform: 'linux', home: '/home/u', env: {}, exists: (p: string) => p === present });
      expect(ids(t)).toEqual(['linux', 'snap']);
      expect(files(t)[1]).toBe('/home/u/snap/firefox/common/.mozilla/native-messaging-hosts/kitsune_mcp.json');
      expect(t[1].note).toMatch(/portal/);
    }
  });

  it('linux: Flatpak is added for the user data, the system install or the user install', () => {
    for (const present of [
      '/home/u/.var/app/org.mozilla.firefox',
      '/var/lib/flatpak/app/org.mozilla.firefox',
      '/home/u/.local/share/flatpak/app/org.mozilla.firefox',
    ]) {
      const t = nmManifestTargets({ platform: 'linux', home: '/home/u', env: {}, exists: (p: string) => p === present });
      expect(ids(t)).toEqual(['linux', 'flatpak:org.mozilla.firefox']);
      // the manifest always goes into the per-user Flatpak data directory
      expect(files(t)[1]).toBe('/home/u/.var/app/org.mozilla.firefox/.mozilla/native-messaging-hosts/kitsune_mcp.json');
    }
  });

  it('linux: `all` returns every location without probing the file system (uninstall)', () => {
    const t = nmManifestTargets({ platform: 'linux', home: '/home/u', env: {}, exists: never, all: true });
    expect(ids(t)).toEqual(['linux', 'linux-xdg', 'snap', 'flatpak:org.mozilla.firefox']);
    expect(files(t)).toEqual([
      '/home/u/.mozilla/native-messaging-hosts/kitsune_mcp.json',
      '/home/u/.config/mozilla/native-messaging-hosts/kitsune_mcp.json',
      '/home/u/snap/firefox/common/.mozilla/native-messaging-hosts/kitsune_mcp.json',
      '/home/u/.var/app/org.mozilla.firefox/.mozilla/native-messaging-hosts/kitsune_mcp.json',
    ]);
    // `all` honours $XDG_CONFIG_HOME too
    const xdg = nmManifestTargets({ platform: 'linux', home: '/home/u', env: { XDG_CONFIG_HOME: '/cfg' }, exists: never, all: true });
    expect(files(xdg)[1]).toBe('/cfg/mozilla/native-messaging-hosts/kitsune_mcp.json');
  });

  it('names every manifest file kitsune_mcp.json', () => {
    for (const platform of ['win32', 'darwin', 'linux']) {
      const home = platform === 'win32' ? 'C:\\Users\\u' : '/home/u';
      for (const t of nmManifestTargets({ platform, home, env: {}, exists: never, all: true })) {
        expect(path.basename(t.file.replace(/\\/g, '/'))).toBe(`${HOST_NAME}.json`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Generated wrappers
// ---------------------------------------------------------------------------

describe('buildWindowsWrapper', () => {
  const base = {
    nativeHostPkg: 'C:\\repo\\packages\\native-host',
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    hostEntry: 'C:\\repo\\packages\\native-host\\dist\\index.js',
  };

  it('uses CRLF, starts with @echo off and ends with a newline', () => {
    const w = buildWindowsWrapper(base);
    expect(w.startsWith('@echo off\r\n')).toBe(true);
    expect(w.endsWith('\r\n')).toBe(true);
    expect(w.split('\n').every((l: string, i: number, a: string[]) => i === a.length - 1 || l.endsWith('\r'))).toBe(true);
  });

  it('escapes % so cmd.exe does not expand a variable in a path', () => {
    const w = buildWindowsWrapper({ ...base, nativeHostPkg: 'C:\\100%%sure\\pkg' });
    expect(w).toContain('cd /d "C:\\100%%%%sure\\pkg"');
    expect(w).not.toMatch(/"C:\\100%sure/);
    // the %* and %errorlevel% the script needs are written by the template, not escaped away
    expect(w).toContain('%*');
    expect(w).toContain('exit /b %errorlevel%');
  });

  it('uses goto instead of an if block so "Program Files (x86)" cannot close it early', () => {
    const w = buildWindowsWrapper({ ...base, nodePath: 'C:\\Program Files (x86)\\nodejs\\node.exe' });
    expect(w).toContain('if not exist "C:\\Program Files (x86)\\nodejs\\node.exe" goto pathnode');
    expect(w).toContain(':pathnode');
    expect(w).not.toContain('(\r\n');
    // the PATH fallback is there for when the pinned node disappears
    expect(w).toContain(`node "${base.hostEntry}" %*`);
  });

  it('switches to UTF-8 only when a path is not ASCII', () => {
    expect(buildWindowsWrapper(base)).not.toContain('chcp');
    const w = buildWindowsWrapper({ ...base, nativeHostPkg: 'C:\\ユーザー\\pkg' });
    const lines = w.split('\r\n');
    expect(lines[0]).toBe('@echo off');
    expect(lines[1]).toBe('chcp 65001 >nul');
    // the chcp line comes before any line holding the non-ASCII path
    expect(lines.findIndex((l: string) => l.includes('ユーザー'))).toBeGreaterThan(1);
    expect(w).toContain('>nul'); // nothing reaches stdout: it is the Native Messaging channel
  });

  it('is what buildWrapper returns for win32', () => {
    expect(buildWrapper('win32', base)).toBe(buildWindowsWrapper(base));
  });
});

describe('buildPosixWrapper', () => {
  const base = {
    nativeHostPkg: '/repo/packages/native-host',
    nodePath: '/usr/bin/node',
    hostEntry: '/repo/packages/native-host/dist/index.js',
  };

  it("quotes a single quote as '\\''", () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    expect(shellQuote('')).toBe("''");
    expect(shellQuote('/plain/path')).toBe("'/plain/path'");
    const w = buildPosixWrapper({ ...base, nativeHostPkg: "/home/o'brien/pkg" });
    expect(w).toContain("cd '/home/o'\\''brien/pkg' || exit 1");
  });

  it('is a /bin/sh script that execs node with the same fallbacks', () => {
    const w = buildPosixWrapper(base);
    expect(w.split('\n')[0]).toBe('#!/bin/sh');
    expect(w).toContain(`if [ -x '/usr/bin/node' ]; then exec '/usr/bin/node' '/repo/packages/native-host/dist/index.js' "$@"; fi`);
    expect(w).toContain(`exec node '/repo/packages/native-host/dist/index.js' "$@"`);
    expect(w).not.toContain('\r');
    expect(w.endsWith('\n')).toBe(true);
  });

  it('is what buildWrapper returns for every other platform', () => {
    expect(buildWrapper('linux', base)).toBe(buildPosixWrapper(base));
    expect(buildWrapper('darwin', base)).toBe(buildPosixWrapper(base));
  });
});

// ---------------------------------------------------------------------------
// Registry parsing
// ---------------------------------------------------------------------------

describe('parseRegDefaultValue', () => {
  const answer = (label: string, type: string, value?: string) =>
    ['', 'HKEY_CURRENT_USER\\Software\\Mozilla\\NativeMessagingHosts\\kitsune_mcp',
      `    ${label}    ${type}${value === undefined ? '' : `    ${value}`}`, ''].join('\r\n');

  it('reads the value whatever the "(Default)" label is called', () => {
    for (const label of ['(Default)', '(既定)', '(标准)', '(Standard)', '(Par défaut)']) {
      expect(parseRegDefaultValue(answer(label, 'REG_SZ', 'C:\\Users\\u\\.kitsune-mcp\\native-host\\kitsune_mcp.json')))
        .toBe('C:\\Users\\u\\.kitsune-mcp\\native-host\\kitsune_mcp.json');
    }
  });

  it('reads REG_EXPAND_SZ as well', () => {
    expect(parseRegDefaultValue(answer('(Default)', 'REG_EXPAND_SZ', '%USERPROFILE%\\.kitsune-mcp\\native-host\\kitsune_mcp.json')))
      .toBe('%USERPROFILE%\\.kitsune-mcp\\native-host\\kitsune_mcp.json');
  });

  it('returns "" for a value that is set but empty', () => {
    expect(parseRegDefaultValue(answer('(Default)', 'REG_SZ'))).toBe('');
    expect(parseRegDefaultValue(answer('(Default)', 'REG_SZ', '   '))).toBe('');
  });

  it('keeps spaces inside the value', () => {
    expect(parseRegDefaultValue(answer('(Default)', 'REG_SZ', 'C:\\Program Files\\x\\kitsune_mcp.json')))
      .toBe('C:\\Program Files\\x\\kitsune_mcp.json');
  });

  it('returns null when the key is missing or the answer holds no value line', () => {
    // reg.exe writes "ERROR: The system was unable to find the specified registry key" to stderr
    // and nothing to stdout; regQueryDefault also turns a non-zero exit into null.
    expect(parseRegDefaultValue('')).toBeNull();
    expect(parseRegDefaultValue('ERROR: The system was unable to find the specified registry key or value.')).toBeNull();
    expect(parseRegDefaultValue('HKEY_CURRENT_USER\\Software\\Mozilla\r\n')).toBeNull();
    // only the default value has a type on the same line; a sub key alone is not one
    expect(parseRegDefaultValue('HKEY_CURRENT_USER\\Software\\Mozilla\\NativeMessagingHosts\\kitsune_mcp\r\n')).toBeNull();
  });

  it('takes the first value line (LF line endings too)', () => {
    const text = 'key\n    (Default)    REG_SZ    first\n    other    REG_SZ    second\n';
    expect(parseRegDefaultValue(text)).toBe('first');
  });
});

// ---------------------------------------------------------------------------
// Claude Code registration
// ---------------------------------------------------------------------------

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

describe('claudeConfigPath', () => {
  it('is ~/.claude.json unless CLAUDE_CONFIG_DIR says otherwise', () => {
    expect(claudeConfigPath('linux', '/home/u', {})).toBe('/home/u/.claude.json');
    expect(claudeConfigPath('win32', 'C:\\Users\\u', {})).toBe('C:\\Users\\u\\.claude.json');
    expect(claudeConfigPath('linux', '/home/u', { CLAUDE_CONFIG_DIR: '/cfg/claude' })).toBe('/cfg/claude/.claude.json');
    expect(claudeConfigPath('win32', 'C:\\Users\\u', { CLAUDE_CONFIG_DIR: 'D:\\cfg' })).toBe('D:\\cfg\\.claude.json');
  });

  it('is read by the installer from the isolated home of this test run', () => {
    // tests/setup/isolate-home.ts points os.homedir() at a temporary directory.
    const deps = defaultDeps();
    expect(deps.home).toBe(os.homedir());
    expect(deps.home).not.toBe(path.join(os.tmpdir(), '..'));
    expect(claudeConfigPath(process.platform, deps.home, {})).toBe(path.join(deps.home, '.claude.json'));
    expect(fs.existsSync(claudeConfigPath(process.platform, deps.home, {}))).toBe(false);
  });
});

describe('findClaudeEntries', () => {
  const entry = (id: string) => ({ command: '/usr/bin/node', args: [`/r${id}/packages/mcp-server/dist/index.js`] });

  it('finds the user scope, the local scope of this repository and the project scope', () => {
    const { found, otherLocal } = findClaudeEntries({
      config: {
        mcpServers: { [CLAUDE_NAME]: entry('u') },
        projects: { '/r': { mcpServers: { [CLAUDE_NAME]: entry('l') } } },
      },
      projectMcp: { mcpServers: { [CLAUDE_NAME]: entry('p') } },
      repoRoot: '/r',
      platform: 'linux',
    });
    expect(found.map((f: { scope: string }) => f.scope)).toEqual(['user', 'local', 'project']);
    expect(found[1].entry).toEqual(entry('l'));
    expect(otherLocal).toEqual([]);
  });

  it('lists local registrations of other directories separately', () => {
    const { found, otherLocal } = findClaudeEntries({
      config: {
        projects: {
          '/r': { mcpServers: { [CLAUDE_NAME]: entry('l') } },
          '/other/clone': { mcpServers: { [CLAUDE_NAME]: entry('o') } },
          '/third': { mcpServers: { [CLAUDE_NAME]: entry('t') } },
          '/no-kitsune': { mcpServers: { something: {} } },
        },
      },
      projectMcp: null,
      repoRoot: '/r',
      platform: 'linux',
    });
    expect(found.map((f: { scope: string }) => f.scope)).toEqual(['local']);
    expect(otherLocal).toEqual(['/other/clone', '/third']);
  });

  it('matches a Windows project key whatever the slashes and the case are', () => {
    for (const key of [
      'C:\\repo\\Kitsune',
      'C:/repo/Kitsune',
      'c:\\REPO\\kitsune',
      'C:\\repo\\Kitsune\\',
      'C:\\repo\\sub\\..\\Kitsune',
    ]) {
      const { found, otherLocal } = findClaudeEntries({
        config: { projects: { [key]: { mcpServers: { [CLAUDE_NAME]: entry('l') } } } },
        projectMcp: null,
        repoRoot: 'C:\\repo\\kitsune',
        platform: 'win32',
      });
      expect([key, found.map((f: { scope: string }) => f.scope)]).toEqual([key, ['local']]);
      expect(otherLocal).toEqual([]);
    }
    // on linux the case matters
    const linux = findClaudeEntries({
      config: { projects: { '/repo/Kitsune': { mcpServers: { [CLAUDE_NAME]: entry('l') } } } },
      projectMcp: null,
      repoRoot: '/repo/kitsune',
      platform: 'linux',
    });
    expect(linux.found).toEqual([]);
    expect(linux.otherLocal).toEqual(['/repo/Kitsune']);
  });

  it('finds nothing in an empty, broken or unrelated configuration', () => {
    const empty = { found: [], otherLocal: [] };
    expect(findClaudeEntries({ config: null, projectMcp: null, repoRoot: '/r', platform: 'linux' })).toEqual(empty);
    expect(findClaudeEntries({ config: 'nonsense', projectMcp: 7, repoRoot: '/r', platform: 'linux' })).toEqual(empty);
    expect(findClaudeEntries({ config: { mcpServers: null }, projectMcp: {}, repoRoot: '/r', platform: 'linux' })).toEqual(empty);
    // a non-object entry is not a registration
    expect(findClaudeEntries({
      config: { mcpServers: { [CLAUDE_NAME]: 'node index.js' } }, projectMcp: null, repoRoot: '/r', platform: 'linux',
    })).toEqual(empty);
    expect(findClaudeEntries({
      config: { mcpServers: { 'other-server': { command: 'node' } } }, projectMcp: null, repoRoot: '/r', platform: 'linux',
    })).toEqual(empty);
  });
});

describe('commandInvocation', () => {
  it('starts a .cmd / .bat shim through cmd.exe with one quoted line', () => {
    const inv = commandInvocation('C:\\npm\\claude.cmd', ['mcp', 'add', '--scope', 'user'], 'win32', {});
    expect(inv).toEqual({
      file: 'cmd.exe',
      args: ['/d', '/s', '/c', '""C:\\npm\\claude.cmd" "mcp" "add" "--scope" "user""'],
      verbatim: true,
    });
    expect(commandInvocation('C:\\x\\claude.BAT', [], 'win32', {}).file).toBe('cmd.exe');
    expect(commandInvocation('C:\\x\\claude.cmd', [], 'win32', { ComSpec: 'C:\\Windows\\System32\\cmd.exe' }).file)
      .toBe('C:\\Windows\\System32\\cmd.exe');
  });

  it('starts anything else directly', () => {
    expect(commandInvocation('C:\\node\\node.exe', ['a'], 'win32', {})).toEqual({
      file: 'C:\\node\\node.exe', args: ['a'], verbatim: false,
    });
    // .cmd is a Windows notion only
    expect(commandInvocation('/opt/x/claude.cmd', ['a'], 'linux', {})).toEqual({
      file: '/opt/x/claude.cmd', args: ['a'], verbatim: false,
    });
  });

  it('refuses an argument with a quote or a newline (it would break the cmd.exe line)', () => {
    for (const bad of ['a"b', 'a\rb', 'a\nb']) {
      expect(() => commandInvocation('C:\\npm\\claude.cmd', ['mcp', bad], 'win32', {}))
        .toThrow(/cannot pass an argument with a quote/);
    }
    expect(() => commandInvocation('C:\\npm\\cla"ude.cmd', [], 'win32', {}))
      .toThrow(/cannot pass an argument with a quote/);
    // without the shim the argument is passed as-is
    expect(commandInvocation('C:\\node\\node.exe', ['a"b'], 'win32', {}).args).toEqual(['a"b']);
  });

  it('refuses an argument with a % (cmd /c expands %NAME% even inside quotes)', () => {
    expect(() => commandInvocation('C:\\npm\\claude.cmd', ['mcp', 'a%OS%b'], 'win32', {}))
      .toThrow(/cannot pass an argument with a %/);
    expect(() => commandInvocation('C:\\100%\\claude.cmd', [], 'win32', {}))
      .toThrow(/cannot pass an argument with a %/);
    expect(commandInvocation('C:\\node\\node.exe', ['a%OS%b'], 'win32', {}).args).toEqual(['a%OS%b']);
    // and a displayed command never shows a % unquoted
    expect(formatCommand('claude', ['a%OS%b'], 'win32')).toBe('claude "a%OS%b"');
    expect(formatCommand('claude', ['a%b'], 'linux')).toBe("claude 'a%b'");
  });
});

describe('manual steps (--help / --manual)', () => {
  it("quotes this machine's paths for the shell, even with a space and a single quote", () => {
    const dataDir = "/home/my user/it's/.kitsune-mcp";
    const q = "'/home/my user/it'\\''s/.kitsune-mcp'";
    const v = { repoRoot: '/src/Kitsune MCP', nodePath: '/opt/node 20/bin/node', dataDir };
    const uninstall = manualForPlatform('uninstall', 'linux', v);
    expect(uninstall).toContain(`rm -rf ${q}/native-host\``);
    expect(uninstall).toContain(`rm -rf ${q}\` (API token`);
    expect(uninstall).toContain("'/opt/node 20/bin/node' '/src/Kitsune MCP'/packages/mcp-server/dist/index.js --stop-daemon");
    const install = manualForPlatform('install', 'darwin', v);
    expect(install).toContain(`mkdir -p ${q}/native-host && chmod 700 ${q} ${q}/native-host`);
    expect(install).toContain("cd '/src/Kitsune MCP'/packages/native-host || exit 1");
    // the real path never appears unquoted
    expect(uninstall + install).not.toContain(` ${dataDir}`);
  });

  it('uses "$HOME/.kitsune-mcp" as the placeholder and the configured port', () => {
    const md = manualMarkdown('uninstall');
    expect(md).toContain('rm -rf "$HOME/.kitsune-mcp"/native-host');
    expect(md).not.toContain('~/.kitsune-mcp/native-host`');
    expect(md).toContain('lsof -tiTCP:8765');
    const v = { repoRoot: '/r', nodePath: '/n', dataDir: '/d', port: 9999 };
    expect(manualForPlatform('uninstall', 'linux', v)).toContain('lsof -tiTCP:9999');
    expect(manualForPlatform('uninstall', 'win32', v)).toContain('findstr :9999');
  });
});

// ---------------------------------------------------------------------------
// Node.js version managers
// ---------------------------------------------------------------------------

describe('nodeVersionManager', () => {
  it('recognises every manager whose path depends on the selected version', () => {
    const cases: [string, string][] = [
      ['/home/u/.nvm/versions/node/v20.11.0/bin/node', 'nvm'],
      ['C:\\Users\\u\\AppData\\Roaming\\nvm\\v20.11.0\\node.exe', 'nvm-windows'],
      ['/home/u/.volta/tools/image/node/20.11.0/bin/node', 'Volta'],
      ['C:\\Users\\u\\AppData\\Local\\Volta\\tools\\image\\node\\20.11.0\\node.exe', 'Volta'],
      ['/tmp/fnm_multishells/12345_1700000000/bin/node', 'fnm'],
      ['/home/u/.fnm/node-versions/v20.11.0/installation/bin/node', 'fnm'],
      ['C:\\Users\\u\\AppData\\Roaming\\fnm\\node-versions\\v20.11.0\\installation\\node.exe', 'fnm'],
      ['/home/u/.asdf/installs/nodejs/20.11.0/bin/node', 'asdf'],
      ['/home/u/.local/share/mise/installs/node/20.11.0/bin/node', 'mise'],
      ['/home/u/.nodenv/versions/20.11.0/bin/node', 'nodenv'],
      ['/usr/local/n/versions/node/20.11.0/bin/node', 'n'],
      ['/home/u/.nodebrew/node/v20.11.0/bin/node', 'nodebrew'],
      ['C:\\Program Files (x86)\\Nodist\\v-x64\\20.11.0\\node.exe', 'nodist'],
      ['C:\\Users\\u\\scoop\\apps\\nodejs\\20.11.0\\node.exe', 'Scoop (versioned directory)'],
      ['C:\\Users\\u\\scoop\\apps\\nodejs-lts\\20.11.0\\node.exe', 'Scoop (versioned directory)'],
      ['/opt/homebrew/Cellar/node/22.1.0/bin/node', 'Homebrew (versioned Cellar directory)'],
      ['/usr/local/Cellar/node@20/20.11.0/bin/node', 'Homebrew (versioned Cellar directory)'],
    ];
    for (const [p, name] of cases) expect([p, nodeVersionManager(p)]).toEqual([p, name]);
  });

  it('does not flag the stable paths those managers also offer', () => {
    const stable = [
      'C:\\Users\\u\\scoop\\apps\\nodejs\\current\\node.exe',
      'C:\\Users\\u\\scoop\\shims\\node.exe',
      '/opt/homebrew/opt/node/bin/node',
      '/opt/homebrew/opt/node@20/bin/node',
      '/usr/local/opt/node/bin/node',
      '/usr/bin/node',
      '/usr/local/bin/node',
      'C:\\Program Files\\nodejs\\node.exe',
      'C:\\Program Files (x86)\\nodejs\\node.exe',
      '/snap/bin/node',
    ];
    for (const p of stable) expect([p, nodeVersionManager(p)]).toEqual([p, null]);
  });

  it('ignores the case and the slash direction', () => {
    expect(nodeVersionManager('C:/Users/u/.NVM/versions/node/v20.11.0/bin/node.exe')).toBe('nvm');
    expect(nodeVersionManager('/home/u/.NodeNv/versions/20/bin/node')).toBe('nodenv');
    expect(nodeVersionManager(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------

describe('process list parsing', () => {
  it('parsePsOutput reads "<pid> <args>" and keeps the spaces of the command line', () => {
    const text = [
      '  1234 /usr/bin/node /r/packages/mcp-server/dist/index.js --daemon',
      ' 5678 /usr/bin/node /r/packages/native-host/dist/index.js',
      '',
      'not a process line',
      '  91011  node  with   doubled   spaces',
    ].join('\n');
    expect(parsePsOutput(text)).toEqual([
      { pid: 1234, cmd: '/usr/bin/node /r/packages/mcp-server/dist/index.js --daemon' },
      { pid: 5678, cmd: '/usr/bin/node /r/packages/native-host/dist/index.js' },
      { pid: 91011, cmd: 'node  with   doubled   spaces' },
    ]);
    expect(parsePsOutput('')).toEqual([]);
  });

  it('parseTabOutput reads "<pid>\\t<command line>" (CRLF too)', () => {
    const text = '1234\t"C:\\node\\node.exe" "C:\\r\\dist\\index.js"\r\n5678\t\r\nheader line\r\n';
    expect(parseTabOutput(text)).toEqual([
      { pid: 1234, cmd: '"C:\\node\\node.exe" "C:\\r\\dist\\index.js"' },
      { pid: 5678, cmd: '' },
    ]);
  });
});

describe('classifyProcesses', () => {
  const ctx = {
    hostEntry: '/r/packages/native-host/dist/index.js',
    serverEntry: '/r/packages/mcp-server/dist/index.js',
    platform: 'linux',
    selfPid: 999,
  };
  const list = [
    { pid: 1, cmd: 'node /r/packages/native-host/dist/index.js' },
    { pid: 2, cmd: 'node /r/packages/mcp-server/dist/index.js --daemon' },
    { pid: 3, cmd: 'node /r/packages/mcp-server/dist/index.js' },
    { pid: 4, cmd: 'node /other/clone/packages/mcp-server/dist/index.js --daemon' },
    { pid: 5, cmd: 'node /other/clone/packages/native-host/dist/index.js' },
    { pid: 6, cmd: 'node /somewhere/unrelated/server.js' },
    { pid: 999, cmd: 'node /r/packages/mcp-server/dist/index.js --daemon' },
  ];

  it('sorts hosts, daemons, relays and other checkouts, and skips its own pid', () => {
    const c = classifyProcesses(list, ctx);
    expect(c.hosts.map((x: { pid: number }) => x.pid)).toEqual([1]);
    expect(c.daemons.map((x: { pid: number }) => x.pid)).toEqual([2]);
    expect(c.relays.map((x: { pid: number }) => x.pid)).toEqual([3]);
    expect(c.others.map((x: { pid: number }) => x.pid)).toEqual([4, 5]);
  });

  it('only treats "--daemon" as its own argument as the daemon', () => {
    const c = classifyProcesses([
      { pid: 1, cmd: 'node /r/packages/mcp-server/dist/index.js --daemon' },
      { pid: 2, cmd: 'node /r/packages/mcp-server/dist/index.js --daemonize' },
      { pid: 3, cmd: 'node /r/packages/mcp-server/dist/index.js --daemon --verbose' },
      { pid: 4, cmd: 'node /r/packages/mcp-server/dist/index.js --no-daemon' },
    ], ctx);
    expect(c.daemons.map((x: { pid: number }) => x.pid)).toEqual([1, 3]);
    expect(c.relays.map((x: { pid: number }) => x.pid)).toEqual([2, 4]);
  });

  it('ignores case and slash direction on Windows but not on linux', () => {
    const win = {
      hostEntry: 'C:\\Repo\\packages\\native-host\\dist\\index.js',
      serverEntry: 'C:\\Repo\\packages\\mcp-server\\dist\\index.js',
      platform: 'win32',
      selfPid: 0,
    };
    const c = classifyProcesses([
      { pid: 1, cmd: '"C:\\node.exe" "c:/repo/packages/native-host/dist/index.js"' },
      { pid: 2, cmd: '"C:\\node.exe" "C:\\REPO\\packages\\mcp-server\\dist\\index.js" --daemon' },
    ], win);
    expect(c.hosts.map((x: { pid: number }) => x.pid)).toEqual([1]);
    expect(c.daemons.map((x: { pid: number }) => x.pid)).toEqual([2]);

    // same input classified as linux: the case difference makes them foreign checkouts
    const asLinux = classifyProcesses([
      { pid: 1, cmd: 'node /Repo/packages/native-host/dist/index.js' },
    ], { ...ctx, hostEntry: '/repo/packages/native-host/dist/index.js' });
    expect(asLinux.hosts).toEqual([]);
    expect(asLinux.others.map((x: { pid: number }) => x.pid)).toEqual([1]);
  });

  it('returns four empty lists for an empty process list', () => {
    expect(classifyProcesses([], ctx)).toEqual({ hosts: [], daemons: [], relays: [], others: [] });
  });
});

describe('listNodeProcesses', () => {
  const noFs = { writeFileSync: () => {}, unlinkSync: () => {} };

  it('unix: runs ps and parses it, and returns null when ps fails', () => {
    const calls: string[][] = [];
    const deps = (result: object) => ({
      platform: 'linux',
      fs: noFs,
      run: (file: string, args: string[]) => {
        calls.push([file, ...args]);
        return { status: 0, stdout: '', stderr: '', error: undefined, ...result };
      },
    });
    expect(listNodeProcesses(deps({ stdout: ' 42 node /r/dist/index.js\n' })))
      .toEqual([{ pid: 42, cmd: 'node /r/dist/index.js' }]);
    expect(calls[0]).toEqual(['ps', '-A', '-ww', '-o', 'pid=', '-o', 'args=']);
    expect(listNodeProcesses(deps({ status: 1 }))).toBeNull();
    expect(listNodeProcesses(deps({ error: new Error('ENOENT') }))).toBeNull();
  });

  it('win32: reads the UTF-16 output of the cscript WMI query', () => {
    const calls: string[][] = [];
    const out = listNodeProcesses({
      platform: 'win32',
      fs: noFs,
      run: (file: string, args: string[]) => {
        calls.push([file, ...args]);
        return {
          status: 0,
          stdout: Buffer.from('1234\t"C:\\node.exe" "C:\\r\\dist\\index.js"\r\n', 'utf16le'),
          stderr: '',
          error: undefined,
        };
      },
    });
    expect(out).toEqual([{ pid: 1234, cmd: '"C:\\node.exe" "C:\\r\\dist\\index.js"' }]);
    expect(calls[0][0]).toBe('cscript.exe');
    expect(calls[0]).toContain('//E:jscript');
    expect(calls).toHaveLength(1); // no wmic fallback needed
  });

  it('win32: falls back to the wmic CSV output, and returns null when that fails too', () => {
    const run = (result: object) => {
      const calls: string[][] = [];
      const deps = {
        platform: 'win32',
        fs: noFs,
        run: (file: string, args: string[]) => {
          calls.push([file, ...args]);
          if (file === 'cscript.exe') return { status: 1, stdout: Buffer.alloc(0), stderr: '', error: undefined };
          return { status: 0, stdout: '', stderr: '', error: undefined, ...result };
        },
      };
      return { out: listNodeProcesses(deps), calls };
    };

    const csv = [
      'Node,CommandLine,ProcessId',
      'HOST1,"C:\\node.exe" "C:\\r\\packages\\mcp-server\\dist\\index.js" --daemon,2345',
      'HOST1,,6789', // a process whose command line WMI does not show
      '',
    ].join('\r\n');
    const ok = run({ stdout: csv });
    expect(ok.out).toEqual([
      { pid: 2345, cmd: '"C:\\node.exe" "C:\\r\\packages\\mcp-server\\dist\\index.js" --daemon' },
      { pid: 6789, cmd: '' },
    ]);
    expect(ok.calls[1][0]).toBe('wmic.exe');
    expect(ok.calls[1]).toContain('/format:csv');

    expect(run({ status: 1 }).out).toBeNull();
    expect(run({ error: new Error('ENOENT') }).out).toBeNull();
  });
});

describe('stopProcess', () => {
  /** A process that is alive until `kill` is told to stop it. */
  function fakeProcess(opts: { alive?: boolean; diesOn?: string | null; throwOn?: Record<string, string> } = {}) {
    const state = { alive: opts.alive ?? true, signals: [] as string[], sleeps: 0 };
    const deps = {
      isAlive: () => state.alive,
      kill: (_pid: number, signal: string) => {
        state.signals.push(signal);
        const code = opts.throwOn?.[signal];
        if (code) {
          const err: NodeJS.ErrnoException = new Error(code);
          err.code = code;
          throw err;
        }
        if (opts.diesOn === signal) state.alive = false;
      },
      sleep: async () => {
        state.sleeps++;
      },
    };
    return { state, deps };
  }

  it('returns "gone" without signalling a process that is not there any more', async () => {
    const { state, deps } = fakeProcess({ alive: false });
    expect(await stopProcess(deps, 4242, 5000)).toBe('gone');
    expect(state.signals).toEqual([]);
  });

  it('returns "stopped" when SIGTERM is honoured', async () => {
    const { state, deps } = fakeProcess({ diesOn: 'SIGTERM' });
    expect(await stopProcess(deps, 4242, 5000)).toBe('stopped');
    expect(state.signals).toEqual(['SIGTERM']);
  });

  it('sends SIGKILL after the grace period', async () => {
    const { state, deps } = fakeProcess({ diesOn: 'SIGKILL' });
    expect(await stopProcess(deps, 4242, 500)).toBe('killed');
    expect(state.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(state.sleeps).toBe(500 / 100); // the grace period is waited out in 100 ms steps
  });

  it('does not wait at all with --grace 0', async () => {
    const { state, deps } = fakeProcess({ diesOn: 'SIGKILL' });
    expect(await stopProcess(deps, 4242, 0)).toBe('killed');
    expect(state.sleeps).toBe(0);
    expect(state.signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('treats ESRCH as the process having gone away', async () => {
    const term = fakeProcess({ throwOn: { SIGTERM: 'ESRCH' } });
    expect(await stopProcess(term.deps, 4242, 500)).toBe('gone');

    const kill = fakeProcess({ throwOn: { SIGKILL: 'ESRCH' } });
    expect(await stopProcess(kill.deps, 4242, 200)).toBe('stopped');
    expect(kill.state.signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('reports a failure when the signal is refused (EPERM) or the process survives SIGKILL', async () => {
    const perm = fakeProcess({ throwOn: { SIGTERM: 'EPERM' } });
    expect(await stopProcess(perm.deps, 4242, 500)).toBe('failed');

    const permKill = fakeProcess({ throwOn: { SIGKILL: 'EPERM' } });
    expect(await stopProcess(permKill.deps, 4242, 200)).toBe('failed');

    const survivor = fakeProcess({ diesOn: null });
    expect(await stopProcess(survivor.deps, 4242, 200)).toBe('failed');
    expect(survivor.state.signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('stops a real child process with the real dependencies', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    try {
      await new Promise<void>((resolve) => child.once('spawn', () => resolve()));
      const deps = defaultDeps();
      expect(deps.isAlive(child.pid)).toBe(true);
      expect(await stopProcess(deps, child.pid, 5000)).toBe('stopped');
      expect(deps.isAlive(child.pid)).toBe(false);
    } finally {
      child.kill('SIGKILL');
    }
  }, 20_000);

  it('isAlive answers for a live and for an exited process', () => {
    const deps = defaultDeps();
    expect(deps.isAlive(process.pid)).toBe(true);
    const gone = spawnSync(process.execPath, ['-e', '0']);
    expect(deps.isAlive(gone.pid)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Daemon probe
// ---------------------------------------------------------------------------

function sha256Hex(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

describe('probeDaemon', () => {
  const token = 'c'.repeat(64);
  const deps = { httpGet };
  let server: http.Server | undefined;
  let endpoint: { host: string; port: number };

  /** A loopback HTTP server standing in for the daemon. No real daemon is started. */
  async function serve(handler: http.RequestListener): Promise<void> {
    server = http.createServer(handler);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
    endpoint = { host: '127.0.0.1', port: (server!.address() as { port: number }).port };
  }

  /** A daemon-shaped server; `tweak` breaks one part of the answer. */
  async function serveDaemon(tweak: { proof?: string | null; pid?: unknown; signature?: string | null } = {}) {
    await serve((req, res) => {
      if (req.url === '/health') {
        const nonce = String(req.headers[AUTH_HEADER.nonce] ?? '');
        const body: Record<string, unknown> = { service: 'kitsune-mcp', version: '9.9.9', browsers_connected: 1 };
        if (tweak.proof !== null) body.proof = tweak.proof ?? computeMac(token, 'health', nonce);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
        return;
      }
      if (req.url === '/daemon/info') {
        const nonce = String(req.headers[AUTH_HEADER.nonce] ?? '');
        const body = JSON.stringify({ pid: 'pid' in tweak ? tweak.pid : 4242 });
        const sig = 'signature' in tweak
          ? tweak.signature
          : computeMac(token, 'http-response', nonce, '200', sha256Hex(body));
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (sig !== null) headers[AUTH_HEADER.signature] = String(sig);
        res.writeHead(200, headers);
        res.end(body);
        return;
      }
      res.writeHead(404).end();
    });
  }

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  it('kind "none" when nothing listens on the port', async () => {
    await serve((_req, res) => res.end());
    const closed = endpoint;
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    expect(await probeDaemon(deps, closed, token)).toEqual({ kind: 'none' });
  });

  it('kind "foreign" for a server that is not a KitsuneMCP daemon', async () => {
    await serve((_req, res) => res.end('<html>hello</html>'));
    expect(await probeDaemon(deps, endpoint, token)).toEqual({ kind: 'foreign' });
  });

  it('kind "foreign" for JSON with another service name or a non-200 status', async () => {
    await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ service: 'something-else' }));
    });
    expect(await probeDaemon(deps, endpoint, token)).toEqual({ kind: 'foreign' });
    await new Promise<void>((resolve) => server!.close(() => resolve()));

    await serve((_req, res) => {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ service: 'kitsune-mcp' }));
    });
    expect(await probeDaemon(deps, endpoint, token)).toEqual({ kind: 'foreign' });
  });

  it('unverified when no token is known: /daemon/info is never asked', async () => {
    const urls: string[] = [];
    await serve((req, res) => {
      urls.push(String(req.url));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ service: 'kitsune-mcp', version: '1.2.3', browsers_connected: 0 }));
    });
    expect(await probeDaemon(deps, endpoint, undefined)).toEqual({
      kind: 'kitsune', verified: false, pid: undefined, version: '1.2.3', browsers: 0,
    });
    expect(urls).toEqual(['/health']);
  });

  it('unverified when the daemon cannot prove it holds our token', async () => {
    const urls: string[] = [];
    await serveDaemon({ proof: 'd'.repeat(64) });
    server!.on('request', (req) => urls.push(String(req.url)));
    const info = await probeDaemon(deps, endpoint, token);
    expect(info).toMatchObject({ kind: 'kitsune', verified: false, pid: undefined });
    expect(urls).toEqual(['/health']); // the token is never sent to an unverified daemon
  });

  it('verified with a pid when both answers are signed correctly', async () => {
    await serveDaemon();
    expect(await probeDaemon(deps, endpoint, token)).toEqual({
      kind: 'kitsune', verified: true, pid: 4242, version: '9.9.9', browsers: 1,
    });
  });

  it('verified but without a pid when the /daemon/info signature is wrong or missing', async () => {
    for (const signature of ['e'.repeat(64), 'not-hex', null]) {
      await serveDaemon({ signature });
      expect(await probeDaemon(deps, endpoint, token)).toMatchObject({ kind: 'kitsune', verified: true, pid: undefined });
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  it('ignores a pid that is not a positive integer', async () => {
    for (const pid of [0, -1, 1.5, 'nope', null]) {
      await serveDaemon({ pid });
      expect(await probeDaemon(deps, endpoint, token)).toMatchObject({ verified: true, pid: undefined });
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });
});

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/**
 * The `fsApi` parameter of writeFileAtomic / removeTreeSafe defaults to the
 * whole `node:fs` module, so TypeScript infers that full type for it. The
 * functions only call the handful of entry points below, so the stubs
 * implement exactly those and are narrowed here, once, instead of at every
 * call site.
 */
type FsApi = typeof import('node:fs');
const asFsApi = (stub: FsStub): FsApi => stub as unknown as FsApi;
type FsStub =
  | Pick<FsApi, 'openSync' | 'fsyncSync' | 'closeSync' | 'chmodSync' | 'unlinkSync'> & {
      writeFileSync: (...args: never[]) => unknown;
      renameSync: (from: string, to: string) => void;
    }
  | {
      lstatSync: (p: string) => { isSymbolicLink: () => boolean; isDirectory: () => boolean };
      readdirSync: (p: string) => string[];
      rmSync: (p: string, options?: unknown) => unknown;
    };

describe('writeFileAtomic', () => {
  /**
   * Real fs, with renameSync failing `failures` times with `code` first.
   * `attempts` counts every call; `injected` only the failures made here, so
   * a real rename that fails once more (Windows AV) does not change it.
   */
  function flakyRename(code: string, failures: number) {
    let n = 0;
    let injected = 0;
    return {
      openSync: fs.openSync,
      writeFileSync: fs.writeFileSync,
      fsyncSync: fs.fsyncSync,
      closeSync: fs.closeSync,
      chmodSync: fs.chmodSync,
      unlinkSync: fs.unlinkSync,
      renameSync: (from: string, to: string) => {
        if (n++ < failures) {
          injected++;
          const err: NodeJS.ErrnoException = new Error(`${code}: busy`);
          err.code = code;
          throw err;
        }
        fs.renameSync(from, to);
      },
      get attempts() {
        return n;
      },
      get injected() {
        return injected;
      },
    };
  }

  it('replaces the file and leaves no temporary file behind', () => {
    const target = path.join(tmp, 'kitsune_mcp.json');
    fs.writeFileSync(target, 'old');
    writeFileAtomic(target, 'new');
    expect(fs.readFileSync(target, 'utf8')).toBe('new');
    expect(fs.readdirSync(tmp)).toEqual(['kitsune_mcp.json']);
  });

  it('creates a file that is not there yet', () => {
    const target = path.join(tmp, 'kitsune_mcp.json');
    writeFileAtomic(target, 'fresh');
    expect(fs.readFileSync(target, 'utf8')).toBe('fresh');
  });

  it('retries the rename while the target is held open (EPERM / EACCES / EBUSY)', () => {
    for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
      const target = path.join(tmp, `retry-${code}.json`);
      const fsApi = flakyRename(code, 2);
      writeFileAtomic(target, code, {}, asFsApi(fsApi));
      expect(fs.readFileSync(target, 'utf8')).toBe(code);
      // two injected failures, then the real rename (retried itself if the OS was busy)
      expect(fsApi.injected).toBe(2);
      expect(fsApi.attempts).toBeGreaterThanOrEqual(3);
      expect(fs.readdirSync(tmp).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    }
  });

  it('gives up after ten attempts and removes the temporary file', () => {
    const target = path.join(tmp, 'stubborn.json');
    const fsApi = flakyRename('EBUSY', 99);
    expect(() => writeFileAtomic(target, 'x', {}, asFsApi(fsApi))).toThrow(/EBUSY/);
    expect(fsApi.attempts).toBe(10);
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.readdirSync(tmp)).toEqual([]);
  });

  it('does not retry another rename error', () => {
    const target = path.join(tmp, 'xdev.json');
    const fsApi = flakyRename('EXDEV', 99);
    expect(() => writeFileAtomic(target, 'x', {}, asFsApi(fsApi))).toThrow(/EXDEV/);
    expect(fsApi.attempts).toBe(1);
    expect(fs.readdirSync(tmp)).toEqual([]);
  });

  it('removes the temporary file and keeps the old content when the write fails', () => {
    const target = path.join(tmp, 'kitsune_mcp.json');
    fs.writeFileSync(target, 'old');
    const fsApi = {
      openSync: fs.openSync,
      writeFileSync: () => {
        const err: NodeJS.ErrnoException = new Error('ENOSPC: no space left on device');
        err.code = 'ENOSPC';
        throw err;
      },
      fsyncSync: fs.fsyncSync,
      closeSync: fs.closeSync,
      chmodSync: fs.chmodSync,
      renameSync: fs.renameSync,
      unlinkSync: fs.unlinkSync,
    };
    expect(() => writeFileAtomic(target, 'new', {}, asFsApi(fsApi))).toThrow(/ENOSPC/);
    expect(fs.readFileSync(target, 'utf8')).toBe('old');
    expect(fs.readdirSync(tmp)).toEqual(['kitsune_mcp.json']);
  });

  it.skipIf(isWin)('applies the POSIX mode (the wrapper is 0700, the manifest 0644)', () => {
    const wrapper = path.join(tmp, 'run-host.sh');
    writeFileAtomic(wrapper, '#!/bin/sh\n', { mode: 0o700 });
    expect(fs.statSync(wrapper).mode & 0o777).toBe(0o700);

    const manifest = path.join(tmp, 'kitsune_mcp.json');
    writeFileAtomic(manifest, '{}', { mode: 0o644 });
    expect(fs.statSync(manifest).mode & 0o777).toBe(0o644);

    // replacing an existing file sets the mode again
    writeFileAtomic(wrapper, '#!/bin/sh\n# v2\n', { mode: 0o700 });
    expect(fs.statSync(wrapper).mode & 0o777).toBe(0o700);
  });
});

/** Can this machine / account create a symlink or a junction? (Windows needs a privilege.) */
const canLink = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kitsune-link-'));
  try {
    fs.mkdirSync(path.join(dir, 'real'));
    fs.symlinkSync(path.join(dir, 'real'), path.join(dir, 'link'), 'junction');
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

describe('removeTreeSafe', () => {
  it('reports an absent directory and deletes a plain tree', () => {
    expect(removeTreeSafe(path.join(tmp, 'nope'))).toEqual({ status: 'absent' });

    const root = path.join(tmp, 'native-host');
    fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(root, 'run-host.cmd'), '');
    fs.writeFileSync(path.join(root, 'sub', 'kitsune_mcp.json'), '{}');
    expect(removeTreeSafe(root)).toEqual({ status: 'removed' });
    expect(fs.existsSync(root)).toBe(false);
  });

  it.skipIf(!canLink)('refuses a tree that holds a symlink or a junction, and keeps the target', () => {
    const outside = path.join(tmp, 'precious');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'do not delete me');

    const root = path.join(tmp, 'native-host');
    fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(root, 'run-host.cmd'), '');
    fs.symlinkSync(outside, path.join(root, 'sub', 'link'), 'junction');

    const res = removeTreeSafe(root);
    expect(res.status).toBe('refused');
    expect(res.links).toEqual([path.join(root, 'sub', 'link')]);
    expect(fs.existsSync(root)).toBe(true);
    expect(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8')).toBe('do not delete me');
  });

  it.skipIf(!canLink)('refuses when the root itself is a link', () => {
    const outside = path.join(tmp, 'precious');
    fs.mkdirSync(outside);
    const root = path.join(tmp, 'native-host');
    fs.symlinkSync(outside, root, 'junction');
    expect(removeTreeSafe(root)).toEqual({ status: 'refused', links: [root] });
    expect(fs.existsSync(outside)).toBe(true);
  });

  it('refuses a link reported by the file-system API (no privilege needed)', () => {
    // Same check as above, driven through a stub so it runs where symlinks cannot be created.
    const root = path.join(tmp, 'native-host');
    const link = path.join(root, 'link');
    const removed: string[] = [];
    const stat = (kind: 'dir' | 'link' | 'file') => ({
      isSymbolicLink: () => kind === 'link',
      isDirectory: () => kind === 'dir',
    });
    const fsApi = {
      lstatSync: (p: string) => stat(p === root ? 'dir' : p === link ? 'link' : 'file'),
      readdirSync: (p: string) => (p === root ? ['link', 'run-host.cmd'] : []),
      rmSync: (p: string) => removed.push(p),
    };
    expect(removeTreeSafe(root, asFsApi(fsApi))).toEqual({ status: 'refused', links: [link] });
    expect(removed).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Daemon authentication copy
// ---------------------------------------------------------------------------

describe('daemon authentication copy', () => {
  it('computes the same MACs as @kitsune-mcp/shared/node (auth.ts)', () => {
    const token = 'a'.repeat(64);
    expect(computeMac(token, 'health', 'b'.repeat(32))).toBe(serverAuth.computeMac(token, 'health', 'b'.repeat(32)));
  });

  it('signPost signs like signRequest (POST /daemon/shutdown from uninstall.mjs)', () => {
    const token = 'a'.repeat(64);
    const body = JSON.stringify({ force: false });
    const s = signPost(token, '/daemon/shutdown', body, 1_000);
    const nonce = s.headers[AUTH_HEADER.nonce];
    expect(s.nonce).toBe(nonce);
    expect(s.headers[AUTH_HEADER.signature]).toBe(serverAuth.computeMac(
      token, serverAuth.MAC_LABEL.httpRequest, 'POST', '/daemon/shutdown', '1000', nonce, serverAuth.sha256Hex(body),
    ));
  });
  // TODO(test): stopDaemonGracefully outcomes (stopped / refused / unanswered / still-running) and the uninstall daemon branch
});

// ---------------------------------------------------------------------------
// The reference manifest shipped in the repository
// ---------------------------------------------------------------------------

describe('packages/native-host/kitsune_mcp.json (manual-setup template)', () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const template = JSON.parse(fs.readFileSync(path.join(repoRoot, 'packages', 'native-host', 'kitsune_mcp.json'), 'utf8'));
  const extManifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'packages', 'extension', 'manifest.json'), 'utf8'));
  const geckoId = extManifest.browser_specific_settings.gecko.id;

  it('has the same shape and keys as the generated manifest', () => {
    const generated = buildManifest({ wrapperPath: template.path, geckoId });
    expect(Object.keys(template).sort()).toEqual(Object.keys(generated).sort());
    expect(template.name).toBe(generated.name);
    expect(template.name).toBe(HOST_NAME);
    expect(template.type).toBe(generated.type);
    expect(template.allowed_extensions).toEqual(generated.allowed_extensions);
  });

  it('allows exactly the extension id from the extension manifest', () => {
    expect(template.allowed_extensions).toEqual([geckoId]);
    expect(geckoId).toMatch(/^[^@\s]+@[^@\s]+$/);
  });

  it('keeps a placeholder path, so copying it without editing cannot work by accident', () => {
    expect(typeof template.path).toBe('string');
    expect(template.path).toMatch(/run-host/);
    expect(path.isAbsolute(template.path)).toBe(false);
    expect(template.description).toMatch(/template/i);
  });
});

// ---------------------------------------------------------------------------
// install / uninstall
// ---------------------------------------------------------------------------

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
      // Return true like process.stdout.write (defaultDeps' out / err).
      out: (s: string) => (out.push(s), true),
      err: (s: string) => (out.push(s), true),
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

const GECKO_ID = 'kitsune-test@example.invalid';

/** The real fs with some functions replaced (deps.fs). */
function fsWith(overrides: Record<string, unknown>) {
  return { ...fs, ...overrides };
}

/** A readFileSync that fails with `code` for one file and reads the rest. */
function failFor(file: string, code: string) {
  return (p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    if (p === file) throw Object.assign(new Error(`${code}: simulated, open '${file}'`), { code });
    return (fs.readFileSync as (...a: unknown[]) => unknown)(p, ...rest);
  };
}

/** A repository-shaped directory with the files the installer looks for. */
function fakeRepo(root: string): string {
  const write = (rel: string[], text: string) => {
    const file = path.join(root, ...rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  write(['packages', 'native-host', 'dist', 'index.js'], '// host\n');
  write(['packages', 'mcp-server', 'dist', 'index.js'], '// server\n');
  write(['packages', 'extension', 'manifest.json'], JSON.stringify({
    manifest_version: 2,
    browser_specific_settings: { gecko: { id: GECKO_ID } },
  }));
  return root;
}

/**
 * Deps for a real run: a temp home, a fake repository, and a reg.exe that
 * only writes to an in-memory map. Nothing touches the real registry: every
 * command goes through `run`, which never spawns anything.
 */
function realRunDeps(home: string, repoRoot: string, overrides: Record<string, unknown> = {}) {
  const out: string[] = [];
  const calls: string[][] = [];
  const registry = new Map<string, string>();
  const processList: { pid: number; cmd: string }[] = [];
  const run = (file: string, args: string[]) => {
    calls.push([file, ...args]);
    if (/^reg(\.exe)?$/i.test(file)) {
      const [verb, key] = args;
      if (verb === 'query') {
        const value = registry.get(key);
        if (value === undefined) return { status: 1, stdout: '', stderr: 'ERROR: not found', error: undefined };
        return { status: 0, stdout: `\r\n${key}\r\n    (Default)    REG_SZ    ${value}\r\n\r\n`, stderr: '', error: undefined };
      }
      if (verb === 'add') {
        registry.set(key, args[args.indexOf('/d') + 1]);
        return { status: 0, stdout: 'The operation completed successfully.\r\n', stderr: '', error: undefined };
      }
      if (verb === 'delete') {
        const had = registry.delete(key);
        return { status: had ? 0 : 1, stdout: '', stderr: '', error: undefined };
      }
    }
    if (/cscript\.exe$/i.test(file)) {
      const text = processList.map((p) => `${p.pid}\t${p.cmd}`).join('\r\n') + '\r\n';
      return { status: 0, stdout: Buffer.from(text, 'utf16le'), stderr: '', error: undefined };
    }
    if (file === 'ps') {
      const text = processList.map((p) => ` ${p.pid} ${p.cmd}`).join('\n') + '\n';
      return { status: 0, stdout: text, stderr: '', error: undefined };
    }
    return { status: 0, stdout: '', stderr: '', error: undefined };
  };
  return {
    out,
    calls,
    registry,
    processList,
    text: () => out.join(''),
    deps: {
      home,
      repoRoot,
      env: { PATH: '' },
      out: (s: string) => (out.push(s), true),
      err: (s: string) => (out.push(s), true),
      isTTY: false,
      prompt: () => {
        throw new Error('must not prompt without a TTY');
      },
      run,
      httpGet: async () => null,
      kill: () => {
        throw new Error('must not stop a process in this test');
      },
      readProcVersion: () => '',
      ...overrides,
    },
  };
}

describe('install (real run in a temp home)', () => {
  let home: string;
  let repoRoot: string;
  let data: ReturnType<typeof dataPaths>;
  let target: { file: string; registryKey?: string };

  beforeEach(() => {
    home = path.join(tmp, 'home');
    fs.mkdirSync(home);
    repoRoot = fakeRepo(path.join(tmp, 'repo'));
    data = dataPaths(process.platform, home);
    target = nmManifestTargets({ platform: process.platform, home, env: {}, exists: () => false })[0];
  });

  it('writes the wrapper and the manifest, and registers the host', async () => {
    const ctx = realRunDeps(home, repoRoot);
    expect(await runInstall([], ctx.deps)).toBe(0);

    const wrapper = fs.readFileSync(data.wrapperPath, 'utf8');
    expect(wrapper).toBe(buildWrapper(process.platform, {
      nativeHostPkg: path.join(repoRoot, 'packages', 'native-host'),
      nodePath: process.execPath,
      hostEntry: path.join(repoRoot, 'packages', 'native-host', 'dist', 'index.js'),
    }));

    expect(JSON.parse(fs.readFileSync(target.file, 'utf8'))).toEqual(
      buildManifest({ wrapperPath: data.wrapperPath, geckoId: GECKO_ID }),
    );
    expect(ctx.text()).toContain(`gecko ID: ${GECKO_ID}`);
    expect(ctx.text()).toContain('Installation complete.');
    // nothing was left half-written
    expect(fs.readdirSync(data.nativeHostDir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it.skipIf(!isWin)('calls reg.exe add with the documented arguments and nothing else', async () => {
    const ctx = realRunDeps(home, repoRoot);
    expect(await runInstall([], ctx.deps)).toBe(0);
    const add = ctx.calls.filter((c) => c[0] === 'reg.exe' && c[1] === 'add');
    expect(add).toEqual([['reg.exe', 'add', WIN_REG_KEY, '/ve', '/t', 'REG_SZ', '/d', data.winManifestPath, '/f']]);
    expect(ctx.registry.get(WIN_REG_KEY)).toBe(data.winManifestPath);
    // only HKCU is written; the App Paths lookups are queries
    expect(ctx.calls.filter((c) => c[0] === 'reg.exe' && c[1] !== 'query').every((c) => c[2].startsWith('HKCU\\'))).toBe(true);
    expect(ctx.calls.some((c) => /powershell/i.test(c[0]))).toBe(false);
  });

  it('changes nothing on a second run', async () => {
    const first = realRunDeps(home, repoRoot);
    expect(await runInstall([], first.deps)).toBe(0);
    const before = fs.statSync(data.wrapperPath).mtimeMs;

    const second = realRunDeps(home, repoRoot);
    second.registry.set(WIN_REG_KEY, first.registry.get(WIN_REG_KEY) ?? '');
    if (!isWin) second.registry.clear();
    expect(await runInstall([], second.deps)).toBe(0);

    const text = second.text();
    expect(text).toContain(`unchanged ${data.wrapperPath}`);
    expect(text).toContain(`unchanged ${target.file}`);
    expect(text).not.toContain('updated ');
    if (isWin) {
      expect(text).toContain(`unchanged ${WIN_REG_KEY}`);
      expect(second.calls.some((c) => c[0] === 'reg.exe' && c[1] === 'add')).toBe(false);
    }
    expect(fs.statSync(data.wrapperPath).mtimeMs).toBe(before);
  });

  it.skipIf(!isWin)('removes wrappers left by an earlier manual setup', async () => {
    fs.mkdirSync(data.nativeHostDir, { recursive: true });
    const stale = path.join(data.nativeHostDir, 'run-host-e2e.cmd');
    fs.writeFileSync(stale, '@echo off\r\n');
    const ctx = realRunDeps(home, repoRoot);
    expect(await runInstall([], ctx.deps)).toBe(0);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(data.wrapperPath)).toBe(true);
    expect(ctx.text()).toContain(`removed stale wrapper ${stale}`);
  });

  it('replaces a manifest pointing at another host without asking when there is no TTY', async () => {
    fs.mkdirSync(path.dirname(target.file), { recursive: true });
    fs.writeFileSync(target.file, serializeJson(buildManifest({
      wrapperPath: isWin ? 'D:\\old\\run-host.cmd' : '/old/run-host.sh',
      geckoId: GECKO_ID,
    })));
    const ctx = realRunDeps(home, repoRoot);
    expect(await runInstall([], ctx.deps)).toBe(0);
    expect(ctx.text()).toContain('points to another host');
    expect(JSON.parse(fs.readFileSync(target.file, 'utf8')).path).toBe(data.wrapperPath);
  });

  it('asks before replacing it when stdin is a TTY, and honours "no"', async () => {
    const old = serializeJson(buildManifest({
      wrapperPath: isWin ? 'D:\\old\\run-host.cmd' : '/old/run-host.sh',
      geckoId: GECKO_ID,
    }));
    fs.mkdirSync(path.dirname(target.file), { recursive: true });
    fs.writeFileSync(target.file, old);

    const questions: string[] = [];
    const ctx = realRunDeps(home, repoRoot, {
      isTTY: true,
      prompt: async (q: string) => {
        questions.push(q);
        return 'n';
      },
    });
    expect(await runInstall([], ctx.deps)).toBe(0);
    expect(questions.join('')).toMatch(/Replace it with this installation\? \[Y\/n\]/);
    expect(fs.readFileSync(target.file, 'utf8')).toBe(old);
    expect(ctx.text()).toContain('left unchanged');
    if (isWin) expect(ctx.calls.some((c) => c[0] === 'reg.exe' && c[1] === 'add')).toBe(false);
  });

  it('--yes replaces it without a question even with a TTY', async () => {
    fs.mkdirSync(path.dirname(target.file), { recursive: true });
    fs.writeFileSync(target.file, serializeJson(buildManifest({
      wrapperPath: isWin ? 'D:\\old\\run-host.cmd' : '/old/run-host.sh',
      geckoId: GECKO_ID,
    })));
    const ctx = realRunDeps(home, repoRoot, { isTTY: true });
    expect(await runInstall(['--yes'], ctx.deps)).toBe(0);
    expect(JSON.parse(fs.readFileSync(target.file, 'utf8')).path).toBe(data.wrapperPath);
  });

  it('--register-claude removes the old entry first and then adds this one', async () => {
    const claude = path.join(home, '.local', 'bin', isWin ? 'claude.exe' : 'claude');
    fs.mkdirSync(path.dirname(claude), { recursive: true });
    fs.writeFileSync(claude, '');
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
      mcpServers: { [CLAUDE_NAME]: { command: 'node', args: ['/some/other/clone/dist/index.js'] } },
    }));

    const ctx = realRunDeps(home, repoRoot);
    expect(await runInstall(['--register-claude'], ctx.deps)).toBe(0);
    const serverEntry = path.join(repoRoot, 'packages', 'mcp-server', 'dist', 'index.js');
    const claudeCalls = ctx.calls.filter((c) => c[0] === claude);
    expect(claudeCalls).toEqual([
      [claude, 'mcp', 'remove', '--scope', 'user', CLAUDE_NAME],
      [claude, 'mcp', 'add', '--scope', 'user', CLAUDE_NAME, '--', process.execPath, serverEntry],
    ]);
    expect(ctx.text()).toContain(`registered '${CLAUDE_NAME}' (scope user)`);
  });

  it('--register-claude does nothing when the entry already matches', async () => {
    const claude = path.join(home, '.local', 'bin', isWin ? 'claude.exe' : 'claude');
    fs.mkdirSync(path.dirname(claude), { recursive: true });
    fs.writeFileSync(claude, '');
    const serverEntry = path.join(repoRoot, 'packages', 'mcp-server', 'dist', 'index.js');
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
      mcpServers: { [CLAUDE_NAME]: { command: process.execPath, args: [serverEntry] } },
    }));

    const ctx = realRunDeps(home, repoRoot);
    expect(await runInstall(['--register-claude'], ctx.deps)).toBe(0);
    expect(ctx.calls.filter((c) => c[0] === claude)).toEqual([]);
    expect(ctx.text()).toContain('already matches this installation');
  });

  it('without --register-claude it only prints the command to run by hand', async () => {
    const claude = path.join(home, '.local', 'bin', isWin ? 'claude.exe' : 'claude');
    fs.mkdirSync(path.dirname(claude), { recursive: true });
    fs.writeFileSync(claude, '');
    const ctx = realRunDeps(home, repoRoot);
    expect(await runInstall([], ctx.deps)).toBe(0);
    expect(ctx.calls.filter((c) => c[0] === claude)).toEqual([]);
    expect(ctx.text()).toContain('Not changed (pass --register-claude to register)');
    expect(ctx.text()).toContain(`claude mcp add --scope user ${CLAUDE_NAME} --`);
  });

  it('stops with exit code 1 when the build output is missing', async () => {
    fs.rmSync(path.join(repoRoot, 'packages', 'mcp-server', 'dist'), { recursive: true, force: true });
    const ctx = realRunDeps(home, repoRoot);
    expect(await runInstall([], ctx.deps)).toBe(1);
    expect(ctx.text()).toContain('build output not found');
    expect(fs.existsSync(data.nativeHostDir)).toBe(false);
  });

  it('does not crash on a Claude Code entry whose args is not an array', async () => {
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
      mcpServers: { [CLAUDE_NAME]: { command: 'node', args: 'x.js' } },
    }));
    const ctx = realRunDeps(home, repoRoot);
    expect(await runInstall([], ctx.deps)).toBe(0);
    expect(ctx.text()).toContain('registered (scope user): node — points elsewhere');
  });

  it('warns before replacing a manifest that is not valid JSON', async () => {
    fs.mkdirSync(path.dirname(target.file), { recursive: true });
    fs.writeFileSync(target.file, '{ broken');
    const ctx = realRunDeps(home, repoRoot);
    expect(await runInstall([], ctx.deps)).toBe(0);
    expect(ctx.text()).toContain(`[warn] ${target.file} is not a valid host manifest; replacing it`);
    expect(JSON.parse(fs.readFileSync(target.file, 'utf8')).path).toBe(data.wrapperPath);
  });

  it('stops with exit code 1 when an existing manifest cannot be read', async () => {
    const ctx = realRunDeps(home, repoRoot, {
      fs: fsWith({ readFileSync: failFor(target.file, 'EACCES') }),
    });
    expect(await runInstall([], ctx.deps)).toBe(1);
    expect(ctx.text()).toContain(`[error] could not read ${target.file}`);
  });

  it('turns an unexpected file-system error into one error line and exit code 1', async () => {
    const ctx = realRunDeps(home, repoRoot, {
      fs: fsWith({
        mkdirSync: () => {
          throw Object.assign(new Error('EACCES: permission denied, mkdir'), { code: 'EACCES' });
        },
      }),
    });
    expect(await runInstall([], ctx.deps)).toBe(1);
    expect(ctx.text()).toContain('[error] EACCES: permission denied, mkdir');
  });

  it('prints the health check for the configured port', async () => {
    const ctx = realRunDeps(home, repoRoot, { env: { PATH: '', FOX_HTTP_PORT: '9999' } });
    expect(await runInstall([], ctx.deps)).toBe(0);
    expect(ctx.text()).toContain('-s http://127.0.0.1:9999/health');
    expect(ctx.text()).not.toContain(':8765');
  });

  it('reports a usage error with exit code 2 and writes nothing', async () => {
    const ctx = realRunDeps(home, repoRoot);
    expect(await runInstall(['--claude-scope=nope'], ctx.deps)).toBe(2);
    expect(fs.readdirSync(home)).toEqual([]);
  });
});

describe('uninstall (real run in a temp home)', () => {
  let home: string;
  let repoRoot: string;
  let data: ReturnType<typeof dataPaths>;

  beforeEach(async () => {
    home = path.join(tmp, 'home');
    fs.mkdirSync(home);
    repoRoot = fakeRepo(path.join(tmp, 'repo'));
    data = dataPaths(process.platform, home);
    // install first, so there is something to remove
    const ctx = realRunDeps(home, repoRoot);
    expect(await runInstall([], ctx.deps)).toBe(0);
    fs.writeFileSync(data.tokenPath, 'f'.repeat(64));
    fs.mkdirSync(data.logsDir, { recursive: true });
    fs.writeFileSync(path.join(data.logsDir, 'daemon.log'), 'log\n');
  });

  it('removes the registration before stopping anything, and keeps ~/.kitsune-mcp without --purge', async () => {
    const ctx = realRunDeps(home, repoRoot);
    if (isWin) ctx.registry.set(WIN_REG_KEY, data.winManifestPath);
    expect(await runUninstall([], ctx.deps)).toBe(0);

    const text = ctx.text();
    const order = [
      '1. Removing the Firefox Native Messaging registration',
      `2. Removing ${data.nativeHostDir}`,
      '3. Claude Code',
      '4. Stopping running processes',
      `5. Data directory ${data.dataDir}`,
    ].map((s) => text.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);

    expect(fs.existsSync(data.nativeHostDir)).toBe(false);
    expect(fs.existsSync(data.tokenPath)).toBe(true);
    expect(text).toContain('kept (use --purge to delete it)');
    expect(text).not.toContain('points to another installation');
    if (isWin) {
      expect(ctx.calls.some((c) => c[0] === 'reg.exe' && c[1] === 'delete' && c[2] === WIN_REG_KEY)).toBe(true);
      expect(ctx.registry.has(WIN_REG_KEY)).toBe(false);
    }
  });

  it('--purge deletes the whole data directory', async () => {
    const ctx = realRunDeps(home, repoRoot);
    expect(await runUninstall(['--purge'], ctx.deps)).toBe(0);
    expect(fs.existsSync(data.dataDir)).toBe(false);
    expect(ctx.text()).toContain('Uninstall complete.');
  });

  it('removes an empty ~/.kitsune-mcp even without --purge', async () => {
    fs.rmSync(data.tokenPath, { force: true });
    fs.rmSync(data.logsDir, { recursive: true, force: true });
    const ctx = realRunDeps(home, repoRoot);
    expect(await runUninstall([], ctx.deps)).toBe(0);
    expect(fs.existsSync(data.dataDir)).toBe(false);
    expect(ctx.text()).toContain('empty — removed');
  });

  it('--no-stop leaves the running Native Host and daemon alone', async () => {
    const ctx = realRunDeps(home, repoRoot);
    const hostEntry = path.join(repoRoot, 'packages', 'native-host', 'dist', 'index.js');
    const serverEntry = path.join(repoRoot, 'packages', 'mcp-server', 'dist', 'index.js');
    ctx.processList.push(
      { pid: 111, cmd: `"${process.execPath}" "${hostEntry}"` },
      { pid: 222, cmd: `"${process.execPath}" "${serverEntry}" --daemon` },
    );
    // deps.kill throws if it is ever called
    expect(await runUninstall(['--no-stop'], ctx.deps)).toBe(0);
    expect(ctx.text()).toContain('left running (--no-stop): Native Host 111, daemon 222');
  });

  it('stops the Native Host before the daemon', async () => {
    const stopped: [number, string][] = [];
    const alive = new Set([111, 222]);
    const ctx = realRunDeps(home, repoRoot, {
      kill: (pid: number, signal: string) => {
        stopped.push([pid, signal]);
        alive.delete(pid);
      },
      isAlive: (pid: number) => alive.has(pid),
      sleep: async () => {},
    });
    const hostEntry = path.join(repoRoot, 'packages', 'native-host', 'dist', 'index.js');
    const serverEntry = path.join(repoRoot, 'packages', 'mcp-server', 'dist', 'index.js');
    ctx.processList.push(
      { pid: 222, cmd: `"${process.execPath}" "${serverEntry}" --daemon` },
      { pid: 111, cmd: `"${process.execPath}" "${hostEntry}"` },
    );
    expect(await runUninstall(['--yes'], ctx.deps)).toBe(0);
    // a live Native Host would start the daemon again, so it goes first
    expect(stopped).toEqual([[111, 'SIGTERM'], [222, 'SIGTERM']]);
    expect(ctx.text()).toContain('Native Host PID 111: stopped');
    expect(ctx.text()).toContain('daemon PID 222: stopped');
  });

  it('never touches a KitsuneMCP process of another checkout', async () => {
    const ctx = realRunDeps(home, repoRoot);
    ctx.processList.push({ pid: 333, cmd: `"${process.execPath}" "/other/clone/packages/native-host/dist/index.js"` });
    expect(await runUninstall(['--yes'], ctx.deps)).toBe(0);
    expect(ctx.text()).toContain('not touched (another KitsuneMCP checkout?): PID 333');
  });

  it('--keep-claude leaves the Claude Code registration alone', async () => {
    const claude = path.join(home, '.local', 'bin', isWin ? 'claude.exe' : 'claude');
    fs.mkdirSync(path.dirname(claude), { recursive: true });
    fs.writeFileSync(claude, '');
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
      mcpServers: { [CLAUDE_NAME]: { command: process.execPath, args: ['/x/index.js'] } },
    }));
    const ctx = realRunDeps(home, repoRoot);
    expect(await runUninstall(['--keep-claude'], ctx.deps)).toBe(0);
    expect(ctx.calls.filter((c) => c[0] === claude)).toEqual([]);
    expect(ctx.text()).toContain('kept. To remove it:');
  });

  it('--unregister-claude runs claude mcp remove for every scope it found', async () => {
    const claude = path.join(home, '.local', 'bin', isWin ? 'claude.exe' : 'claude');
    fs.mkdirSync(path.dirname(claude), { recursive: true });
    fs.writeFileSync(claude, '');
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
      mcpServers: { [CLAUDE_NAME]: { command: process.execPath, args: ['/x/index.js'] } },
      projects: { [repoRoot]: { mcpServers: { [CLAUDE_NAME]: { command: process.execPath, args: ['/x/index.js'] } } } },
    }));
    const ctx = realRunDeps(home, repoRoot);
    expect(await runUninstall(['--unregister-claude'], ctx.deps)).toBe(0);
    expect(ctx.calls.filter((c) => c[0] === claude)).toEqual([
      [claude, 'mcp', 'remove', '--scope', 'user', CLAUDE_NAME],
      [claude, 'mcp', 'remove', '--scope', 'local', CLAUDE_NAME],
    ]);
  });

  it('a broken .claude.json is "registration state unknown", not "not registered" (exit code 1)', async () => {
    fs.writeFileSync(path.join(home, '.claude.json'), '{ broken');
    const ctx = realRunDeps(home, repoRoot);
    expect(await runUninstall([], ctx.deps)).toBe(1);
    const text = ctx.text();
    expect(text).toContain('registration state unknown');
    expect(text).not.toContain('is not registered');
    expect(text).toContain('Uninstall finished with 1 problem(s)');
  });

  it('an unreadable .claude.json (EACCES) is a problem too (exit code 1)', async () => {
    const configFile = path.join(home, '.claude.json');
    fs.writeFileSync(configFile, '{}');
    const ctx = realRunDeps(home, repoRoot, { fs: fsWith({ readFileSync: failFor(configFile, 'EACCES') }) });
    expect(await runUninstall([], ctx.deps)).toBe(1);
    const text = ctx.text();
    expect(text).toContain(`could not read ${configFile}`);
    expect(text).toContain('registration state unknown');
    expect(text).not.toContain('is not registered');
    expect(text).toContain('Uninstall finished with 1 problem(s)');
  });

  it('reports a data directory it cannot remove instead of crashing', async () => {
    fs.rmSync(data.tokenPath, { force: true });
    fs.rmSync(data.logsDir, { recursive: true, force: true });
    const ctx = realRunDeps(home, repoRoot, {
      fs: fsWith({
        rmdirSync: () => {
          throw Object.assign(new Error('ENOTEMPTY: directory not empty, rmdir'), { code: 'ENOTEMPTY' });
        },
      }),
    });
    expect(await runUninstall([], ctx.deps)).toBe(1);
    expect(ctx.text()).toContain(`[warn] could not check or remove ${data.dataDir}: ENOTEMPTY`);
    expect(ctx.text()).toContain('Uninstall finished with 1 problem(s)');
  });

  it('--no-stop does not count an unverified daemon without a PID as a problem', async () => {
    const health = { status: 200, headers: {}, body: Buffer.from(JSON.stringify({ service: 'kitsune-mcp', version: '1' })) };
    const ctx = realRunDeps(home, repoRoot, { httpGet: async () => health });
    expect(await runUninstall(['--no-stop'], ctx.deps)).toBe(0);
    expect(ctx.text()).not.toContain('PID is unknown');
    // without --no-stop it is one
    const again = realRunDeps(home, repoRoot, { httpGet: async () => health });
    expect(await runUninstall(['--yes'], again.deps)).toBe(1);
    expect(again.text()).toContain('PID is unknown');
  });

  it('warns, but still removes, a registration of another installation', async () => {
    const ctx = realRunDeps(home, repoRoot);
    const target = nmManifestTargets({ platform: process.platform, home, env: {}, exists: () => false })[0];
    const other = isWin ? 'D:\\other\\kitsune_mcp.json' : '/other/run-host.sh';
    if (isWin) ctx.registry.set(WIN_REG_KEY, other);
    else fs.writeFileSync(target.file, serializeJson(buildManifest({ wrapperPath: other, geckoId: GECKO_ID })));
    expect(await runUninstall([], ctx.deps)).toBe(0);
    expect(ctx.text()).toContain(`points to another installation: ${other}`);
    if (isWin) expect(ctx.registry.has(WIN_REG_KEY)).toBe(false);
    else expect(fs.existsSync(target.file)).toBe(false);
  });

  it('reports a usage error with exit code 2', async () => {
    const ctx = realRunDeps(home, repoRoot);
    expect(await runUninstall(['--grace=99'], ctx.deps)).toBe(2);
    expect(fs.existsSync(data.nativeHostDir)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// scripts/e2e/tools-smoke.mjs helpers
// ---------------------------------------------------------------------------

describe('tools-smoke: interpretCallResponse', () => {
  const answer = (status: number, body: unknown) =>
    ({ status, body: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)) });

  it('treats an error status with { error } only (no success field) as an error', () => {
    // the daemon's auth failure: 403 { error } (http-bridge.ts reply.error)
    const r = interpretCallResponse(answer(403, { error: 'Unauthorized' }));
    expect(r.isError).toBe(true);
    expect(r.text).toBe('HTTP 403: Unauthorized');
    expect(r.data).toBeUndefined();
    expect(interpretCallResponse(answer(500, { error: 'boom' })).isError).toBe(true);
  });

  it('passes a successful call through, with its text parsed as JSON', () => {
    const r = interpretCallResponse(answer(200, {
      success: true,
      result: { content: [{ type: 'text', text: '{"success":true,"tabs":[]}' }] },
    }));
    expect(r.isError).toBe(false);
    expect(r.data).toEqual({ success: true, tabs: [] });
    // a tool error inside a 200 answer stays an error
    expect(interpretCallResponse(answer(200, { success: true, result: { isError: true, content: [] } })).isError).toBe(true);
    expect(interpretCallResponse(answer(400, { success: false, error: 'bad args' })).isError).toBe(true);
  });

  it('reports a body that is not JSON, or no answer, as an error instead of throwing', () => {
    const r = interpretCallResponse(answer(200, '<html>proxy error</html>'));
    expect(r.isError).toBe(true);
    expect(r.text).toContain('not JSON');
    expect(interpretCallResponse(answer(502, '')).isError).toBe(true);
    expect(interpretCallResponse(null).isError).toBe(true);
  });

  it('truncate counts code points (does not split a surrogate pair)', () => {
    expect(truncate('a\u{1F98A}b', 2)).toBe('a\u{1F98A}');
    expect(truncate('  x \n y  ', 120)).toBe(' x y ');
    expect(truncate(undefined)).toBe('');
  });
});
