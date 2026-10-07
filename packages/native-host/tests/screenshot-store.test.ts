import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isRecord } from '@kitsune-mcp/shared';
import { externalizeScreenshots, getScreenshotsDir } from '../src/screenshot-store.js';

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const PNG_URL = `data:image/png;base64,${PNG_BYTES.toString('base64')}`;
const JPEG_URL = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 1]).toString('base64')}`;

let dir: string;
const noLog = (): void => {};

/** `response.data`; fails the test when it is not an object. */
function dataOf(response: Record<string, unknown>): Record<string, unknown> {
  const data = response['data'];
  if (!isRecord(data)) throw new Error('response.data is not an object');
  return data;
}

/** `record[key]` as a string; fails the test otherwise. */
function stringAt(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string') throw new Error(`${key} is not a string`);
  return value;
}

function imagePathOf(response: Record<string, unknown>): string {
  return stringAt(dataOf(response), 'imagePath');
}

/** `response.data.screenshots` (entries may be anything). */
function shotsOf(response: Record<string, unknown>): unknown[] {
  const shots = dataOf(response)['screenshots'];
  if (!Array.isArray(shots)) throw new Error('response.data.screenshots is not an array');
  return shots;
}

/** Entry `i` of `response.data.screenshots`; fails the test when it is not an object. */
function shotAt(response: Record<string, unknown>, i: number): Record<string, unknown> {
  const shot = shotsOf(response)[i];
  if (!isRecord(shot)) throw new Error(`screenshots[${i}] is not an object`);
  return shot;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kitsune-shots-'));
  vi.stubEnv('FOX_SCREENSHOTS_DIR', dir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('getScreenshotsDir', () => {
  const LEGACY_DIR = path.join(os.tmpdir(), 'kitsune-shots-legacy');

  it('uses FOX_SCREENSHOTS_DIR when set', () => {
    expect(getScreenshotsDir({ FOX_SCREENSHOTS_DIR: dir })).toBe(path.resolve(dir));
  });

  it('falls through a blank FOX_SCREENSHOTS_DIR to the legacy name', () => {
    for (const blank of ['', '   ']) {
      expect(getScreenshotsDir({ FOX_SCREENSHOTS_DIR: blank, CLAUDE_BROWSER_SCREENSHOTS_DIR: LEGACY_DIR }))
        .toBe(path.resolve(LEGACY_DIR));
    }
  });

  it('uses the default when both names are blank', () => {
    const fromBlank = getScreenshotsDir({ FOX_SCREENSHOTS_DIR: ' ', CLAUDE_BROWSER_SCREENSHOTS_DIR: '' });
    expect(fromBlank).toBe(getScreenshotsDir({}));
    expect(fromBlank).not.toBe(path.resolve(' '));
  });
});

describe('externalizeScreenshots', () => {
  it('replaces data.imageData with imagePath of the file written in the screenshots dir', () => {
    const response: Record<string, unknown> = {
      requestId: '1',
      success: true,
      data: { imageData: PNG_URL, url: 'https://example.test/' },
    };
    externalizeScreenshots(response, undefined, noLog);

    const data = dataOf(response);
    expect(data).not.toHaveProperty('imageData');
    expect(data['url']).toBe('https://example.test/');
    const imagePath = imagePathOf(response);
    expect(path.dirname(imagePath)).toBe(path.resolve(dir));
    expect(imagePath).toMatch(/\.png$/);
    expect(fs.readFileSync(imagePath)).toEqual(PNG_BYTES);
    expect(response['success']).toBe(true);
    expect(Object.keys(response)[0]).toBe('requestId');
  });

  it('uses the requested filename reduced to a safe basename, extension from the MIME type', () => {
    const response: Record<string, unknown> = { requestId: '1', success: true, data: { imageData: JPEG_URL } };
    externalizeScreenshots(response, '../../evil name.png', noLog);
    const imagePath = imagePathOf(response);
    expect(path.dirname(imagePath)).toBe(path.resolve(dir));
    expect(path.basename(imagePath)).toBe('evil_name.jpg');
  });

  it('accepts bare base64 as PNG', () => {
    const response: Record<string, unknown> = {
      requestId: '1', success: true, data: { imageData: PNG_BYTES.toString('base64') },
    };
    externalizeScreenshots(response, 'shot', noLog);
    const imagePath = imagePathOf(response);
    expect(path.basename(imagePath)).toBe('shot.png');
  });

  it('turns the response into a failure when the single image cannot be saved', () => {
    const log = vi.fn();
    const response: Record<string, unknown> = {
      requestId: '1', success: true, data: { imageData: 'data:image/png;base64,' },
    };
    externalizeScreenshots(response, undefined, log);
    const data = dataOf(response);
    expect(data).not.toHaveProperty('imageData');
    expect(data).not.toHaveProperty('imagePath');
    expect(response['success']).toBe(false);
    expect(response['error']).toMatch(/^Native Host failed to save screenshot: /);
    expect(log).toHaveBeenCalled();
    expect(Object.keys(response)[0]).toBe('requestId');
    expect(fs.readdirSync(dir)).toHaveLength(0);
  });

  it('fails on a data URL of another MIME type instead of saving it as base64 (H-D1)', () => {
    const log = vi.fn();
    const gif = Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1').toString('base64');
    const response: Record<string, unknown> = {
      requestId: '1', success: true, data: { imageData: `data:image/gif;base64,${gif}` },
    };
    externalizeScreenshots(response, undefined, log);
    expect(response['success']).toBe(false);
    expect(response['error']).toMatch(/unsupported screenshot data URL \(data:image\/gif;base64\)/);
    expect(fs.readdirSync(dir)).toHaveLength(0);
  });

  it('handles all_tabs entries: _tab<id> / _<index> suffixes, per-entry imageError', () => {
    const response: Record<string, unknown> = {
      requestId: '1',
      success: true,
      data: {
        screenshots: [
          { tabId: 12, imageData: PNG_URL },
          { imageData: PNG_URL },
          { tabId: 14, imageData: '' },
          { tabId: 15, error: 'restricted page' },
          'not-an-object',
        ],
      },
    };
    externalizeScreenshots(response, 'all', noLog);

    const shots = shotsOf(response);
    expect(path.basename(stringAt(shotAt(response, 0), 'imagePath'))).toBe('all_tab12.png');
    expect(path.basename(stringAt(shotAt(response, 1), 'imagePath'))).toBe('all_1.png');
    expect(shotAt(response, 2)['imageError']).toMatch(/^Native Host failed to save screenshot: /);
    expect(shots[3]).toEqual({ tabId: 15, error: 'restricted page' });
    expect(shots[4]).toBe('not-an-object');
    for (const shot of shots.slice(0, 3)) expect(shot).not.toHaveProperty('imageData');
    expect(response['success']).toBe(true);
    expect(fs.readdirSync(dir).sort()).toEqual(['all_1.png', 'all_tab12.png']);
  });

  it('warns when a caller-chosen filename replaces an existing file (5.7)', () => {
    const first: Record<string, unknown> = { requestId: '1', success: true, data: { imageData: PNG_URL } };
    externalizeScreenshots(first, 'same', noLog);
    expect(first['data']).not.toHaveProperty('imageOverwritten');
    const second: Record<string, unknown> = { requestId: '2', success: true, data: { imageData: PNG_URL } };
    externalizeScreenshots(second, 'same', noLog);
    const data = dataOf(second);
    expect(data['imageOverwritten']).toBe(true);
    expect(data['warnings']).toEqual([expect.stringContaining('same.png already existed')]);
  });

  it('flags the overwritten all_tabs entry, not its neighbours (5.7)', () => {
    const first: Record<string, unknown> = {
      requestId: '1', success: true,
      data: { screenshots: [{ tabId: 12, imageData: PNG_URL }] },
    };
    externalizeScreenshots(first, 'same', noLog);
    expect(shotAt(first, 0)).not.toHaveProperty('imageOverwritten');

    const second: Record<string, unknown> = {
      requestId: '2', success: true,
      data: {
        screenshots: [
          { tabId: 12, imageData: PNG_URL }, // same_tab12.png: exists
          { tabId: 13, imageData: PNG_URL }, // same_tab13.png: new
        ],
      },
    };
    externalizeScreenshots(second, 'same', noLog);
    expect(shotAt(second, 0)['imageOverwritten']).toBe(true);
    expect(shotAt(second, 1)).not.toHaveProperty('imageOverwritten');
    expect(dataOf(second)['warnings']).toEqual([expect.stringContaining('same_tab12.png already existed')]);
    expect(second['success']).toBe(true);
    expect(fs.readdirSync(dir).sort()).toEqual(['same_tab12.png', 'same_tab13.png']);
  });

  it('never warns about generated names: they are unique (5.7)', () => {
    for (const requestId of ['1', '2']) {
      const response: Record<string, unknown> = {
        requestId, success: true, data: { imageData: PNG_URL },
      };
      externalizeScreenshots(response, undefined, noLog);
      const data = dataOf(response);
      expect(data).not.toHaveProperty('imageOverwritten');
      expect(data).not.toHaveProperty('warnings');
      expect(path.basename(imagePathOf(response))).toMatch(/^screenshot_\d{13}_[a-z0-9]{6}\.png$/);
    }

    for (const requestId of ['3', '4']) {
      const response: Record<string, unknown> = {
        requestId, success: true,
        data: { screenshots: [{ tabId: 12, imageData: PNG_URL }, { imageData: PNG_URL }] },
      };
      externalizeScreenshots(response, undefined, noLog);
      for (const shot of shotsOf(response)) expect(shot).not.toHaveProperty('imageOverwritten');
      expect(dataOf(response)['warnings']).toBeUndefined();
    }

    // Two single + four all_tabs files, all with distinct generated names.
    expect(new Set(fs.readdirSync(dir)).size).toBe(6);
  });

  it('fails an all_tabs response when no image could be saved (5.7)', () => {
    const response: Record<string, unknown> = {
      requestId: '1', success: true,
      data: { screenshots: [{ tabId: 1, imageData: '' }, { tabId: 2, error: 'restricted' }] },
    };
    externalizeScreenshots(response, undefined, noLog);
    expect(response['success']).toBe(false);
    expect(response['error']).toMatch(/every all_tabs screenshot/);
  });

  it('leaves responses without data or images untouched', () => {
    const noData: Record<string, unknown> = { requestId: '1', success: false, error: 'x' };
    externalizeScreenshots(noData, undefined, noLog);
    expect(noData).toEqual({ requestId: '1', success: false, error: 'x' });

    const plain: Record<string, unknown> = { requestId: '2', success: true, data: { title: 't' } };
    externalizeScreenshots(plain, undefined, noLog);
    expect(plain).toEqual({ requestId: '2', success: true, data: { title: 't' } });
    expect(fs.readdirSync(dir)).toHaveLength(0);
  });
});
