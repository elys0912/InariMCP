/**
 * scripts/install.mjs / scripts/uninstall.mjs run end to end in a temp home.
 *
 * Nothing here registers anything: the registry, processes, the network and
 * Claude Code are stubbed, and file-system work happens in a temp directory.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  CLAUDE_NAME, WIN_REG_KEY, buildManifest, buildWrapper, dataPaths, nmManifestTargets, serializeJson,
} from '../../scripts/lib/core.mjs';
import { httpGet } from '../../scripts/lib/system.mjs';
import { runInstall } from '../../scripts/install.mjs';
import { runUninstall } from '../../scripts/uninstall.mjs';
import { isWin, useTempDir } from './helpers/test-env.js';

const tmp = useTempDir();

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
    const home = path.join(tmp(), 'home');
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
    const home = path.join(tmp(), 'home');
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
    home = path.join(tmp(), 'home');
    fs.mkdirSync(home);
    repoRoot = fakeRepo(path.join(tmp(), 'repo'));
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
    home = path.join(tmp(), 'home');
    fs.mkdirSync(home);
    repoRoot = fakeRepo(path.join(tmp(), 'repo'));
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
  // TODO(test): stopDaemonGracefully outcomes (stopped / refused / unanswered / still-running) and the uninstall daemon branch
});
