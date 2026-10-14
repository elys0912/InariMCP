import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ENV_DEFAULTS } from '@inari-mcp/shared';
import {
  DAEMON_SETTING_KEYS,
  daemonSettingsFromInfo,
  diffDaemonSettings,
  effectiveDaemonSettings,
} from '../src/utils/endpoint.js';
import { loadConfig } from '../src/safety/config.js';

// Unsigned /daemon/info (daemon-client checkSettings → null / []): daemon-client.test.ts

describe('effective daemon settings', () => {
  it('FOX_HEADLESS true / 1 / yes compare equal', () => {
    const variants = [{ FOX_HEADLESS: 'true' }, { FOX_HEADLESS: '1' }, { FOX_HEADLESS: ' yes ' }];
    for (const env of variants) {
      expect(effectiveDaemonSettings(env).FOX_HEADLESS).toBe('on');
    }
    expect(diffDaemonSettings(effectiveDaemonSettings(variants[1]!), effectiveDaemonSettings(variants[2]!))).toEqual([]);
  });

  // InariMCP (AMO): the CLAUDE_BROWSER_* names of the fork are not read.
  it('the old CLAUDE_BROWSER_* names are no settings, in the session or in raw daemon settings', () => {
    expect(effectiveDaemonSettings({ CLAUDE_BROWSER_HEADLESS: '1', CLAUDE_BROWSER_READ_ONLY: '1' }))
      .toEqual(effectiveDaemonSettings({}));
    const theirs = daemonSettingsFromInfo({
      settings: { FOX_READ_ONLY: '', CLAUDE_BROWSER_READ_ONLY: '1', FOX_SAFETY_CONFIG: '', CLAUDE_BROWSER_SAFETY_CONFIG: 'strict.json' },
    })!;
    expect(theirs.FOX_READ_ONLY).toBe('off');
    expect(theirs.FOX_SAFETY_CONFIG).toBe('');
    expect(DAEMON_SETTING_KEYS.filter((k) => !k.startsWith('FOX_'))).toEqual([]);
  });

  it('an old daemon (raw settings only) is compared by how it read them', () => {
    // it read FOX_READ_ONLY=true as "not 1" = off; this session means it as on
    const theirs = daemonSettingsFromInfo({ settings: { FOX_READ_ONLY: 'true' } });
    const diffs = diffDaemonSettings(effectiveDaemonSettings({ FOX_READ_ONLY: 'true' }), theirs!);
    expect(diffs).toEqual(["FOX_READ_ONLY: this session 'on', daemon 'off'"]);
  });

  it('a daemon that sends effectiveSettings is believed, its raw settings are not re-read', () => {
    // raw settings say read-only and headless; the daemon's own answer says off
    const theirs = daemonSettingsFromInfo({
      settings: { FOX_READ_ONLY: '1', FOX_HEADLESS: '1', FOX_SAFETY_CONFIG: 'strict.json' },
      effectiveSettings: {
        ...effectiveDaemonSettings({}),
        FOX_READ_ONLY: 'off',
        FOX_HEADLESS: 'off',
        FOX_SAFETY_CONFIG: '',
      },
    })!;
    expect(theirs.FOX_READ_ONLY).toBe('off');
    expect(theirs.FOX_HEADLESS).toBe('off');
    expect(theirs.FOX_SAFETY_CONFIG).toBe('');
    expect(diffDaemonSettings(effectiveDaemonSettings({}), theirs)).toEqual([]);
  });

  it('a setting this version does not have (FOX_ALLOW_SCRIPTS of an older daemon) is no difference', () => {
    const theirs = daemonSettingsFromInfo({
      settings: { FOX_ALLOW_SCRIPTS: '0' },
      effectiveSettings: { ...effectiveDaemonSettings({}), FOX_ALLOW_SCRIPTS: 'off' },
    })!;
    expect(theirs).not.toHaveProperty('FOX_ALLOW_SCRIPTS');
    expect(diffDaemonSettings(effectiveDaemonSettings({ FOX_ALLOW_SCRIPTS: '0' }), theirs)).toEqual([]);
  });

  it('falls back to the legacy reading for keys effectiveSettings leaves out or sends unparsed', () => {
    const theirs = daemonSettingsFromInfo({
      settings: { FOX_READ_ONLY: '1', FOX_HEADLESS: '1', FOX_SAFETY_CONFIG: 'strict.json' },
      effectiveSettings: {
        // non-string: ignored, the raw settings decide
        FOX_READ_ONLY: 1,
        // FOX_HEADLESS missing entirely: likewise
        FOX_EXECUTABLE: '/opt/firefox',
      },
    })!;
    expect(theirs.FOX_READ_ONLY).toBe('on');
    expect(theirs.FOX_HEADLESS).toBe('on');
    expect(theirs.FOX_SAFETY_CONFIG).toBe('strict.json');
    expect(theirs.FOX_EXECUTABLE).toBe('/opt/firefox');

    // an effectiveSettings that is not an object at all is ignored wholesale
    const bad = daemonSettingsFromInfo({
      settings: { FOX_READ_ONLY: '1' },
      effectiveSettings: 'yes',
    })!;
    expect(bad.FOX_READ_ONLY).toBe('on');
  });

  it('a blank FOX_ value is unset; a string setting is trimmed', () => {
    expect(effectiveDaemonSettings({ FOX_READ_ONLY: ' ' }).FOX_READ_ONLY).toBe('off');
    expect(effectiveDaemonSettings({ FOX_EXECUTABLE: ' /a/firefox ' }).FOX_EXECUTABLE).toBe('/a/firefox');
    expect(effectiveDaemonSettings({ FOX_EXECUTABLE: ' ' }).FOX_EXECUTABLE).toBe('');
  });

  it('every accepted spelling of on / off compares equal', () => {
    for (const v of ['1', 'true', 'yes', 'TRUE', ' Yes ']) {
      expect(effectiveDaemonSettings({ FOX_READ_ONLY: v }).FOX_READ_ONLY).toBe('on');
      expect(diffDaemonSettings(
        effectiveDaemonSettings({ FOX_READ_ONLY: v }),
        effectiveDaemonSettings({ FOX_READ_ONLY: '1' }),
      )).toEqual([]);
    }
    // anything else leaves read-only off
    for (const v of ['0', 'false', 'no', 'off', '', 'on']) {
      expect(effectiveDaemonSettings({ FOX_READ_ONLY: v }).FOX_READ_ONLY).toBe('off');
    }
  });

  it('FOX_APPROVAL_ELICITATION: unset and blank mean the default, the rest is on unless turned off', () => {
    const def = ENV_DEFAULTS.FOX_APPROVAL_ELICITATION ? 'on' : 'off';
    for (const env of [{}, { FOX_APPROVAL_ELICITATION: '' }, { FOX_APPROVAL_ELICITATION: '   ' }]) {
      expect(effectiveDaemonSettings(env).FOX_APPROVAL_ELICITATION).toBe(def);
    }
    expect(effectiveDaemonSettings({ FOX_APPROVAL_ELICITATION: 'on' }).FOX_APPROVAL_ELICITATION).toBe('on');
    for (const v of ['0', 'false', 'off', 'no', 'OFF']) {
      expect(effectiveDaemonSettings({ FOX_APPROVAL_ELICITATION: v }).FOX_APPROVAL_ELICITATION).toBe('off');
    }
    expect(diffDaemonSettings(
      effectiveDaemonSettings({}),
      effectiveDaemonSettings({ FOX_APPROVAL_ELICITATION: '  ' }),
    )).toEqual([]);
  });

  it('FOX_HEADLESS_STARTUP_TIMEOUT: the default spelled out, and bad values, compare equal to unset', () => {
    const def = String(ENV_DEFAULTS.FOX_HEADLESS_STARTUP_TIMEOUT);
    expect(effectiveDaemonSettings({}).FOX_HEADLESS_STARTUP_TIMEOUT).toBe(def);
    expect(effectiveDaemonSettings({ FOX_HEADLESS_STARTUP_TIMEOUT: def }).FOX_HEADLESS_STARTUP_TIMEOUT)
      .toBe(def);
    for (const v of ['abc', '-5', '0']) {
      expect(effectiveDaemonSettings({ FOX_HEADLESS_STARTUP_TIMEOUT: v }).FOX_HEADLESS_STARTUP_TIMEOUT)
        .toBe(def);
      expect(diffDaemonSettings(
        effectiveDaemonSettings({ FOX_HEADLESS_STARTUP_TIMEOUT: v }),
        effectiveDaemonSettings({}),
      )).toEqual([]);
    }
    // a real difference is still reported
    expect(diffDaemonSettings(
      effectiveDaemonSettings({ FOX_HEADLESS_STARTUP_TIMEOUT: '1234' }),
      effectiveDaemonSettings({}),
    )).toEqual([`FOX_HEADLESS_STARTUP_TIMEOUT: this session '1234', daemon '${def}'`]);
  });
});

describe('loadConfig reads the same accepted values', () => {
  const dirs: string[] = [];

  afterEach(() => {
    vi.unstubAllEnvs();
    while (dirs.length > 0) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  function load(env: Record<string, string>) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inari-settings-'));
    dirs.push(dir);
    const file = path.join(dir, 'safety.json');
    fs.writeFileSync(file, '{ "read_only": false }');
    // Keep ~/.inari-mcp of the real home out of reach.
    vi.stubEnv('HOME', dir);
    vi.stubEnv('USERPROFILE', dir);
    vi.stubEnv('FOX_SAFETY_CONFIG', file);
    vi.stubEnv('FOX_READ_ONLY', '');
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    return loadConfig();
  }

  it.each(['1', 'true', 'yes', 'TRUE', ' Yes '])('FOX_READ_ONLY=%j turns read-only on', (v) => {
    expect(load({ FOX_READ_ONLY: v }).readOnly).toBe(true);
  });

  it.each(['0', 'false', 'no', 'off', '', 'on'])('FOX_READ_ONLY=%j leaves the file value', (v) => {
    expect(load({ FOX_READ_ONLY: v }).readOnly).toBe(false);
  });

  it('the old CLAUDE_BROWSER_READ_ONLY is not read', () => {
    expect(load({ CLAUDE_BROWSER_READ_ONLY: 'yes' }).readOnly).toBe(false);
  });

  it('matches what a relay would report for the same environment', () => {
    const env = { FOX_READ_ONLY: 'TRUE' };
    const cfg = load(env);
    const eff = effectiveDaemonSettings(env);
    expect(eff.FOX_READ_ONLY).toBe(cfg.readOnly ? 'on' : 'off');
  });
});
