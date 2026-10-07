import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UNKNOWN_VERSION, logStamp, readPackageVersion, stderrLogger } from '@kitsune-mcp/shared/node';

describe('logStamp', () => {
  it('is "<ISO time> [<pid>] " (the line prefix of daemon.log and native-host.log)', () => {
    expect(logStamp(new Date(Date.UTC(2026, 8, 30, 9, 41, 14, 123)), 1234)).toBe('2026-09-30T09:41:14.123Z [1234] ');
    expect(logStamp()).toMatch(new RegExp(`^\\d{4}-\\d\\d-\\d\\dT[\\d:.]+Z \\[${process.pid}\\] $`));
  });
});

describe('stderrLogger', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes "[KitsuneMCP:<role>] <msg>" lines, or "[KitsuneMCP] <msg>" without a role', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    stderrLogger('Relay')('hello');
    stderrLogger()('bare');
    expect(write.mock.calls.map((c) => String(c[0]))).toEqual(['[KitsuneMCP:Relay] hello\n', '[KitsuneMCP] bare\n']);
  });

  it('never throws when stderr is gone', () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => {
      throw new Error('EPIPE');
    });
    expect(() => stderrLogger('x')('lost')).not.toThrow();
  });
});

describe('readPackageVersion', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kitsune-version-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const write = (text: string): string => {
    const file = path.join(dir, 'package.json');
    fs.writeFileSync(file, text);
    return file;
  };

  it('reads "version" of a package.json', () => {
    expect(readPackageVersion(write(JSON.stringify({ name: 'x', version: '1.2.3' })))).toBe('1.2.3');
  });

  it('is undefined for a missing, broken or version-less file (callers then report UNKNOWN_VERSION)', () => {
    expect(readPackageVersion(path.join(dir, 'missing.json'))).toBeUndefined();
    expect(readPackageVersion(write('{ broken'))).toBeUndefined();
    expect(readPackageVersion(write('[]'))).toBeUndefined();
    expect(readPackageVersion(write(JSON.stringify({ version: 1 })))).toBeUndefined();
    expect(readPackageVersion(write('{}')) ?? UNKNOWN_VERSION).toBe(UNKNOWN_VERSION);
  });
});
