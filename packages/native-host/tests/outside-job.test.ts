import { describe, expect, it, vi } from 'vitest';
import {
  daemonEnvFrom,
  schtasksStrategy,
  startOutsideJob,
  taskXml,
  wmiStrategy,
  type DaemonSpec,
  type OutsideJobDeps,
  type RunResult,
  type Strategy,
} from '../src/outside-job.js';

const spec: DaemonSpec = {
  exe: 'node.exe',
  args: [String.raw`C:\a b\index.js`, '--daemon'],
  env: { FOX_HTTP_PORT: '1' },
  log: String.raw`C:\logs\daemon.log`,
};

interface Harness {
  deps: OutsideJobDeps;
  calls: { cmd: string; args: string[] }[];
  files: Map<string, string | Buffer>;
}

/** Fake filesystem + runner; `consume` makes the trampoline delete the spec once a run happens. */
function harness(results: Record<string, RunResult>, consume = true): Harness {
  const files = new Map<string, string | Buffer>();
  const calls: { cmd: string; args: string[] }[] = [];
  const deps: OutsideJobDeps = {
    dir: String.raw`D:\run`,
    id: 'T1',
    sleep: async () => {},
    fs: {
      mkdirSync: (() => undefined) as never,
      writeFileSync: ((p: string, d: string | Buffer) => { files.set(p, d); }) as never,
      existsSync: ((p: string) => files.has(p)) as never,
      unlinkSync: ((p: string) => { files.delete(p); }) as never,
    },
    run: async (cmd, args) => {
      calls.push({ cmd, args });
      const key = cmd === 'schtasks.exe' ? `schtasks ${args[0]}` : cmd;
      const r = results[key] ?? { code: 0, stdout: '', stderr: '' };
      if (r.code === 0 && consume && (key === 'cscript.exe' || key === 'schtasks /Run')) {
        for (const f of [...files.keys()]) if (f.includes('spec-')) files.delete(f);
      }
      return r;
    },
  };
  return { deps, calls, files };
}

const ok: RunResult = { code: 0, stdout: '', stderr: '' };
const bad = (stderr: string): RunResult => ({ code: 1, stdout: '', stderr });

describe('wmiStrategy', () => {
  it('runs cscript with the script, node, trampoline and spec, then cleans up', async () => {
    const h = harness({});
    await wmiStrategy.start(spec, h.deps);
    expect(h.calls).toHaveLength(1);
    const { cmd, args } = h.calls[0]!;
    expect(cmd).toBe('cscript.exe');
    expect(args.slice(0, 2)).toEqual(['//B', '//nologo']);
    expect(args[2]).toMatch(/spawn-T1\.vbs$/);
    expect(args[4]).toMatch(/trampoline-T1\.js$/);
    expect(args[5]).toMatch(/spec-T1\.json$/);
    expect(h.files.size).toBe(0);
  });

  it('fails when cscript fails, and still removes its files', async () => {
    const h = harness({ 'cscript.exe': bad('disabled') });
    await expect(wmiStrategy.start(spec, h.deps)).rejects.toThrow(/WMI.*disabled/);
    expect(h.files.size).toBe(0);
  });

  it('fails when the trampoline never consumes the spec', async () => {
    const h = harness({}, false);
    await expect(wmiStrategy.start(spec, h.deps)).rejects.toThrow(/did not start/);
    expect(h.files.size).toBe(0);
  });
});

describe('schtasksStrategy', () => {
  it('creates from XML, runs, then always deletes the task', async () => {
    const h = harness({});
    await schtasksStrategy.start(spec, h.deps);
    expect(h.calls.map((c) => c.args[0])).toEqual(['/Create', '/Run', '/Delete']);
    expect(h.calls[0]!.args).toEqual(expect.arrayContaining(['/F', '/TN', 'KitsuneMCP-daemon-T1', '/XML']));
    expect(h.files.size).toBe(0);
  });

  it('writes the XML as UTF-16LE with a BOM', async () => {
    const h = harness({ 'schtasks /Create': bad('nope') });
    const write = vi.spyOn(h.deps.fs, 'writeFileSync');
    await expect(schtasksStrategy.start(spec, h.deps)).rejects.toThrow();
    const xmlCall = write.mock.calls.find((c) => String(c[0]).endsWith('.xml'))!;
    const buf = xmlCall[1] as Buffer;
    expect([buf[0], buf[1]]).toEqual([0xff, 0xfe]);
    expect(buf.subarray(2).toString('utf16le')).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>');
  });

  it('does not delete a task that was never created', async () => {
    const h = harness({ 'schtasks /Create': bad('access denied') });
    await expect(schtasksStrategy.start(spec, h.deps)).rejects.toThrow(/Create.*access denied/);
    expect(h.calls.map((c) => c.args[0])).toEqual(['/Create']);
  });

  it('deletes the task when /Run fails', async () => {
    const h = harness({ 'schtasks /Run': bad('x') });
    await expect(schtasksStrategy.start(spec, h.deps)).rejects.toThrow();
    expect(h.calls.map((c) => c.args[0])).toEqual(['/Create', '/Run', '/Delete']);
  });
});

describe('taskXml', () => {
  it('escapes and quotes the arguments', () => {
    const xml = taskXml(String.raw`C:\n&n\node.exe`, [String.raw`C:\a\t.js`, String.raw`C:\b\s.json`]);
    expect(xml).toContain(String.raw`<Command>C:\n&amp;n\node.exe</Command>`);
    expect(xml).toContain(String.raw`<Arguments>&quot;C:\a\t.js&quot; &quot;C:\b\s.json&quot;</Arguments>`);
    expect(xml).toContain('<RunLevel>LeastPrivilege</RunLevel>');
  });
});

describe('startOutsideJob', () => {
  const named = (name: string, fn: () => Promise<void>): Strategy => ({ name, start: fn });

  it('uses the first route that works', async () => {
    const second = vi.fn(async () => {});
    const r = await startOutsideJob(spec, harness({}).deps, [
      named('a', async () => { throw new Error('no powershell'); }),
      named('b', second),
      named('c', async () => { throw new Error('unused'); }),
    ]);
    expect(r).toEqual({ ok: true, via: 'b' });
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('reports every error when all routes fail', async () => {
    const r = await startOutsideJob(spec, harness({}).deps, [
      named('a', async () => { throw new Error('one'); }),
      named('b', async () => { throw new Error('two'); }),
    ]);
    expect(r).toEqual({ ok: false, errors: ['a: one', 'b: two'] });
  });
});

describe('daemonEnvFrom', () => {
  it('keeps FOX_* and legacy names, drops the rest', () => {
    const env = daemonEnvFrom({
      FOX_HTTP_PORT: '1',
      CLAUDE_BROWSER_HTTP_PORT: '2',
      PATH: 'x',
      SECRET_TOKEN: 'y',
      FOX_EMPTY: undefined,
    });
    expect(env).toEqual({ FOX_HTTP_PORT: '1', CLAUDE_BROWSER_HTTP_PORT: '2' });
  });
});
