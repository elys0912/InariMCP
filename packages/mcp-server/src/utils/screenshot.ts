/**
 * Screenshot file management utilities.
 *
 * Resolves the screenshot directory and lists saved screenshots (GET
 * /screenshots, headless backend). Files are written by the Native Host
 * (screenshot-store.ts) or the headless backend. The directory defaults to
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
