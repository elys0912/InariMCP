import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Let a test make statSync fail for chosen names, as if the file had been
// deleted between readdir and stat.
const vanished = new Set<string>();
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const statSync = ((p: fs.PathLike, ...rest: unknown[]) => {
    if (vanished.has(path.basename(String(p)))) {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    }
    return (actual.statSync as (...a: unknown[]) => unknown)(p, ...rest);
  }) as typeof actual.statSync;
  return { ...actual, statSync, default: { ...actual, statSync } };
});

const { getScreenshotsDir, listScreenshots } = await import('../src/utils/screenshot.js');
const { defaultScreenshotsDir } = await import('@inari-mcp/shared/node');

let dir: string;
const saved = process.env['FOX_SCREENSHOTS_DIR'];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inari-shots-'));
  process.env['FOX_SCREENSHOTS_DIR'] = dir;
  vanished.clear();
});

afterEach(() => {
  if (saved === undefined) delete process.env['FOX_SCREENSHOTS_DIR'];
  else process.env['FOX_SCREENSHOTS_DIR'] = saved;
  fs.rmSync(dir, { recursive: true, force: true });
});

function touch(name: string, mtimeSec: number): void {
  const p = path.join(dir, name);
  fs.writeFileSync(p, '');
  fs.utimesSync(p, mtimeSec, mtimeSec);
}

describe('listScreenshots (2.A3)', () => {
  it('lists .png files newest first', () => {
    touch('old.png', 1_000);
    touch('new.png', 3_000);
    touch('mid.png', 2_000);
    touch('notes.txt', 4_000);
    expect(listScreenshots()).toEqual(['new.png', 'mid.png', 'old.png']);
  });

  it('leaves out a file that vanished while listing, instead of throwing', () => {
    touch('a.png', 1_000);
    touch('b.png', 2_000);
    vanished.add('a.png');
    expect(listScreenshots()).toEqual(['b.png']);
  });

  it('returns [] when the directory is missing or is not a directory', () => {
    process.env['FOX_SCREENSHOTS_DIR'] = path.join(dir, 'missing');
    expect(listScreenshots()).toEqual([]);
    touch('file.png', 1_000);
    process.env['FOX_SCREENSHOTS_DIR'] = path.join(dir, 'file.png');
    expect(listScreenshots()).toEqual([]);
  });
});

// R2-B C-3: a blank value was taken as a directory named ' ', and a relative
// one was left relative (unlike the Native Host's screenshot-store.ts).
describe('getScreenshotsDir', () => {
  it('a blank FOX_SCREENSHOTS_DIR is unset: the default (the old CLAUDE_BROWSER_* name is not read)', () => {
    expect(getScreenshotsDir({ FOX_SCREENSHOTS_DIR: '  ' })).toBe(defaultScreenshotsDir());
    expect(getScreenshotsDir({ FOX_SCREENSHOTS_DIR: '', CLAUDE_BROWSER_SCREENSHOTS_DIR: dir })).toBe(defaultScreenshotsDir());
    expect(getScreenshotsDir({})).toBe(defaultScreenshotsDir());
  });

  it('a relative directory is made absolute against the working directory', () => {
    expect(getScreenshotsDir({ FOX_SCREENSHOTS_DIR: 'shots' })).toBe(path.resolve('shots'));
    expect(getScreenshotsDir({ FOX_SCREENSHOTS_DIR: dir })).toBe(dir);
  });
});
