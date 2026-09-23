/**
 * Screenshot file management utilities.
 *
 * Handles saving base64-encoded screenshot data to disk and listing
 * previously saved screenshots. The storage directory defaults to
 * `~/.kitsune-mcp/screenshots/` but can be overridden via
 * FOX_SCREENSHOTS_DIR (or legacy CLAUDE_BROWSER_SCREENSHOTS_DIR).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ENV, LEGACY_ENV } from '@kitsune-mcp/shared';

// ---------------------------------------------------------------------------
// Directory resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the screenshots directory path.
 *
 * Priority:
 *  1. FOX_SCREENSHOTS_DIR env
 *  2. CLAUDE_BROWSER_SCREENSHOTS_DIR env (legacy)
 *  3. ~/.kitsune-mcp/screenshots/
 */
export function getScreenshotsDir(): string {
  const envDir =
    process.env[ENV.FOX_SCREENSHOTS_DIR] ??
    process.env[LEGACY_ENV.CLAUDE_BROWSER_SCREENSHOTS_DIR];
  if (envDir) return envDir;
  return path.join(os.homedir(), '.kitsune-mcp', 'screenshots');
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

/**
 * Save a base64-encoded PNG screenshot to disk.
 *
 * @param data     Base64-encoded image data (without data-URI prefix)
 * @param filename Optional filename. Defaults to `screenshot_<timestamp>.png`.
 * @returns Absolute path of the saved file.
 */
export function saveScreenshot(data: string, filename?: string): string {
  const dir = getScreenshotsDir();
  fs.mkdirSync(dir, { recursive: true });

  const name = filename ?? `screenshot_${Date.now()}.png`;
  const filePath = path.join(dir, name);

  // Strip the optional data-URI prefix if present
  const raw = data.replace(/^data:image\/\w+;base64,/, '');
  fs.writeFileSync(filePath, Buffer.from(raw, 'base64'));

  return filePath;
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

/**
 * List saved screenshot filenames in the screenshots directory.
 *
 * @returns Array of filenames (not full paths), sorted newest-first by mtime.
 *          Returns an empty array if the directory does not exist.
 */
export function listScreenshots(): string[] {
  const dir = getScreenshotsDir();

  if (!fs.existsSync(dir)) return [];

  const entries = fs.readdirSync(dir).filter((f) => f.endsWith('.png'));

  // Sort newest-first by modification time
  entries.sort((a, b) => {
    const sa = fs.statSync(path.join(dir, a));
    const sb = fs.statSync(path.join(dir, b));
    return sb.mtimeMs - sa.mtimeMs;
  });

  return entries;
}
