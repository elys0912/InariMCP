/**
 * The generated host wrappers, the registry value parsing, the Claude Code
 * registration and the Node.js version manager check of scripts/lib/core.mjs.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CLAUDE_NAME, buildManifest, buildPosixWrapper, buildWindowsWrapper, buildWrapper, claudeConfigPath,
  claudeEntryState, commandInvocation, envValue, findClaudeEntries, formatCommand, manifestState, nodeVersionManager,
  parseRegDefaultValue, shellQuote,
} from '../../scripts/lib/core.mjs';
import { defaultDeps } from '../../scripts/lib/system.mjs';

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
    ['', 'HKEY_CURRENT_USER\\Software\\Mozilla\\NativeMessagingHosts\\inari_mcp',
      `    ${label}    ${type}${value === undefined ? '' : `    ${value}`}`, ''].join('\r\n');

  it('reads the value whatever the "(Default)" label is called', () => {
    for (const label of ['(Default)', '(既定)', '(标准)', '(Standard)', '(Par défaut)']) {
      expect(parseRegDefaultValue(answer(label, 'REG_SZ', 'C:\\Users\\u\\.inari-mcp\\native-host\\inari_mcp.json')))
        .toBe('C:\\Users\\u\\.inari-mcp\\native-host\\inari_mcp.json');
    }
  });

  it('reads REG_EXPAND_SZ as well', () => {
    expect(parseRegDefaultValue(answer('(Default)', 'REG_EXPAND_SZ', '%USERPROFILE%\\.inari-mcp\\native-host\\inari_mcp.json')))
      .toBe('%USERPROFILE%\\.inari-mcp\\native-host\\inari_mcp.json');
  });

  it('returns "" for a value that is set but empty', () => {
    expect(parseRegDefaultValue(answer('(Default)', 'REG_SZ'))).toBe('');
    expect(parseRegDefaultValue(answer('(Default)', 'REG_SZ', '   '))).toBe('');
  });

  it('keeps spaces inside the value', () => {
    expect(parseRegDefaultValue(answer('(Default)', 'REG_SZ', 'C:\\Program Files\\x\\inari_mcp.json')))
      .toBe('C:\\Program Files\\x\\inari_mcp.json');
  });

  it('returns null when the key is missing or the answer holds no value line', () => {
    // reg.exe writes "ERROR: The system was unable to find the specified registry key" to stderr
    // and nothing to stdout; regQueryDefault also turns a non-zero exit into null.
    expect(parseRegDefaultValue('')).toBeNull();
    expect(parseRegDefaultValue('ERROR: The system was unable to find the specified registry key or value.')).toBeNull();
    expect(parseRegDefaultValue('HKEY_CURRENT_USER\\Software\\Mozilla\r\n')).toBeNull();
    // only the default value has a type on the same line; a sub key alone is not one
    expect(parseRegDefaultValue('HKEY_CURRENT_USER\\Software\\Mozilla\\NativeMessagingHosts\\inari_mcp\r\n')).toBeNull();
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
  const expected = buildManifest({ wrapperPath: 'C:\\Users\\u\\.inari-mcp\\native-host\\run-host.cmd', geckoId: 'id@example' });

  it('treats the same wrapper path (other case / slashes) as unchanged and another path as different', () => {
    const same = JSON.stringify({ ...expected, path: 'c:/users/u/.inari-mcp/native-host/run-host.cmd' });
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

describe('envValue', () => {
  it('is the trimmed value, or undefined when unset, empty or blank (R3 §3)', () => {
    expect(envValue({}, 'X')).toBeUndefined();
    expect(envValue({ X: '' }, 'X')).toBeUndefined();
    expect(envValue({ X: ' \t ' }, 'X')).toBeUndefined();
    expect(envValue({ X: ' a b ' }, 'X')).toBe('a b');
  });
});

describe('claudeConfigPath', () => {
  it('is ~/.claude.json unless CLAUDE_CONFIG_DIR says otherwise', () => {
    expect(claudeConfigPath('linux', '/home/u', {})).toBe('/home/u/.claude.json');
    expect(claudeConfigPath('win32', 'C:\\Users\\u', {})).toBe('C:\\Users\\u\\.claude.json');
    expect(claudeConfigPath('linux', '/home/u', { CLAUDE_CONFIG_DIR: '/cfg/claude' })).toBe('/cfg/claude/.claude.json');
    expect(claudeConfigPath('win32', 'C:\\Users\\u', { CLAUDE_CONFIG_DIR: 'D:\\cfg' })).toBe('D:\\cfg\\.claude.json');
  });

  it('takes an empty or blank CLAUDE_CONFIG_DIR as unset and trims a set one (R3 §3)', () => {
    expect(claudeConfigPath('linux', '/home/u', { CLAUDE_CONFIG_DIR: '' })).toBe('/home/u/.claude.json');
    expect(claudeConfigPath('linux', '/home/u', { CLAUDE_CONFIG_DIR: '  ' })).toBe('/home/u/.claude.json');
    expect(claudeConfigPath('linux', '/home/u', { CLAUDE_CONFIG_DIR: ' /cfg ' })).toBe('/cfg/.claude.json');
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
          '/no-inari': { mcpServers: { something: {} } },
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
      'C:\\repo\\Inari',
      'C:/repo/Inari',
      'c:\\REPO\\inari',
      'C:\\repo\\Inari\\',
      'C:\\repo\\sub\\..\\Inari',
    ]) {
      const { found, otherLocal } = findClaudeEntries({
        config: { projects: { [key]: { mcpServers: { [CLAUDE_NAME]: entry('l') } } } },
        projectMcp: null,
        repoRoot: 'C:\\repo\\inari',
        platform: 'win32',
      });
      expect([key, found.map((f: { scope: string }) => f.scope)]).toEqual([key, ['local']]);
      expect(otherLocal).toEqual([]);
    }
    // on linux the case matters
    const linux = findClaudeEntries({
      config: { projects: { '/repo/Inari': { mcpServers: { [CLAUDE_NAME]: entry('l') } } } },
      projectMcp: null,
      repoRoot: '/repo/inari',
      platform: 'linux',
    });
    expect(linux.found).toEqual([]);
    expect(linux.otherLocal).toEqual(['/repo/Inari']);
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
    expect(commandInvocation('C:\\x\\claude.cmd', [], 'win32', { ComSpec: ' ' }).file).toBe('cmd.exe');
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
