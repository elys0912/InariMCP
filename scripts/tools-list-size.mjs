#!/usr/bin/env node
/**
 * Size of tools/list (the tool definitions an MCP client puts into the
 * model's context), from the golden file of tests/contract/tools-list.test.ts.
 *
 *   node scripts/tools-list-size.mjs
 *
 * Regenerate the golden file first when the tools changed:
 *   UPDATE_GOLDEN=1 npx vitest run tests/contract/tools-list.test.ts
 *
 * Tokens are an estimate (characters / 4 of the compact JSON); no tokenizer
 * is bundled. Compare sizes with the same estimate, not with counts from a
 * real tokenizer.
 */

import * as fs from 'node:fs';

const tools = JSON.parse(fs.readFileSync(new URL('../tests/golden/tools-list.json', import.meta.url), 'utf-8'));
const chars = JSON.stringify({ tools }).length;
console.log(`${tools.length} tools  ${chars} chars  ~${Math.round(chars / 4)} tokens`);
