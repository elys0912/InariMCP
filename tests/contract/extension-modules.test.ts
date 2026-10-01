/**
 * Extension module structure (WP11): background.ts / content.ts are the
 * entries, background/*.ts and content/*.ts the modules they bundle.
 *
 *   - no import cycle between the Extension's own modules (src/**), so the
 *     layers stay one-way (callbacks / setters where a lower module has to
 *     reach a higher one);
 *   - the modules under background/ and content/ have no top-level side
 *     effects: only the entries register listeners or call browser.* at load
 *     time (content.js runs every module before its __fox_injected guard,
 *     on every injection).
 *
 * Imports are read with a regular expression over the source text (the
 * Extension's import statements are all `import ... from "<path>";`).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../../packages/extension/src/', import.meta.url));

function listTs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listTs(full));
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

const rel = (file: string): string => path.relative(SRC, file).split(path.sep).join('/');
const read = (file: string): string => readFileSync(file, 'utf-8').split('\r\n').join('\n');

/** Relative imports of each source file (src-relative paths, with .ts). */
function importGraph(): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const file of listTs(SRC)) {
    const deps: string[] = [];
    for (const m of read(file).matchAll(/^import\s[^;]*?\sfrom\s+["'](\.{1,2}\/[^"']+)["'];/gm)) {
      deps.push(rel(path.resolve(path.dirname(file), `${m[1]!}.ts`)));
    }
    graph.set(rel(file), deps);
  }
  return graph;
}

function findCycles(graph: Map<string, string[]>): string[][] {
  const cycles: string[][] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  const visit = (node: string): void => {
    state.set(node, 'visiting');
    stack.push(node);
    for (const dep of graph.get(node) ?? []) {
      if (state.get(dep) === 'visiting') cycles.push([...stack.slice(stack.indexOf(dep)), dep]);
      else if (!state.has(dep)) visit(dep);
    }
    stack.pop();
    state.set(node, 'done');
  };
  for (const node of [...graph.keys()].sort()) if (!state.has(node)) visit(node);
  return cycles;
}

/**
 * Top-level statements that run code at load time: expression statements
 * (a call, an assignment, `browser.x.addListener(...)`, an IIFE) and
 * declarations whose initializer reaches browser / document / window.
 * Declarations of functions, types and plain values (`new Map()`, literals)
 * are fine.
 */
function topLevelSideEffects(source: string): string[] {
  const out: string[] = [];
  const DECL = /^(export\s+)?(declare\s+)?(import|export|const|let|var|function|async\s+function|interface|type|enum|class)\b/;
  for (const line of source.split('\n')) {
    if (line === '' || /^\s/.test(line) || /^(\/\/|\/\*|\*|\}|\]|\))/.test(line)) continue;
    if (!DECL.test(line)) {
      out.push(line);
      continue;
    }
    if (/^(export\s+)?(const|let|var)\s[^=]*=.*\b(browser|document|window)\./.test(line)) out.push(line);
  }
  return out;
}

/** Entries split into a directory of modules. */
const TREES = ['background', 'content'] as const;

/** `browser.x.onY.addListener(` (optional chaining allowed), not `port.onMessage...`. */
const BROWSER_LISTENER_RE = /\bbrowser[\w.?]*\.addListener\(/g;
const REMOVE_LISTENER_RE = /\.removeListener\(/g;
const count = (source: string, re: RegExp): number => [...source.matchAll(re)].length;

/**
 * The entries, and the two background modules they call to register
 * listeners. Everything else must leave browser.* events alone.
 */
const LISTENER_FILES = ['background/context-menu.ts', 'background/listeners.ts', 'content.ts'];

/** Registration functions the background entry calls at load time. */
const REGISTRARS = ['registerListeners', 'registerContextMenus'] as const;

describe('extension modules', () => {
  const graph = importGraph();

  it.each(TREES)('%s.ts bundles modules of its own directory', (tree) => {
    expect(graph.get(`${tree}.ts`)!.some((d) => d.startsWith(`${tree}/`))).toBe(true);
  });

  it('has no import cycle', () => {
    expect(findCycles(graph)).toEqual([]);
  });

  it('nothing imports an entry', () => {
    const entries = new Set(['background.ts', 'content.ts', 'popup/popup.ts']);
    const offenders = [...graph].filter(([, deps]) => deps.some((d) => entries.has(d))).map(([f]) => f);
    expect(offenders).toEqual([]);
  });

  it.each(TREES)('%s/*.ts have no top-level side effects', (dir) => {
    const files = listTs(path.join(SRC, dir));
    expect(files.length).toBeGreaterThan(0);
    const found = files.flatMap((f) => topLevelSideEffects(read(f)).map((line) => `${rel(f)}: ${line}`));
    expect(found).toEqual([]);
  });

  it('every browser.* listener is registered from an entry', () => {
    // A module that removes every listener it adds (tab-wait.ts, for the
    // length of one wait) registers nothing permanent.
    const registering = listTs(SRC)
      .filter((f) => count(read(f), BROWSER_LISTENER_RE) > count(read(f), REMOVE_LISTENER_RE))
      .map(rel)
      .sort();
    expect(registering).toEqual([...LISTENER_FILES].sort());
  });

  it('background.ts calls each registration once, and nothing else calls them', () => {
    const entry = read(path.join(SRC, 'background.ts'));
    for (const fn of REGISTRARS) {
      expect(count(entry, new RegExp(`^${fn}\\(\\);$`, 'gm')), fn).toBe(1);
    }
    const callers = listTs(SRC)
      .filter((f) => rel(f) !== 'background.ts')
      .filter((f) => new RegExp(`(?<!function )\\b(${REGISTRARS.join('|')})\\(`).test(read(f)))
      .map(rel);
    expect(callers).toEqual([]);
  });

  it('the cycle check finds a cycle', () => {
    const toy = new Map([['a.ts', ['b.ts']], ['b.ts', ['c.ts']], ['c.ts', ['a.ts']], ['d.ts', ['a.ts']]]);
    expect(findCycles(toy)).toEqual([['a.ts', 'b.ts', 'c.ts', 'a.ts']]);
  });

  it('the side-effect check sees what it is meant to see', () => {
    expect(topLevelSideEffects('browser.runtime.onMessage.addListener(() => {});')).toHaveLength(1);
    expect(topLevelSideEffects('(function () {})();')).toHaveLength(1);
    expect(topLevelSideEffects('const x = document.readyState;')).toHaveLength(1);
    expect(topLevelSideEffects('let n = 0;\nexport const m = new Map<string, number>();\nexport function f(): void {\n  browser.x();\n}')).toEqual([]);
  });
});
