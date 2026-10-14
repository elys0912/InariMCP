import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SafetyGuard } from '../src/safety/guard.js';
import { DEFAULT_CONFIG, loadConfig, type LoadedSafetyConfig } from '../src/safety/config.js';

// loadConfig (safety/config.ts), moved out of guard.test.ts (G-22). The
// guard is used only to show that a config error refuses every tool.

describe('loadConfig (2.B2)', () => {
  let dir: string;
  let stderr: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inari-guard-'));
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    stderr.mockRestore();
    vi.unstubAllEnvs();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function load(content: string | null): LoadedSafetyConfig {
    const file = path.join(dir, 'safety.json');
    if (content !== null) fs.writeFileSync(file, content);
    // Keep ~/.inari-mcp of the real home out of reach.
    vi.stubEnv('HOME', dir);
    vi.stubEnv('USERPROFILE', dir);
    vi.stubEnv('FOX_SAFETY_CONFIG', file);
    vi.stubEnv('FOX_READ_ONLY', '');
    return loadConfig();
  }

  it.each([
    ['invalid JSON', '{ "read_only": true,'],
    ['not an object', '[]'],
    ['a schema violation', '{ "max_actions_per_minute": "many" }'],
    // An empty container name would attach a scope the Extension
    // cannot use; with the scope off it is still a broken setting.
    ['an empty container name', '{ "container_scope": { "enabled": true, "container_name": "" } }'],
    ['an empty container name (scope off)', '{ "container_scope": { "enabled": false, "container_name": "" } }'],
    ['an empty containerName (camelCase)', '{ "container_scope": { "enabled": true, "containerName": "" } }'],
  ])('reports %s as configError', (_label, content) => {
    const cfg = load(content);
    expect(cfg.configError).toBeTruthy();
    expect(new SafetyGuard({ ...cfg, auditLog: false }).check('fox_screenshot', {})?.safetyDecision)
      .toBe('config_error');
  });

  it('loads a valid file without configError', () => {
    const cfg = load('{ "read_only": true, "blocked_url_patterns": ["blocked.test"], "confirm_read_sites": ["bank.test"] }');
    expect(cfg.configError).toBeUndefined();
    expect(cfg.readOnly).toBe(true);
    expect(cfg.blockedUrlPatterns).toEqual(['blocked.test']);
    expect(cfg.confirmReadSites).toEqual(['bank.test']);
  });

  it('writes confirm_read_sites (empty) and no protected-site keys as the defaults', () => {
    load(null);
    const written = JSON.parse(fs.readFileSync(path.join(dir, 'safety.json'), 'utf-8')) as Record<string, unknown>;
    expect(written['confirm_read_sites']).toEqual([]);
    expect(written).not.toHaveProperty('protected_url_patterns');
    expect(written).not.toHaveProperty('confirm_protected_actions');
  });

  // R2-B S-1: an unknown key used to be dropped, so the setting the user meant
  // to tighten did not apply (fail-open).
  it.each([
    ['a misspelt key', '{ "readonly": true }', 'readonly'],
    ['a key that does not exist', '{ "allow_scripts": false }', 'allow_scripts'],
    // InariMCP removed the script tools: their switch is no key any more.
    ['the removed allow_script_execution', '{ "allow_script_execution": true }', 'allow_script_execution'],
    // Acting tools always ask the human, so the protected-site list and its switch are gone.
    ['the removed protected_url_patterns', '{ "protected_url_patterns": ["bank.test"] }', 'protected_url_patterns'],
    ['the removed confirm_protected_actions', '{ "confirm_protected_actions": false }', 'confirm_protected_actions'],
    ['an unknown key in container_scope', '{ "container_scope": { "enable": true } }', 'enable'],
    ['a __proto__ key', '{ "__proto__": { "read_only": true } }', '__proto__'],
  ])('reports %s as configError, naming it', (_label, content, key) => {
    const cfg = load(content);
    expect(cfg.configError).toContain(key);
    expect(new SafetyGuard({ ...cfg, auditLog: false }).check('fox_screenshot', {})?.safetyDecision)
      .toBe('config_error');
  });

  it('names a wrong value by its key in the file', () => {
    expect(load('{ "max_actions_per_minute": "many" }').configError).toContain('max_actions_per_minute:');
    expect(load('{ "container_scope": { "container_name": "" } }').configError).toContain('container_scope.container_name:');
  });

  it('accepts the camelCase spelling of a key as before', () => {
    const cfg = load('{ "readOnly": true, "container_scope": { "containerName": "Work" } }');
    expect(cfg.configError).toBeUndefined();
    expect(cfg.readOnly).toBe(true);
    expect(cfg.containerScope.containerName).toBe('Work');
  });

  // R2-B S-2: a partial container_scope keeps the defaults for the rest
  // (it used to be a config_error: `enabled: Required`).
  it.each([
    ['container_name only', '{ "container_scope": { "container_name": "Foo" } }', { enabled: false, containerName: 'Foo' }],
    ['enabled only', '{ "container_scope": { "enabled": true } }', { enabled: true, containerName: DEFAULT_CONFIG.containerScope.containerName }],
    ['empty', '{ "container_scope": {} }', DEFAULT_CONFIG.containerScope],
  ])('a partial container_scope (%s) takes the defaults for the rest', (_label, content, scope) => {
    const cfg = load(content);
    expect(cfg.configError).toBeUndefined();
    expect(cfg.containerScope).toEqual(scope);
  });

  it('reads a file with a leading BOM', () => {
    const cfg = load('﻿{ "read_only": true }');
    expect(cfg.configError).toBeUndefined();
    expect(cfg.readOnly).toBe(true);
  });

  it('writes the defaults when the file is missing', () => {
    const cfg = load(null);
    expect(cfg.configError).toBeUndefined();
    expect(fs.existsSync(path.join(dir, 'safety.json'))).toBe(true);
    // The file it writes passes the strict schema when read back.
    const again = load(null);
    expect(again.configError).toBeUndefined();
    expect({ ...again }).toEqual({ ...DEFAULT_CONFIG });
  });

  // R2-B L-5: a blank FOX_SAFETY_CONFIG is unset, as for every other daemon
  // setting, so the legacy name is read.
  it('a blank FOX_SAFETY_CONFIG falls through to CLAUDE_BROWSER_SAFETY_CONFIG', () => {
    const file = path.join(dir, 'legacy.json');
    fs.writeFileSync(file, '{ "read_only": true }');
    vi.stubEnv('HOME', dir);
    vi.stubEnv('USERPROFILE', dir);
    vi.stubEnv('FOX_SAFETY_CONFIG', '  ');
    vi.stubEnv('CLAUDE_BROWSER_SAFETY_CONFIG', file);
    vi.stubEnv('FOX_READ_ONLY', '');
    const cfg = loadConfig();
    expect(cfg.configError).toBeUndefined();
    expect(cfg.readOnly).toBe(true);
    // WP-G T-5: fox_safety_status names the file that was read.
    expect(new SafetyGuard(cfg).status().configFile).toBe(file);
  });

  it('WP-G T-5: with both settings blank, fox_safety_status names the default file by its full path', () => {
    vi.stubEnv('HOME', dir);
    vi.stubEnv('USERPROFILE', dir);
    vi.stubEnv('FOX_SAFETY_CONFIG', ' ');
    vi.stubEnv('CLAUDE_BROWSER_SAFETY_CONFIG', '');
    expect(new SafetyGuard({ ...DEFAULT_CONFIG }).status().configFile)
      .toBe(path.join(dir, '.inari-mcp', 'safety.json'));
  });

  // Windows ignores the mode bits (see the WP2 note on 0o600 / 0o700).
  it.skipIf(process.platform === 'win32')('creates a missing config directory 0o700', () => {
    const file = path.join(dir, 'sub', 'safety.json');
    vi.stubEnv('HOME', dir);
    vi.stubEnv('USERPROFILE', dir);
    vi.stubEnv('FOX_SAFETY_CONFIG', file);
    loadConfig();
    expect(fs.statSync(path.join(dir, 'sub')).mode & 0o777).toBe(0o700);
  });
});
