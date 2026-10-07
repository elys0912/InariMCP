/**
 * Starting the daemon outside Firefox's job object, with fallbacks.
 *
 * Order: PowerShell (breakaway.ts, CREATE_BREAKAWAY_FROM_JOB) → WMI → a
 * one-off Task Scheduler task → `ok: false` (the caller then starts the
 * daemon inside the job, with a warning).
 *
 * The two PowerShell-free routes start a small Node "trampoline" from a
 * process that is not in Firefox's job (WmiPrvSE / the task service), and the
 * trampoline spawns the daemon. Neither needs the job to allow breakaway.
 * Node alone cannot do it: libuv's `detached` never sets
 * CREATE_BREAKAWAY_FROM_JOB, and `cmd /c start` or conhost stay in the job.
 *
 * Neither route passes Firefox's environment on, so the FOX_* settings, the
 * log path and the cwd travel in a one-shot spec file, which the trampoline
 * deletes as soon as the daemon is spawned (that is also the "started" signal).
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ENV_PREFIX, LEGACY_ENV, shortId } from '@kitsune-mcp/shared';
import { spawnDaemonBreakaway } from './breakaway.js';

/** What to start outside the job. */
export interface DaemonSpec {
  exe: string;
  args: string[];
  /** Variables the daemon needs (Firefox's environment is not passed on). */
  env: Record<string, string>;
  /** stderr of the daemon is appended here. */
  log: string;
  cwd?: string;
}

export interface RunResult { code: number | null; stdout: string; stderr: string }
export type Runner = (cmd: string, args: string[], opts?: { timeoutMs?: number }) => Promise<RunResult>;

/** Everything the strategies touch outside themselves, replaceable in tests. */
export interface OutsideJobDeps {
  run: Runner;
  fs: Pick<typeof fs, 'writeFileSync' | 'existsSync' | 'unlinkSync' | 'mkdirSync'>;
  /** Directory for the spec / trampoline / script files. */
  dir: string;
  sleep(ms: number): Promise<void>;
  /** Unique suffix for file and task names. */
  id: string;
}

export interface Strategy {
  name: string;
  start(spec: DaemonSpec, deps: OutsideJobDeps): Promise<void>;
}

export type OutsideJobResult = { ok: true; via: string } | { ok: false; errors: string[] };

/** How long a route waits for the trampoline to consume the spec file. */
const TRAMPOLINE_WAIT_MS = 10_000;
const POLL_MS = 100;
/** Time limit of each cscript / schtasks command. */
const RUN_TIMEOUT_MS = 20_000;

/**
 * Read the spec, start the daemon, then delete the spec (= "started"). When
 * the spec cannot be read or the daemon cannot be spawned (no pid) the spec is
 * left in place, so the caller times out and moves on to the next route.
 */
export const TRAMPOLINE_JS = `const fs = require('fs');
const { spawn } = require('child_process');
const specPath = process.argv[2];
const s = JSON.parse(fs.readFileSync(specPath, 'utf8'));
let fd = 'ignore';
try { fd = fs.openSync(s.log, 'a'); } catch (e) {}
const opts = { env: Object.assign({}, process.env, s.env), detached: true, windowsHide: true, stdio: ['ignore', 'ignore', fd] };
if (s.cwd) opts.cwd = s.cwd;
const child = spawn(s.exe, s.args, opts);
child.on('error', () => {});
child.unref();
if (child.pid) { try { fs.unlinkSync(specPath); } catch (e) {} }
`;

/** Delete files in `dir` older than `maxAgeMs` (leftovers of an interrupted start). Never throws. */
export function sweepRunDir(dir: string, maxAgeMs = 10 * 60_000, now = Date.now()): void {
  try {
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      try {
        if (now - fs.statSync(file).mtimeMs > maxAgeMs) fs.unlinkSync(file);
      } catch { /* vanished or locked */ }
    }
  } catch { /* no such directory */ }
}

/** WMI creates the process under WmiPrvSE, i.e. outside any job of ours. */
const WMI_VBS = `cmd = ""
For Each a In WScript.Arguments
  cmd = cmd & """" & a & """ "
Next
Set svc = CreateObject("WbemScripting.SWbemLocator").ConnectServer(".", "root\\cimv2")
Set su = svc.Get("Win32_ProcessStartup").SpawnInstance_
su.ShowWindow = 0
r = svc.Get("Win32_Process").Create(cmd, Null, su, pid)
WScript.Quit r
`;

function xmlEscape(text: string): string {
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Task definition: on demand only, no time limit, same user, not elevated. */
export function taskXml(command: string, args: string[]): string {
  const quoted = args.map((a) => `"${a}"`).join(' ');
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
<Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
<Settings><MultipleInstancesPolicy>Parallel</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Hidden>true</Hidden><Enabled>true</Enabled><AllowStartOnDemand>true</AllowStartOnDemand></Settings>
<Actions Context="Author"><Exec><Command>${xmlEscape(command)}</Command><Arguments>${xmlEscape(quoted)}</Arguments></Exec></Actions></Task>`;
}

/** Write the trampoline and the spec; returns their paths. */
function prepare(spec: DaemonSpec, deps: OutsideJobDeps): { tramp: string; specPath: string } {
  deps.fs.mkdirSync(deps.dir, { recursive: true, mode: 0o700 });
  const tramp = path.join(deps.dir, `trampoline-${deps.id}.js`);
  const specPath = path.join(deps.dir, `spec-${deps.id}.json`);
  deps.fs.writeFileSync(tramp, TRAMPOLINE_JS);
  deps.fs.writeFileSync(specPath, JSON.stringify(spec), { mode: 0o600 });
  return { tramp, specPath };
}

function cleanup(deps: OutsideJobDeps, ...files: string[]): void {
  for (const f of files) {
    try { deps.fs.unlinkSync(f); } catch { /* already gone */ }
  }
}

/** Wait until the trampoline has deleted the spec file, i.e. has spawned the daemon. */
async function waitConsumed(specPath: string, deps: OutsideJobDeps): Promise<void> {
  for (let waited = 0; waited < TRAMPOLINE_WAIT_MS; waited += POLL_MS) {
    if (!deps.fs.existsSync(specPath)) return;
    await deps.sleep(POLL_MS);
  }
  throw new Error('the trampoline did not start the daemon in time');
}

function failure(what: string, r: RunResult): Error {
  const detail = (r.stderr || r.stdout).trim().split(/\r?\n/).slice(0, 2).join(' ');
  return new Error(`${what} failed (exit code ${r.code ?? 'null'}${detail ? `: ${detail}` : ''})`);
}

export const wmiStrategy: Strategy = {
  name: 'wmi',
  async start(spec, deps) {
    const { tramp, specPath } = prepare(spec, deps);
    const vbs = path.join(deps.dir, `spawn-${deps.id}.vbs`);
    deps.fs.writeFileSync(vbs, WMI_VBS);
    try {
      const r = await deps.run(
        'cscript.exe',
        ['//B', '//nologo', vbs, process.execPath, tramp, specPath],
        { timeoutMs: RUN_TIMEOUT_MS },
      );
      if (r.code !== 0) throw failure('WMI Win32_Process.Create', r);
      await waitConsumed(specPath, deps);
    } finally {
      cleanup(deps, vbs, tramp, specPath);
    }
  },
};

export const schtasksStrategy: Strategy = {
  name: 'schtasks',
  async start(spec, deps) {
    const { tramp, specPath } = prepare(spec, deps);
    const xml = path.join(deps.dir, `task-${deps.id}.xml`);
    const name = `KitsuneMCP-daemon-${deps.id}`;
    // schtasks wants UTF-16LE with a BOM
    deps.fs.writeFileSync(xml, Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(taskXml(process.execPath, [tramp, specPath]), 'utf16le'),
    ]));
    let created = false;
    try {
      const c = await deps.run('schtasks.exe', ['/Create', '/F', '/TN', name, '/XML', xml], { timeoutMs: RUN_TIMEOUT_MS });
      if (c.code !== 0) throw failure('schtasks /Create', c);
      created = true;
      const r = await deps.run('schtasks.exe', ['/Run', '/TN', name], { timeoutMs: RUN_TIMEOUT_MS });
      if (r.code !== 0) throw failure('schtasks /Run', r);
      await waitConsumed(specPath, deps);
    } finally {
      // The daemon keeps running when its task is deleted.
      if (created) {
        await deps.run('schtasks.exe', ['/Delete', '/F', '/TN', name], { timeoutMs: RUN_TIMEOUT_MS })
          .catch(() => undefined);
      }
      cleanup(deps, xml, tramp, specPath);
    }
  },
};

/** The PowerShell route (breakaway.ts) as a strategy; it inherits this process's environment. */
export const powershellStrategy: Strategy = {
  name: 'powershell',
  async start(spec) {
    await spawnDaemonBreakaway(spec.args[0] ?? '', spec.log, spec.cwd);
  },
};

/**
 * Start the daemon outside the job object with the first route that works.
 * `{ ok: false }` means every route failed; the caller decides what to do.
 */
export async function startOutsideJob(
  spec: DaemonSpec,
  deps: OutsideJobDeps,
  order: Strategy[] = [powershellStrategy, wmiStrategy, schtasksStrategy],
): Promise<OutsideJobResult> {
  const errors: string[] = [];
  for (const strategy of order) {
    try {
      await strategy.start(spec, deps);
      return { ok: true, via: strategy.name };
    } catch (err: unknown) {
      errors.push(`${strategy.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { ok: false, errors };
}

/** FOX_* settings (and the legacy names) of `env`, for the spec file. */
export function daemonEnvFrom(env: NodeJS.ProcessEnv): Record<string, string> {
  const legacy = new Set<string>(Object.values(LEGACY_ENV));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && (k.startsWith(ENV_PREFIX) || legacy.has(k))) out[k] = v;
  }
  return out;
}

const defaultRunner: Runner = (cmd, args, opts) =>
  new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: opts?.timeoutMs ?? RUN_TIMEOUT_MS }, (err, stdout, stderr) => {
      // err.code: the exit code (number), or a spawn error such as 'ENOENT' (string)
      const raw: unknown = err?.code;
      const code = err === null ? 0 : typeof raw === 'number' ? raw : null;
      resolve({
        code,
        stdout: String(stdout),
        stderr: err !== null && code === null ? err.message : String(stderr),
      });
    });
  });

export function defaultDeps(dir: string): OutsideJobDeps {
  return {
    run: defaultRunner,
    fs,
    dir,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    id: `${process.pid}-${shortId()}`,
  };
}
