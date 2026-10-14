/**
 * Screenshot file storage for the Extension path.
 *
 * The Extension returns screenshots as data URLs (`data.imageData`, and
 * `data.screenshots[i].imageData` for all_tabs). Base64 images must not
 * travel to the MCP Server and on into the model context,
 * so the Native Host writes them to disk here and hands the server only
 * `imagePath`.
 *
 * Directory: FOX_SCREENSHOTS_DIR → ~/.inari-mcp/screenshots — the same
 * resolution as the MCP Server's utils/screenshot.ts getScreenshotsDir(), so
 * GET /screenshots lists these files too (as long as both processes see the
 * same environment).
 *
 * Hardening:
 *  - filenames are reduced to a basename with a safe character set, and the
 *    final path is verified to stay inside the directory (path traversal)
 *  - directory created 0o700, files written 0o600 (POSIX; ignored on Windows,
 *    where the ACL inherited from the user profile applies instead)
 *
 * Retention: pruneScreenshots() deletes the files this module saved once
 * they are older than FOX_SCREENSHOT_RETENTION_DAYS (default 30, 0 = keep
 * forever): those it generated a name for
 * (`screenshot_<ms>_<random>[_tabN].ext`), and those saved under a
 * caller-chosen name, which it lists in NAMED_INDEX as it writes them. Any
 * other file in the directory is never deleted (FOX_SCREENSHOTS_DIR may
 * point to a directory that holds the user's own images).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ENV, isRecord, shortId } from '@inari-mcp/shared';
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE, defaultScreenshotsDir, screenshotStem } from '@inari-mcp/shared/node';

/** Image types accepted in a screenshot data URL. */
const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp'] as const;
type ImageMime = (typeof IMAGE_MIMES)[number];

const EXT_BY_MIME: Record<ImageMime, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
};

const DATA_URL_RE = new RegExp(`^data:(${IMAGE_MIMES.join('|')});base64,`, 'i');

function isImageMime(value: string): value is ImageMime {
  return IMAGE_MIMES.some((mime) => mime === value);
}

/**
 * FOX_SCREENSHOTS_DIR, else the default. A blank value counts as unset, so
 * `FOX_SCREENSHOTS_DIR=` is the default (same convention as shared's
 * FOX_HOST).
 */
export function getScreenshotsDir(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env[ENV.FOX_SCREENSHOTS_DIR]?.trim();
  return raw === undefined || raw === '' ? defaultScreenshotsDir() : path.resolve(raw);
}

/**
 * Names produced by uniqueStem() + saveScreenshot()'s suffix. shortId() now
 * gives exactly 6 characters; 1-5 are still accepted for files written by
 * earlier versions, whose shortId() could be shorter.
 */
const GENERATED_NAME_RE = /^screenshot_\d{13}_[a-z0-9]{1,6}(?:_tab\d+|_\d+)?\.(?:png|jpg|webp)$/;
const DEFAULT_RETENTION_DAYS = 30;
/**
 * Index of the files saved under a caller-chosen name (one name per line),
 * in the screenshots directory: what pruneScreenshots() may delete besides
 * the generated names.
 */
const NAMED_INDEX = '.named-screenshots';
const MS_PER_DAY = 86_400_000;
/** Longest part of an unsupported data URL header quoted in the error. */
const MAX_HEAD_IN_ERROR = 60;

export function retentionDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[ENV.FOX_SCREENSHOT_RETENTION_DAYS]?.trim();
  if (raw === undefined || raw === '') return DEFAULT_RETENTION_DAYS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_RETENTION_DAYS;
}

/** The names listed in NAMED_INDEX (none when it does not exist). */
function readNamedIndex(dir: string): Set<string> {
  try {
    const text = fs.readFileSync(path.join(dir, NAMED_INDEX), 'utf-8');
    return new Set(text.split('\n').filter((name) => name !== ''));
  } catch {
    return new Set();
  }
}

/** Add a caller-chosen name to NAMED_INDEX (once). Never throws: the file is saved either way. */
function addToNamedIndex(dir: string, name: string): void {
  try {
    if (readNamedIndex(dir).has(name)) return;
    fs.appendFileSync(path.join(dir, NAMED_INDEX), `${name}\n`, { mode: PRIVATE_FILE_MODE });
  } catch {
    // Not listed: the file is kept until it is deleted by hand.
  }
}

/** Delete `filePath` when it is older than `days`; whether it was deleted. */
function removeIfOlder(filePath: string, days: number, now: number): boolean {
  try {
    if (now - fs.statSync(filePath).mtimeMs <= days * MS_PER_DAY) return false;
    fs.unlinkSync(filePath);
    return true;
  } catch {
    // vanished or locked: leave it for the next start
    return false;
  }
}

/**
 * Rewrite NAMED_INDEX with the names of `indexedNames` whose file is still
 * in `dir`. Nothing to do for an empty index. Never throws.
 */
function rewriteNamedIndex(dir: string, indexedNames: ReadonlySet<string>): void {
  if (indexedNames.size === 0) return;

  const kept = [...indexedNames].filter((name) => fs.existsSync(path.join(dir, name)));
  try {
    fs.writeFileSync(path.join(dir, NAMED_INDEX), kept.map((name) => `${name}\n`).join(''), { mode: PRIVATE_FILE_MODE });
  } catch {
    // Rewritten at the next start.
  }
}

/**
 * Delete the screenshots this module saved (generated names, and the
 * caller-chosen names in NAMED_INDEX) that are older than `days`
 * (0 = keep all), and drop the names of files no longer there from the
 * index. Returns the number of files removed; never throws.
 */
export function pruneScreenshots(days: number = retentionDays(), now: number = Date.now()): number {
  if (days <= 0) return 0;

  const dir = getScreenshotsDir();
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    // directory does not exist yet
    return 0;
  }

  const indexedNames = readNamedIndex(dir);
  let removed = 0;
  for (const name of entries) {
    if (!GENERATED_NAME_RE.test(name) && !indexedNames.has(name)) continue;
    if (removeIfOlder(path.join(dir, name), days, now)) removed++;
  }
  rewriteNamedIndex(dir, indexedNames);

  return removed;
}

/**
 * True when the screenshots directory is outside the user's home on Windows,
 * where the 0o700 / 0o600 modes do nothing and the directory's own ACL decides.
 */
export function screenshotsDirNeedsAclCheck(platform: string = process.platform): boolean {
  if (platform !== 'win32') return false;
  const rel = path.relative(os.homedir(), getScreenshotsDir());
  return rel.startsWith('..') || path.isAbsolute(rel);
}

function uniqueStem(): string {
  return `screenshot_${Date.now()}_${shortId()}`;
}

/**
 * Turn a caller-supplied filename into a safe basename with the right
 * extension. Returns a generated name when nothing usable remains.
 */
function sanitizeFilename(requested: string | undefined, ext: string, suffix: string): string {
  return `${screenshotStem(requested) ?? uniqueStem()}${suffix}${ext}`;
}

/**
 * Save one data-URL (or bare base64 PNG) screenshot to disk.
 *
 * @param imageData  `data:image/...;base64,...` or bare base64
 * @param filename   Optional requested filename (sanitized)
 * @param suffix     Appended to the stem, e.g. `_tab12` for all_tabs
 * @returns Absolute path of the written file.
 */
export function saveScreenshot(imageData: string, filename?: string, suffix = ''): string {
  return saveScreenshotFile(imageData, filename, suffix).path;
}

/**
 * saveScreenshot(), also telling whether a file of that name existed and was
 * replaced (only possible with a caller-chosen filename; generated names are
 * unique).
 */
export function saveScreenshotFile(
  imageData: string,
  filename?: string,
  suffix = '',
): { path: string; overwritten: boolean } {
  const match = DATA_URL_RE.exec(imageData);
  if (match === null && imageData.startsWith('data:')) {
    // Another MIME type (or not base64): decoding the whole string as base64
    // would write a broken file and report success.
    const head = (imageData.split(',', 1)[0] ?? '').slice(0, MAX_HEAD_IN_ERROR);
    throw new Error(`unsupported screenshot data URL (${head}); expected PNG, JPEG or WebP as base64`);
  }
  const mime = match?.[1]?.toLowerCase();
  const ext = EXT_BY_MIME[mime !== undefined && isImageMime(mime) ? mime : 'image/png'];
  const base64 = match ? imageData.slice(match[0].length) : imageData;

  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length === 0) {
    throw new Error('screenshot data is empty or not base64');
  }

  const dir = getScreenshotsDir();
  fs.mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });

  const name = sanitizeFilename(filename, ext, suffix);
  const filePath = path.resolve(dir, name);
  if (path.dirname(filePath) !== path.resolve(dir)) {
    throw new Error(`refusing to write outside the screenshots directory: ${name}`);
  }

  const overwritten = fs.existsSync(filePath);
  fs.writeFileSync(filePath, bytes, { mode: PRIVATE_FILE_MODE });
  if (!GENERATED_NAME_RE.test(name)) addToNamedIndex(dir, name);
  // `mode` only applies on creation; tighten an overwritten file too.
  try {
    fs.chmodSync(filePath, PRIVATE_FILE_MODE);
  } catch {
    // Non-POSIX filesystems
  }
  return { path: filePath, overwritten };
}

function overwriteWarning(filePath: string): string {
  return `${path.basename(filePath)} already existed in the screenshots directory and was overwritten`;
}

/**
 * Replace every `imageData` in an Extension response with `imagePath`,
 * in place. Handles `data.imageData` and `data.screenshots[i].imageData`.
 *
 * - Single image that cannot be saved → the response becomes a failure
 *   (the server would otherwise report success without a file).
 * - An all_tabs entry that cannot be saved → that entry gets `imageError`;
 *   when no entry with an image could be saved, the response becomes a
 *   failure too.
 * - A caller-chosen filename that replaced an existing file → `imageOverwritten`
 *   (on the data or the entry) and a line in `data.warnings`.
 * `imageData` is always removed, saved or not.
 */
export function externalizeScreenshots(
  response: Record<string, unknown>,
  filename: string | undefined,
  log: (msg: string) => void,
): void {
  const data = response['data'];
  if (!isRecord(data)) return;

  const warnings: string[] = [];
  const single = data['imageData'];
  if (typeof single === 'string') {
    delete data['imageData'];
    try {
      const saved = saveScreenshotFile(single, filename);
      data['imagePath'] = saved.path;
      if (saved.overwritten) {
        data['imageOverwritten'] = true;
        warnings.push(overwriteWarning(saved.path));
      }
      log(`screenshot saved: ${saved.path}${saved.overwritten ? ' (overwritten)' : ''}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`failed to save screenshot: ${msg}`);
      response['success'] = false;
      response['error'] = `Native Host failed to save screenshot: ${msg}`;
    }
  }

  const shots = data['screenshots'];
  if (Array.isArray(shots)) {
    let withImage = 0;
    let saved = 0;
    shots.forEach((shot: unknown, i: number) => {
      if (!isRecord(shot)) return;
      const img = shot['imageData'];
      if (typeof img !== 'string') return;
      withImage++;
      delete shot['imageData'];
      const tabId = shot['tabId'];
      const suffix = typeof tabId === 'number' ? `_tab${tabId}` : `_${i}`;
      try {
        const file = saveScreenshotFile(img, filename, suffix);
        shot['imagePath'] = file.path;
        saved++;
        if (file.overwritten) {
          shot['imageOverwritten'] = true;
          warnings.push(overwriteWarning(file.path));
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`failed to save all_tabs screenshot #${i}: ${msg}`);
        shot['imageError'] = `Native Host failed to save screenshot: ${msg}`;
      }
    });
    if (withImage > 0 && saved === 0 && response['success'] === true) {
      response['success'] = false;
      response['error'] = 'Native Host failed to save every all_tabs screenshot (see screenshots[].imageError)';
    }
  }

  if (warnings.length > 0) {
    const previous = data['warnings'];
    const existing: unknown[] = Array.isArray(previous) ? previous : [];
    data['warnings'] = [...existing, ...warnings];
  }
}
