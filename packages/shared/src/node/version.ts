import * as fs from 'node:fs';

/** Reported when a package.json cannot be read (broken install). */
export const UNKNOWN_VERSION = '0.0.0-unknown';

/** `version` of the package.json at `jsonPath`, or undefined when unreadable. */
export function readPackageVersion(jsonPath: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const version = (parsed as Record<string, unknown>)['version'];
    return typeof version === 'string' ? version : undefined;
  } catch {
    return undefined;
  }
}
