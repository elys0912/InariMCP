#!/usr/bin/env node
// Tool smoke test against a real Firefox: calls fox_* tools through the
// daemon's HTTP API (POST /mcp/call) and checks the results.
//
// Prerequisites: installer run, Firefox running with the extension loaded
// (`curl -s http://127.0.0.1:8765/health` shows "browsers_connected":1).
// For a throwaway profile with the extension loaded as a temporary add-on
// (web-ext is a devDependency; run from the repository root):
//   npx web-ext run --start-url about:blank
//
// Related checks that need no installed extension:
//   npm run test:e2e        relay → daemon → headless Firefox over MCP
//                           (tests/e2e/relay-headless.e2e.test.ts)
//   npm run e2e:extension   the extension loads as a temporary add-on
//                           (scripts/e2e/extension-load.mjs)
// This script covers the remaining path: daemon → Native Host → Extension.
//
// It opens https://example.com/ in the active tab and https://example.org/
// in a new tab (closed again at the end). Needs internet access.
//
// Usage: node scripts/e2e/tools-smoke.mjs
//   FOX_HOST / FOX_HTTP_PORT override the daemon address (default 127.0.0.1:8765)
// Exit code: 0 = all checks pass, 1 = at least one failed

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const base = `http://${process.env.FOX_HOST || '127.0.0.1'}:${process.env.FOX_HTTP_PORT || '8765'}`;
const tokenPath = path.join(homedir(), '.kitsune-mcp', 'api_token');
if (!existsSync(tokenPath)) {
  console.error(`API token not found: ${tokenPath} (is the daemon running?)`);
  process.exit(1);
}
const apiKey = readFileSync(tokenPath, 'utf8').trim();

const health = await fetch(`${base}/health`).then((r) => r.json()).catch(() => undefined);
if (!health?.browsers_connected) {
  console.error(`no browser connected (${base}/health: ${JSON.stringify(health) ?? 'no answer'})`);
  process.exit(1);
}

async function call(name, args = {}) {
  const res = await fetch(`${base}/mcp/call`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
    body: JSON.stringify({ name, arguments: args }),
  });
  // The HTTP API wraps the MCP CallToolResult: { success, result }
  const outer = await res.json();
  const result = outer.result ?? {};
  const text = (result.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  let data;
  try { data = JSON.parse(text); } catch { data = undefined; }
  return { isError: outer.success === false || Boolean(result.isError), text, data, content: result.content ?? [] };
}

const results = [];
function check(label, cond, detail = '') {
  results.push(Boolean(cond));
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
}
const short = (s, n = 120) => String(s ?? '').replace(/\s+/g, ' ').slice(0, n);
const tabCount = (r) => (Array.isArray(r.data?.tabs) ? r.data.tabs.length : NaN);

const tabs0 = await call('fox_get_tabs');
const before = tabCount(tabs0);
check('fox_get_tabs', !tabs0.isError && before >= 1, `tabs=${before}`);

const nav = await call('fox_navigate', { action: 'goto', url: 'https://example.com/' });
check('fox_navigate goto', !nav.isError, short(nav.text));

const info = await call('fox_get_page_info');
check('fox_get_page_info', !info.isError && info.data?.url === 'https://example.com/', short(info.data?.title));

const text = await call('fox_get_text');
check('fox_get_text', !text.isError && /Example Domain/.test(text.data?.text ?? ''), short(text.data?.text, 60));

const find = await call('fox_find_text', { query: 'Example Domain' });
check('fox_find_text', !find.isError && find.data?.count >= 1, `count=${find.data?.count}`);

const opened = await call('fox_navigate', { action: 'goto', url: 'https://example.org/', newTab: true });
const newTabId = opened.data?.tabId;
check('fox_navigate newTab', !opened.isError && newTabId !== undefined, short(opened.text));
const tabs1 = await call('fox_get_tabs');
const newTab = tabs1.data?.tabs?.find((t) => t.id === newTabId);
check('  new tab is open on example.org', /example\.org/.test(newTab?.url ?? ''), `tabs ${before} -> ${tabCount(tabs1)}`);

const shot = await call('fox_screenshot', { scope: 'viewport' });
const imagePath = shot.data?.imagePath;
check('fox_screenshot', !shot.isError && imagePath && existsSync(imagePath), imagePath ?? short(shot.text));

if (newTabId !== undefined) {
  const close = await call('fox_close_tab', { tabId: newTabId });
  const tabs2 = await call('fox_get_tabs');
  check('fox_close_tab', !close.isError && tabCount(tabs2) === before, `tabs -> ${tabCount(tabs2)}`);
}

const safety = await call('fox_safety_status');
check('fox_safety_status', !safety.isError && safety.data?.success !== false, short(safety.text, 80));

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} PASS`);
process.exit(passed === results.length ? 0 : 1);
