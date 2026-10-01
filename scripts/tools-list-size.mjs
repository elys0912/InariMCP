#!/usr/bin/env node
/**
 * Size of tools/list (the tool definitions an MCP client puts into the
 * model's context), from the golden files of tests/contract/tools-list.test.ts.
 *
 *   node scripts/tools-list-size.mjs
 *
 * Regenerate the golden files first when the tools changed:
 *   UPDATE_GOLDEN=1 npx vitest run tests/contract/tools-list.test.ts
 *
 * Tokens are an estimate (characters / 4 of the compact JSON); no tokenizer
 * is bundled. Compare the two lists with the same estimate, not with
 * counts from a real tokenizer.
 */

import * as fs from 'node:fs';

const LISTS = [
  ['default (public tools)', 'tests/golden/tools-list.json'],
  ['FOX_CAPS=legacy', 'tests/golden/tools-list-legacy.json'],
];

const rows = LISTS.map(([label, file]) => {
  const tools = JSON.parse(fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf-8'));
  const chars = JSON.stringify({ tools }).length;
  return { label, tools: tools.length, chars, tokens: Math.round(chars / 4) };
});

for (const r of rows) {
  console.log(`${r.label.padEnd(24)} ${String(r.tools).padStart(3)} tools  ${String(r.chars).padStart(7)} chars  ~${r.tokens} tokens`);
}
const [now, legacy] = rows;
console.log(`default / legacy: ${(100 * now.chars / legacy.chars).toFixed(1)} %`);
