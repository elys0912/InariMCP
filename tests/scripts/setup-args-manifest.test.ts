/**
 * Command line parsing of scripts/install.mjs / uninstall.mjs, where the Native
 * Messaging manifest goes, the manual steps (--help / --manual) and the
 * manual-setup manifest template shipped in the repository.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  HOST_NAME, UsageError, WIN_REG_KEY, buildManifest, lookup, dataPaths, nmManifestTargets, parseArgs,
  parseInstallArgs, parseUninstallArgs, serializeJson,
} from '../../scripts/lib/core.mjs';
import { manualForPlatform, manualMarkdown } from '../../scripts/lib/texts.mjs';

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

describe('lookup (R2-A SC-C4)', () => {
  it('returns the listed text and throws for an unlisted key', () => {
    const table = { same: 'a', different: 'b' };
    expect(lookup(table, 'same', 'state')).toBe('a');
    expect(() => lookup(table, 'other', 'state')).toThrow('unknown state: other');
    expect(() => lookup(table, 'toString', 'state')).toThrow('unknown state: toString');
  });
});

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
    const m = buildManifest({ wrapperPath: 'C:\\Users\\u\\.inari-mcp\\native-host\\run-host.cmd', geckoId: 'id@example' });
    expect(JSON.parse(serializeJson(m))).toEqual({
      name: 'inari_mcp',
      description: 'InariMCP Native Messaging Host',
      path: 'C:\\Users\\u\\.inari-mcp\\native-host\\run-host.cmd',
      type: 'stdio',
      allowed_extensions: ['id@example'],
    });
  });

  it('goes to the registry on Windows and to the Flatpak directory when Flatpak Firefox exists', () => {
    const win = nmManifestTargets({ platform: 'win32', home: 'C:\\Users\\u', env: {}, exists: () => false });
    expect(win).toEqual([expect.objectContaining({
      registryKey: WIN_REG_KEY,
      file: 'C:\\Users\\u\\.inari-mcp\\native-host\\inari_mcp.json',
    })]);

    const linux = nmManifestTargets({
      platform: 'linux', home: '/home/u', env: {}, exists: (p: string) => p === '/home/u/.var/app/org.mozilla.firefox',
    });
    expect(linux.map((t: { file: string }) => t.file)).toEqual([
      '/home/u/.mozilla/native-messaging-hosts/inari_mcp.json',
      '/home/u/.var/app/org.mozilla.firefox/.mozilla/native-messaging-hosts/inari_mcp.json',
    ]);
  });
});

describe('nmManifestTargets', () => {
  const never = () => false;
  const files = (t: { file: string }[]) => t.map((x) => x.file);
  const ids = (t: { id: string }[]) => t.map((x) => x.id);

  it('win32: one registry value and the manifest under ~/.inari-mcp', () => {
    const t = nmManifestTargets({ platform: 'win32', home: 'C:\\Users\\u', env: {}, exists: never });
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({
      id: 'windows',
      registryKey: 'HKCU\\Software\\Mozilla\\NativeMessagingHosts\\inari_mcp',
      file: dataPaths('win32', 'C:\\Users\\u').winManifestPath,
    });
    // `all` changes nothing on Windows: there is only one location.
    expect(nmManifestTargets({ platform: 'win32', home: 'C:\\Users\\u', env: {}, exists: () => true, all: true })).toEqual(t);
  });

  it('darwin: one directory for every edition, and no registry key', () => {
    const t = nmManifestTargets({ platform: 'darwin', home: '/Users/u', env: {}, exists: never, all: true });
    expect(files(t)).toEqual(['/Users/u/Library/Application Support/Mozilla/NativeMessagingHosts/inari_mcp.json']);
    expect(t[0].registryKey).toBeUndefined();
    expect(t[0].id).toBe('macos');
  });

  it('linux: only ~/.mozilla when nothing else is detected', () => {
    const t = nmManifestTargets({ platform: 'linux', home: '/home/u', env: {}, exists: never });
    expect(files(t)).toEqual(['/home/u/.mozilla/native-messaging-hosts/inari_mcp.json']);
  });

  it('linux: XDG uses $XDG_CONFIG_HOME when absolute and ~/.config otherwise', () => {
    const xdg = (env: Record<string, string>, present: string) =>
      files(nmManifestTargets({ platform: 'linux', home: '/home/u', env, exists: (p: string) => p === present }));

    expect(xdg({ XDG_CONFIG_HOME: '/custom/cfg' }, '/custom/cfg/mozilla'))
      .toContain('/custom/cfg/mozilla/native-messaging-hosts/inari_mcp.json');
    // relative value: ignored, ~/.config is used instead
    expect(xdg({ XDG_CONFIG_HOME: 'relative/cfg' }, '/home/u/.config/mozilla'))
      .toContain('/home/u/.config/mozilla/native-messaging-hosts/inari_mcp.json');
    expect(xdg({}, '/home/u/.config/mozilla'))
      .toContain('/home/u/.config/mozilla/native-messaging-hosts/inari_mcp.json');
    // the directory is not there: no XDG target
    expect(xdg({ XDG_CONFIG_HOME: '/custom/cfg' }, '/nowhere')).toHaveLength(1);
  });

  it('linux: Snap is added for ~/snap/firefox or /snap/firefox', () => {
    for (const present of ['/home/u/snap/firefox', '/snap/firefox']) {
      const t = nmManifestTargets({ platform: 'linux', home: '/home/u', env: {}, exists: (p: string) => p === present });
      expect(ids(t)).toEqual(['linux', 'snap']);
      expect(files(t)[1]).toBe('/home/u/snap/firefox/common/.mozilla/native-messaging-hosts/inari_mcp.json');
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
      expect(files(t)[1]).toBe('/home/u/.var/app/org.mozilla.firefox/.mozilla/native-messaging-hosts/inari_mcp.json');
    }
  });

  it('linux: `all` returns every location without probing the file system (uninstall)', () => {
    const t = nmManifestTargets({ platform: 'linux', home: '/home/u', env: {}, exists: never, all: true });
    expect(ids(t)).toEqual(['linux', 'linux-xdg', 'snap', 'flatpak:org.mozilla.firefox']);
    expect(files(t)).toEqual([
      '/home/u/.mozilla/native-messaging-hosts/inari_mcp.json',
      '/home/u/.config/mozilla/native-messaging-hosts/inari_mcp.json',
      '/home/u/snap/firefox/common/.mozilla/native-messaging-hosts/inari_mcp.json',
      '/home/u/.var/app/org.mozilla.firefox/.mozilla/native-messaging-hosts/inari_mcp.json',
    ]);
    // `all` honours $XDG_CONFIG_HOME too
    const xdg = nmManifestTargets({ platform: 'linux', home: '/home/u', env: { XDG_CONFIG_HOME: '/cfg' }, exists: never, all: true });
    expect(files(xdg)[1]).toBe('/cfg/mozilla/native-messaging-hosts/inari_mcp.json');
  });

  it('names every manifest file inari_mcp.json', () => {
    for (const platform of ['win32', 'darwin', 'linux']) {
      const home = platform === 'win32' ? 'C:\\Users\\u' : '/home/u';
      for (const t of nmManifestTargets({ platform, home, env: {}, exists: never, all: true })) {
        expect(path.basename(t.file.replace(/\\/g, '/'))).toBe(`${HOST_NAME}.json`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Manual steps
// ---------------------------------------------------------------------------

describe('manual steps (--help / --manual)', () => {
  it("quotes this machine's paths for the shell, even with a space and a single quote", () => {
    const dataDir = "/home/my user/it's/.inari-mcp";
    const q = "'/home/my user/it'\\''s/.inari-mcp'";
    const v = { repoRoot: '/src/Inari MCP', nodePath: '/opt/node 20/bin/node', dataDir };
    const uninstall = manualForPlatform('uninstall', 'linux', v);
    expect(uninstall).toContain(`rm -rf ${q}/native-host\``);
    expect(uninstall).toContain(`rm -rf ${q}\` (API token`);
    expect(uninstall).toContain("'/opt/node 20/bin/node' '/src/Inari MCP'/packages/mcp-server/dist/index.js --stop-daemon");
    const install = manualForPlatform('install', 'darwin', v);
    expect(install).toContain(`mkdir -p ${q}/native-host && chmod 700 ${q} ${q}/native-host`);
    expect(install).toContain("cd '/src/Inari MCP'/packages/native-host || exit 1");
    // the real path never appears unquoted
    expect(uninstall + install).not.toContain(` ${dataDir}`);
  });

  it('uses "$HOME/.inari-mcp" as the placeholder and the configured port', () => {
    const md = manualMarkdown('uninstall');
    expect(md).toContain('rm -rf "$HOME/.inari-mcp"/native-host');
    expect(md).not.toContain('~/.inari-mcp/native-host`');
    expect(md).toContain('lsof -tiTCP:8785');
    const v = { repoRoot: '/r', nodePath: '/n', dataDir: '/d', port: 9999 };
    expect(manualForPlatform('uninstall', 'linux', v)).toContain('lsof -tiTCP:9999');
    expect(manualForPlatform('uninstall', 'win32', v)).toContain('findstr :9999');
  });
});

// ---------------------------------------------------------------------------
// The reference manifest shipped in the repository
// ---------------------------------------------------------------------------

describe('packages/native-host/inari_mcp.json (manual-setup template)', () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const template = JSON.parse(fs.readFileSync(path.join(repoRoot, 'packages', 'native-host', 'inari_mcp.json'), 'utf8'));
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
