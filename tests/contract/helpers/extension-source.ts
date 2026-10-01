/**
 * Access to the Extension's sources from tests.
 *
 * background.ts and content.ts register browser listeners at their top level
 * (they are bundled with their imports by scripts/build-extension.mjs), so a
 * test cannot import them. Contract tests instead
 *   - read constants / switch cases from the source text, or
 *   - cut one self-contained function out of the source, strip its types
 *     with Vite's transformer and evaluate it on its own.
 * Only use this for small pure functions that reference no other top-level
 * binding of the module. Imported names are not in scope either, unless the
 * test puts them on globalThis.
 * Modules without top-level side effects (action-map.ts, approval.ts,
 * url-rule.ts) can also be imported directly.
 * Source checks over a whole bundle's code read readExtensionTree(), so they
 * do not depend on which file of background/ or content/ holds the code.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transformWithOxc } from 'vite';

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

/**
 * Source text of the `function <name>(...) {...}` declaration (top level,
 * or indented inside content.ts's IIFE; `export` and `async` allowed, and
 * `export` is left out of the result).
 * Braces are matched naively (no string / comment awareness), which is fine
 * for the small functions this is used on.
 */
export function extractFunctionSource(source: string, name: string): string {
  const match = new RegExp(`^([ \\t]*)(export )?(?:async )?function ${name}\\(`, 'm').exec(source);
  if (match === null) throw new Error(`function ${name} not found`);
  // Leave `export` out: the text is evaluated as a plain function declaration.
  const start = match.index + (match[2] === undefined ? 0 : match[1]!.length + match[2].length);

  // Skip the parameter list, then match the body braces.
  let i = source.indexOf('(', start);
  let parens = 0;
  for (; i < source.length; i++) {
    if (source[i] === '(') parens++;
    else if (source[i] === ')' && --parens === 0) break;
  }
  const bodyStart = source.indexOf('{', i);
  let braces = 0;
  for (let j = bodyStart; j < source.length; j++) {
    if (source[j] === '{') braces++;
    else if (source[j] === '}' && --braces === 0) return source.slice(start, j + 1);
  }
  throw new Error(`unbalanced braces in function ${name}`);
}

/** Load one self-contained function of an Extension source file. */
export async function loadExtensionFunction<T extends (...args: never[]) => unknown>(
  file: string,
  name: string,
): Promise<T> {
  const ts = extractFunctionSource(readExtensionSource(file), name);
  const { code } = await transformWithOxc(ts, `${name}.ts`, { lang: 'ts' });
  return new Function(`${code}\nreturn ${name};`)() as T;
}

/**
 * Load several functions of one Extension source file together, so they can
 * call each other. Free globals they use (e.g. `browser`) are looked up on
 * globalThis when called. Same limits as extractFunctionSource (the body
 * must be the first `{` after the parameter list: no object return types).
 */
export async function loadExtensionFunctions<T>(file: string, names: readonly string[]): Promise<T> {
  const source = readExtensionSource(file);
  const ts = names.map((name) => extractFunctionSource(source, name).trimStart()).join('\n\n');
  const { code } = await transformWithOxc(ts, 'functions.ts', { lang: 'ts' });
  return new Function(`${code}\nreturn { ${names.join(', ')} };`)() as T;
}
