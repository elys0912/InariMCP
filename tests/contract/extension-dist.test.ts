/**
 * The built Extension runs no code given as a string and writes no HTML
 * from a string (AMO policies: no remote code, no eval; the Notes for
 * Reviewers say so). Checked on every bundle of packages/extension/dist that
 * the xpi ships, not on the sources:
 *   - tabs.executeScript is never called with `code` (with a `file` only;
 *     today it is not called at all);
 *   - no `eval(` and no `new Function(`;
 *   - no string as the first argument of setTimeout / setInterval;
 *   - no innerHTML, insertAdjacentHTML or document.write.
 *
 * Needs `npm run build` first. BUNDLES is the list of bundles
 * scripts/build-extension.mjs writes; dist must hold exactly those scripts,
 * so a bundle added to the build without being added here fails the test.
 * A missing bundle fails the test too (it is not skipped), so the checks
 * cannot pass by having nothing to read.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DIST = new URL('../../packages/extension/dist/', import.meta.url);

/** The entryPoints of scripts/build-extension.mjs, as dist paths. */
const BUNDLES = ['background.js', 'content.js', 'popup/popup.js', 'consent/consent.js'] as const;

function readBundle(file: string): string {
  const full = fileURLToPath(new URL(file, DIST));
  if (!existsSync(full)) {
    throw new Error(`packages/extension/dist/${file} is missing: run npm run build first`);
  }
  return readFileSync(full, 'utf-8');
}

/** Every script file under dist, as a path relative to it with `/`. */
function distScripts(): string[] {
  const entries = readdirSync(fileURLToPath(DIST), { recursive: true, encoding: 'utf-8' });
  return entries.map((entry) => entry.split('\\').join('/')).filter((entry) => entry.endsWith('.js')).sort();
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

/** A setTimeout / setInterval call whose first argument is a string literal (code to evaluate). */
const STRING_TIMER_RE = /\bset(?:Timeout|Interval)\s*\(\s*['"`]/g;

/** Writing HTML from a string. */
const HTML_SINK_RE = /\.(?:innerHTML|outerHTML)\b|\binsertAdjacentHTML\b|\bdocument\s*\.\s*write(?:ln)?\s*\(/g;

describe('extension dist: no code strings are run', () => {
  it('dist holds the bundles of the build and no other script', () => {
    expect(distScripts()).toEqual([...BUNDLES].sort());
  });

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

  it.each(BUNDLES)('%s passes no string to setTimeout or setInterval', (file) => {
    expect(readBundle(file).match(STRING_TIMER_RE) ?? []).toEqual([]);
  });

  it.each(BUNDLES)('%s writes no HTML from a string (innerHTML, outerHTML, insertAdjacentHTML, document.write)', (file) => {
    expect(readBundle(file).match(HTML_SINK_RE) ?? []).toEqual([]);
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

    for (const call of ['setTimeout("x()", 1)', "window.setInterval( 'x()', 1)", 'setTimeout(\n  `x()`)']) {
      expect(call.match(STRING_TIMER_RE), call).toHaveLength(1);
    }
    expect('setTimeout(() => x(), 1); setInterval(tick, delay)'.match(STRING_TIMER_RE)).toBeNull();

    for (const sink of ['el.innerHTML = s', 'el.outerHTML = s', 'el.insertAdjacentHTML("beforeend", s)', 'document.write(s)', 'document.writeln(s)']) {
      expect(sink.match(HTML_SINK_RE), sink).toHaveLength(1);
    }
    expect('el.textContent = s; label.innerText = s; writer.write(s)'.match(HTML_SINK_RE)).toBeNull();
  });
});
