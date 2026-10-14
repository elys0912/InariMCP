/**
 * `node dist/index.js --doctor` (or `inari-mcp doctor`): run the checks of
 * checks.ts with the real environment and print one line per item.
 *
 *   OK    node            v24.16.0 (engines >=20)
 *   WARN  daemon          nothing answers on http://127.0.0.1:8785
 *         fix: normal when unused: ...
 *
 * Exit code 1 when any item FAILs, else 0.
 */

import { spawnSync } from 'node:child_process';
import * as http from 'node:http';
import * as path from 'node:path';

import { resolveHost, resolveHttpPort } from '../utils/endpoint.js';
import { PACKAGE_ROOT, PACKAGE_VERSION } from '../version.js';
import { runChecks, type CheckResult, type DoctorDeps, type HttpReply, type RunResult } from './checks.js';

/**
 * Console output of Windows tools (reg.exe) is in the OEM code page, not
 * UTF-8: fall back to Shift_JIS (cp932) when the bytes are not valid UTF-8.
 */
function decode(buf: Buffer): string {
  const utf8 = buf.toString('utf-8');
  if (!utf8.includes('�')) return utf8;
  try {
    return new TextDecoder('shift_jis').decode(buf);
  } catch {
    return utf8;
  }
}

function run(cmd: string, args: string[], timeoutMs: number): RunResult {
  const r = spawnSync(cmd, args, { timeout: timeoutMs, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  return {
    status: r.status,
    stdout: r.stdout ? decode(r.stdout) : '',
    ...(r.error !== undefined ? { error: r.error.message } : {}),
  };
}

function get(urlPath: string, headers: Record<string, string>, timeoutMs: number): Promise<HttpReply | undefined> {
  return new Promise((resolve) => {
    const req = http.get(
      { host: resolveHost(), port: resolveHttpPort(), path: urlPath, headers, timeout: timeoutMs },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, raw: Buffer.concat(chunks) }));
        res.on('error', () => resolve(undefined));
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(undefined));
  });
}

export function defaultDoctorDeps(): DoctorDeps {
  return {
    platform: process.platform,
    nodeVersion: process.versions.node,
    cwd: process.cwd(),
    // packages/mcp-server → repository root
    repoRoot: path.resolve(PACKAGE_ROOT, '..', '..'),
    run,
    get,
  };
}

export function formatResults(results: readonly CheckResult[]): string {
  const width = Math.max(...results.map((r) => r.id.length));
  const lines: string[] = [];
  for (const r of results) {
    lines.push(`${r.status.padEnd(5)} ${r.id.padEnd(width)}  ${r.detail}`);
    if (r.fix !== undefined && r.status !== 'OK') lines.push(`${' '.repeat(6 + width + 2)}fix: ${r.fix}`);
  }
  const count = (s: CheckResult['status']): number => results.filter((r) => r.status === s).length;
  lines.push('', `${count('OK')} OK, ${count('WARN')} WARN, ${count('FAIL')} FAIL, ${count('SKIP')} SKIP`);
  return lines.join('\n') + '\n';
}

/** Print the report; resolves with the exit code. */
export async function runDoctor(deps: DoctorDeps = defaultDoctorDeps()): Promise<number> {
  const results = await runChecks(deps);
  process.stdout.write(`InariMCP doctor v${PACKAGE_VERSION} (${deps.platform}, node v${deps.nodeVersion})\n\n`);
  process.stdout.write(formatResults(results));
  return results.some((r) => r.status === 'FAIL') ? 1 : 0;
}
