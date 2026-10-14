/**
 * Access to the Extension's sources from tests.
 *
 * background.ts and content.ts register browser listeners at their top level
 * (they are bundled with their imports by scripts/build-extension.mjs), so a
 * test cannot import them. Contract tests instead read constants / switch
 * cases from the source text. Modules without top-level side effects
 * (action-map.ts, approval.ts, url-rule.ts) can be imported directly.
 * Source checks over a whole bundle's code read readExtensionTree(), so they
 * do not depend on which file of background/ or content/ holds the code.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const EXTENSION_SRC = new URL('../../../packages/extension/src/', import.meta.url);

export function readExtensionSource(file: string): string {
  // Line endings normalized: a Windows checkout (core.autocrlf) has CRLF.
  return readFileSync(fileURLToPath(new URL(file, EXTENSION_SRC)), 'utf-8').split('\r\n').join('\n');
}

/**
 * Source text of one bundle's own code: the entry (`background.ts` /
 * `content.ts`) followed by the modules of its directory (`background/*.ts`
 * / `content/*.ts`, sorted by name), joined by a newline. Source checks that
 * must hold wherever the code lives read this instead of a single file.
 * Shared modules (url-rule.ts, approval.ts, ...) are not part of it.
 */
export function readExtensionTree(tree: 'background' | 'content'): string {
  const dir = fileURLToPath(new URL(`${tree}/`, EXTENSION_SRC));
  const modules = existsSync(dir)
    ? readdirSync(dir).filter((f) => f.endsWith('.ts')).sort().map((f) => `${tree}/${f}`)
    : [];
  return [`${tree}.ts`, ...modules].map(readExtensionSource).join('\n');
}

/**
 * Parse `const <name> = { KEY: 30_000, ... }` (numeric literals only).
 * Fails when the constant is missing or defined more than once in the file.
 */
export function readNumericObjectConstant(source: string, name: string): Record<string, number> {
  const re = new RegExp(`const ${name}\\s*=\\s*\\{([^}]*)\\}`, 'g');
  const matches = [...source.matchAll(re)];
  if (matches.length !== 1) {
    throw new Error(`expected exactly one "const ${name} = {...}", found ${matches.length}`);
  }
  const out: Record<string, number> = {};
  for (const m of matches[0]![1]!.matchAll(/([A-Z_][A-Z0-9_]*)\s*:\s*([0-9_]+)\s*,?/g)) {
    out[m[1]!] = Number(m[2]!.replace(/_/g, ''));
  }
  return out;
}
