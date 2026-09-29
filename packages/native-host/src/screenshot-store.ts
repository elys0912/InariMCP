/**
 * Screenshot file storage for the Extension path.
 *
 * The Extension returns screenshots as data URLs (`data.imageData`, and
 * `data.screenshots[i].imageData` for all_tabs). Base64 images must not
 * travel to the MCP Server and on into the model context,
 * so the Native Host writes them to disk here and hands the server only
 * `imagePath`.
 *
 * Directory: FOX_SCREENSHOTS_DIR → CLAUDE_BROWSER_SCREENSHOTS_DIR (legacy)
 * → ~/.kitsune-mcp/screenshots — the same resolution as the MCP Server's
 * utils/screenshot.ts getScreenshotsDir(), so GET /screenshots lists these
 * files too (as long as both processes see the same environment).
 *
 * Hardening:
 *  - filenames are reduced to a basename with a safe character set, and the
 *    final path is verified to stay inside the directory (path traversal)
 *  - directory created 0o700, files written 0o600 (POSIX; ignored on Windows)
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ENV, LEGACY_ENV } from '@kitsune-mcp/shared';

const DATA_URL_RE = /^data:(image\/(?:png|jpeg|webp));base64,/i;

const EXT_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
};

export function getScreenshotsDir(): string {
  const envDir =
    process.env[ENV.FOX_SCREENSHOTS_DIR] ??
    process.env[LEGACY_ENV.CLAUDE_BROWSER_SCREENSHOTS_DIR];
  if (envDir) return path.resolve(envDir);
  return path.join(os.homedir(), '.kitsune-mcp', 'screenshots');
}

function uniqueStem(): string {
  return `screenshot_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Turn a caller-supplied filename into a safe basename with the right
 * extension. Returns a generated name when nothing usable remains.
 */
function sanitizeFilename(requested: string | undefined, ext: string, suffix: string): string {
  let stem = uniqueStem();
  if (requested) {
    const base = path.basename(requested.replace(/\\/g, '/'));
    const withoutExt = base.replace(/\.(png|jpe?g|webp)$/i, '');
    const safe = withoutExt.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
    if (safe) stem = safe.slice(0, 120);
  }
  return `${stem}${suffix}${ext}`;
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
  const match = DATA_URL_RE.exec(imageData);
  const mime = match?.[1]?.toLowerCase() ?? 'image/png';
  const ext = EXT_BY_MIME[mime] ?? '.png';
  const base64 = match ? imageData.slice(match[0].length) : imageData;

  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length === 0) {
    throw new Error('screenshot data is empty or not base64');
  }

  const dir = getScreenshotsDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const name = sanitizeFilename(filename, ext, suffix);
  const filePath = path.resolve(dir, name);
  if (path.dirname(filePath) !== path.resolve(dir)) {
    throw new Error(`refusing to write outside the screenshots directory: ${name}`);
  }

  fs.writeFileSync(filePath, bytes, { mode: 0o600 });
  // `mode` only applies on creation; tighten an overwritten file too.
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Non-POSIX filesystems
  }
  return filePath;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Replace every `imageData` in an Extension response with `imagePath`,
 * in place. Handles `data.imageData` and `data.screenshots[i].imageData`.
 *
 * - Single image that cannot be saved → the response becomes a failure
 *   (the server would otherwise report success without a file).
 * - An all_tabs entry that cannot be saved → that entry gets `imageError`.
 * `imageData` is always removed, saved or not.
 */
export function externalizeScreenshots(
  response: Record<string, unknown>,
  filename: string | undefined,
  log: (msg: string) => void,
): void {
  const data = response['data'];
  if (!isRecord(data)) return;

  const single = data['imageData'];
  if (typeof single === 'string') {
    delete data['imageData'];
    try {
      data['imagePath'] = saveScreenshot(single, filename);
      log(`screenshot saved: ${String(data['imagePath'])}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`failed to save screenshot: ${msg}`);
      response['success'] = false;
      response['error'] = `Native Host failed to save screenshot: ${msg}`;
    }
  }

  const shots = data['screenshots'];
  if (Array.isArray(shots)) {
    shots.forEach((shot: unknown, i: number) => {
      if (!isRecord(shot)) return;
      const img = shot['imageData'];
      if (typeof img !== 'string') return;
      delete shot['imageData'];
      const tabId = shot['tabId'];
      const suffix = typeof tabId === 'number' ? `_tab${tabId}` : `_${i}`;
      try {
        shot['imagePath'] = saveScreenshot(img, filename, suffix);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`failed to save all_tabs screenshot #${i}: ${msg}`);
        shot['imageError'] = `Native Host failed to save screenshot: ${msg}`;
      }
    });
  }
}
