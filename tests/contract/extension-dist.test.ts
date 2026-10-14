/**
 * The built Extension runs no code given as a string (AMO policies: no
 * remote code, no eval). Checked on the bundles of packages/extension/dist
 * that the xpi ships, not on the sources:
 *   - tabs.executeScript is only called with a `file` (a file of the
 *     package), never with `code`;
 *   - no `eval(` and no `new Function(`.
 *
 * Needs `npm run build` first. A missing bundle fails the test (it is not
 * skipped), so the check cannot pass by having nothing to read.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DIST = new URL('../../packages/extension/dist/', import.meta.url);

const BUNDLES = ['background.js', 'content.js', 'popup/popup.js'] as const;

function readBundle(file: string): string {
  const full = fileURLToPath(new URL(file, DIST));
  if (!existsSync(full)) {
    throw new Error(`packages/extension/dist/${file} is missing: run npm run build first`);
  }
  return readFileSync(full, 'utf-8');
}

/**
 * The argument text of every `executeScript(` call: from the opening
 * parenthesis to its match. Parentheses inside strings are not told apart,
 * which is fine for the object literal the call takes.
 */
function executeScriptArguments(code: string): string[] {
  const out: string[] = [];
  for (const match of code.matchAll(/\bexecuteScript\s*\(/g)) {
    const open = match.index + match[0].length - 1;
    let depth = 0;
    let end = open;
    for (; end < code.length; end++) {
      if (code[end] === '(') depth++;
      else if (code[end] === ')' && --depth === 0) break;
    }
    out.push(code.slice(open + 1, end));
  }
  return out;
}

describe('extension dist: no code strings are run', () => {
  it.each(BUNDLES)('%s exists (npm run build)', (file) => {
    expect(readBundle(file).length).toBeGreaterThan(0);
  });

  it.each(BUNDLES)('%s calls executeScript with a file only, never with code', (file) => {
    for (const args of executeScriptArguments(readBundle(file))) {
      expect(args, args).toMatch(/\{\s*file\s*:/);
      expect(args, args).not.toMatch(/\bcode\s*:/);
    }
  });

  it.each(BUNDLES)('%s has no eval( and no new Function(', (file) => {
    const code = readBundle(file);
    expect(code.match(/\beval\s*\(/g) ?? []).toEqual([]);
    expect(code.match(/\bnew\s+Function\s*\(/g) ?? []).toEqual([]);
  });

  // The checks above must see a call written in either form, or they would
  // pass on any bundle.
  it('the checks find what they look for', () => {
    expect(executeScriptArguments('browser.tabs.executeScript(1, { code: "x()" })')).toEqual(['1, { code: "x()" }']);
    expect(executeScriptArguments('tabs.executeScript(id, { file: "/dist/content.js", frameId: 0 })'))
      .toEqual(['id, { file: "/dist/content.js", frameId: 0 }']);
    expect('window.eval("1")').toMatch(/\beval\s*\(/);
    expect('new Function("return 1")').toMatch(/\bnew\s+Function\s*\(/);
    expect('document.evaluate(xpath, document)').not.toMatch(/\beval\s*\(/);
  });
});
