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
import { ENV, LEGACY_ENV } from '@kitsune-mcp/shared';
import { defaultScreenshotsDir } from '@kitsune-mcp/shared/node';
import { resolveFoxEnv } from './headless-env.js';

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
 *
 * A blank value counts as unset (resolveFoxEnv). A relative path is made
 * absolute against the working directory, as the Native Host does
 * (screenshot-store.ts).
 */
export function getScreenshotsDir(env: NodeJS.ProcessEnv = process.env): string {
  const envDir = resolveFoxEnv(env, ENV.FOX_SCREENSHOTS_DIR, LEGACY_ENV.CLAUDE_BROWSER_SCREENSHOTS_DIR);
  return envDir === undefined ? defaultScreenshotsDir() : path.resolve(envDir);
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

/** A saved screenshot, with what its one stat() returned. */
export interface ScreenshotEntry {
  name: string;
  /** Absolute path. */
  path: string;
  size: number;
  birthtimeMs: number;
  mtimeMs: number;
}

/**
 * Saved screenshots in the screenshots directory, each stat()ed once.
 *
 * @returns sorted newest-first by mtime. Empty if the directory does not
 *          exist or cannot be read. Files that vanish while listing
 *          (deleted by another process) are left out instead of throwing.
 */
export function listScreenshotEntries(): ScreenshotEntry[] {
  const dir = getScreenshotsDir();

  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith('.png'));
  } catch {
    return [];
  }

  // stat each file once, outside the sort comparator
  const entries: ScreenshotEntry[] = [];
  for (const name of names) {
    const fullPath = path.join(dir, name);
    try {
      const stat = fs.statSync(fullPath);
      entries.push({ name, path: fullPath, size: stat.size, birthtimeMs: stat.birthtimeMs, mtimeMs: stat.mtimeMs });
    } catch {
      // Gone since readdir
    }
  }

  // Sort newest-first by modification time
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return entries;
}

/** Filenames (not full paths) of listScreenshotEntries(), newest first. */
export function listScreenshots(): string[] {
  return listScreenshotEntries().map((e) => e.name);
}
