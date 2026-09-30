import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// renameSync can be made to fail on demand (a file another process keeps open on Windows).
const state = vi.hoisted(() => ({ renameFails: false }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    renameSync: (from: string, to: string): void => {
      if (state.renameFails) throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' });
      actual.renameSync(from, to);
    },
  };
});

import { MAX_LOG_BYTES, log, resetLoggerForTests, rotateIfLarge } from '../src/logger.js';

describe('logger rotation', () => {
  let dir: string;
  let file: string;
  let stderrWrite: ReturnType<typeof vi.spyOn>;
  const savedLog = process.env['FOX_NATIVE_HOST_LOG'];

  const bigFile = (): void => fs.writeFileSync(file, Buffer.alloc(MAX_LOG_BYTES + 10, 0x61));
  const notes = (): string[] =>
    stderrWrite.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('log rotation skipped'));

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kitsune-log-'));
    file = path.join(dir, 'test.log');
    process.env['FOX_NATIVE_HOST_LOG'] = file;
    state.renameFails = false;
    resetLoggerForTests();
    stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    resetLoggerForTests();
    stderrWrite.mockRestore();
    if (savedLog === undefined) delete process.env['FOX_NATIVE_HOST_LOG'];
    else process.env['FOX_NATIVE_HOST_LOG'] = savedLog;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('renames an oversized file to .old', () => {
    bigFile();
    expect(rotateIfLarge(file)).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.statSync(`${file}.old`).size).toBe(MAX_LOG_BYTES + 10);
  });

  it('does not retry a failed rotation on every line', () => {
    bigFile();
    state.renameFails = true;
    for (let i = 0; i < 50; i++) log(`line ${i}`);
    expect(notes()).toHaveLength(1);
    // the file keeps being appended to
    expect(fs.readFileSync(file, 'utf-8')).toContain('line 49');
  });

  it('retries once the retry delay has passed', () => {
    vi.useFakeTimers();
    try {
      bigFile();
      state.renameFails = true;
      log('first');
      vi.advanceTimersByTime(61_000);
      log('second');
      expect(notes()).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('copies and truncates when the rename fails and copyTruncate is set', () => {
    bigFile();
    state.renameFails = true;
    expect(rotateIfLarge(file, true)).toBe(true);
    expect(fs.statSync(file).size).toBe(0);
    expect(fs.statSync(`${file}.old`).size).toBe(MAX_LOG_BYTES + 10);
  });

  it('reports failure without copyTruncate when the rename fails', () => {
    bigFile();
    state.renameFails = true;
    expect(rotateIfLarge(file)).toBe(false);
    expect(fs.statSync(file).size).toBe(MAX_LOG_BYTES + 10);
  });

  it('prefixes every file line with a timestamp and pid', () => {
    log('hello');
    expect(fs.readFileSync(file, 'utf-8')).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z \[\d+\] \[KitsuneMCP:NativeHost\] hello\n$/);
  });
});
