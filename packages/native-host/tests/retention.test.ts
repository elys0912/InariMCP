import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  pruneScreenshots,
  retentionDays,
  saveScreenshot,
  screenshotsDirNeedsAclCheck,
} from '../src/screenshot-store.js';

const DAY = 86_400_000;
const PNG_URL = `data:image/png;base64,${Buffer.from([0x89, 0x50, 1, 2]).toString('base64')}`;

let dir: string;

function touch(name: string, ageDays: number): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, 'x');
  const t = new Date(Date.now() - ageDays * DAY);
  fs.utimesSync(file, t, t);
  return file;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inari-ret-'));
  vi.stubEnv('FOX_SCREENSHOTS_DIR', dir);
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('retentionDays', () => {
  it('defaults to 30, accepts 0 and ignores garbage', () => {
    expect(retentionDays({})).toBe(30);
    expect(retentionDays({ FOX_SCREENSHOT_RETENTION_DAYS: '7' })).toBe(7);
    expect(retentionDays({ FOX_SCREENSHOT_RETENTION_DAYS: '0' })).toBe(0);
    expect(retentionDays({ FOX_SCREENSHOT_RETENTION_DAYS: '-1' })).toBe(30);
    expect(retentionDays({ FOX_SCREENSHOT_RETENTION_DAYS: 'abc' })).toBe(30);
  });
});

describe('pruneScreenshots', () => {
  it('removes old generated-name files and keeps recent ones', () => {
    const old = touch('screenshot_1700000000000_abc123.png', 40);
    const oldTab = touch('screenshot_1700000000000_abc123_tab5.jpg', 40);
    const recent = touch('screenshot_1700000000001_abc123.png', 1);
    expect(pruneScreenshots(30)).toBe(2);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(oldTab)).toBe(false);
    expect(fs.existsSync(recent)).toBe(true);
  });

  it('never deletes files it did not save, whatever their name', () => {
    const named = touch('my-page.png', 400);
    const other = touch('notes.txt', 400);
    const lookalike = touch('screenshot_old.png', 400);
    expect(pruneScreenshots(30)).toBe(0);
    for (const f of [named, other, lookalike]) expect(fs.existsSync(f)).toBe(true);
  });

  it('keeps everything when the period is 0', () => {
    const old = touch('screenshot_1700000000000_abc123.png', 999);
    expect(pruneScreenshots(0)).toBe(0);
    expect(fs.existsSync(old)).toBe(true);
  });

  it('prunes names that saveScreenshot generated', () => {
    const file = saveScreenshot(PNG_URL, undefined, '_tab3');
    const t = new Date(Date.now() - 40 * DAY);
    fs.utimesSync(file, t, t);
    expect(pruneScreenshots(30)).toBe(1);
  });

  it('prunes files saved under a caller-chosen name after the same period (Fo-15)', () => {
    const old = saveScreenshot(PNG_URL, 'checkout-page');
    const recent = saveScreenshot(PNG_URL, 'landing');
    const t = new Date(Date.now() - 40 * DAY);
    fs.utimesSync(old, t, t);
    const userFile = touch('holiday.png', 400);
    expect(pruneScreenshots(30)).toBe(1);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(recent)).toBe(true);
    expect(fs.existsSync(userFile)).toBe(true);
    // The deleted name leaves the index: a file of that name written later
    // by someone else is not taken for one of ours.
    const later = touch('checkout-page.png', 400);
    expect(pruneScreenshots(30)).toBe(0);
    expect(fs.existsSync(later)).toBe(true);
  });

  it('does not throw when the directory does not exist', () => {
    vi.stubEnv('FOX_SCREENSHOTS_DIR', path.join(dir, 'missing'));
    expect(pruneScreenshots(30)).toBe(0);
  });
});

describe('screenshotsDirNeedsAclCheck', () => {
  it('is false off Windows', () => {
    vi.stubEnv('FOX_SCREENSHOTS_DIR', path.join(os.tmpdir(), 'x'));
    expect(screenshotsDirNeedsAclCheck('linux')).toBe(false);
  });

  it('flags a directory outside the home directory on Windows, not one inside', () => {
    vi.stubEnv('FOX_SCREENSHOTS_DIR', path.join(os.homedir(), '.inari-mcp', 'screenshots'));
    expect(screenshotsDirNeedsAclCheck('win32')).toBe(false);
    vi.stubEnv('FOX_SCREENSHOTS_DIR', path.parse(os.homedir()).root + 'shared-shots');
    expect(screenshotsDirNeedsAclCheck('win32')).toBe(true);
  });
});
