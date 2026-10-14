#!/usr/bin/env node
// Tool smoke test against a real Firefox: calls fox_* tools through the
// daemon's HTTP API (POST /mcp/call) and checks the results.
//
// Prerequisites: installer run, Firefox running with the extension loaded
// (`curl -s http://127.0.0.1:8785/health` shows "browsers_connected":1).
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
// It serves the local test pages of scripts/e2e/fixtures/reviewer/ on
// 127.0.0.1, opens page 1 in the active tab and page 2 in a new tab (closed
// again at the end). No internet access is needed.
//
// Usage: node scripts/e2e/tools-smoke.mjs
//   FOX_HOST / FOX_HTTP_PORT override the daemon address (default 127.0.0.1:8785;
//   same rules as the installer: loopback hosts only, legacy CLAUDE_BROWSER_* names)
// Requests are signed with the API token (the token itself is never sent).
// Exit code: 0 = all checks pass, 1 = at least one failed

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dataPaths, httpEndpoint, signPost } from '../lib/core.mjs';
import { httpGet, httpPost } from '../lib/system.mjs';
import { REVIEWER_FIXTURES, startFixtureServer } from './fixture-server.mjs';
import { interpretCallResponse, truncate as short } from './smoke-core.mjs';

const CALL_TIMEOUT_MS = 60_000;

const endpoint = httpEndpoint(process.env);
const base = `http://${endpoint.host.includes(':') ? `[${endpoint.host}]` : endpoint.host}:${endpoint.port}`;
const { tokenPath } = dataPaths(process.platform, homedir());
if (!existsSync(tokenPath)) {
  console.error(`API token not found: ${tokenPath} (is the daemon running?)`);
  process.exit(1);
}
const apiToken = readFileSync(tokenPath, 'utf8').trim();

const healthRes = await httpGet({ ...endpoint, urlPath: '/health' });
let health;
try { health = healthRes ? JSON.parse(healthRes.body.toString('utf8')) : undefined; } catch { health = undefined; }
if (!health?.browsers_connected) {
  console.error(`no browser connected (${base}/health: ${JSON.stringify(health) ?? 'no answer'})`);
  process.exit(1);
}

async function call(name, args = {}) {
  const body = JSON.stringify({ name, arguments: args });
  const signed = signPost(apiToken, '/mcp/call', body);
  const res = await httpPost({ ...endpoint, urlPath: '/mcp/call', headers: signed.headers, body, timeoutMs: CALL_TIMEOUT_MS });
  return interpretCallResponse(res);
}

const results = [];
function check(label, cond, detail = '') {
  results.push(Boolean(cond));
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
}
const tabCount = (r) => (Array.isArray(r.data?.tabs) ? r.data.tabs.length : NaN);

const fixtures = await startFixtureServer(REVIEWER_FIXTURES);
const page1 = `${fixtures.baseUrl}index.html`;
const page2 = `${fixtures.baseUrl}page2.html`;
const heading = 'InariMCP reviewer smoke test';

const tabs0 = await call('fox_get_tabs');
const before = tabCount(tabs0);
check('fox_get_tabs', !tabs0.isError && before >= 1, `tabs=${before}`);

const nav = await call('fox_navigate', { action: 'goto', url: page1 });
check('fox_navigate goto', !nav.isError, short(nav.text));

const info = await call('fox_get_page_info');
check('fox_get_page_info', !info.isError && info.data?.url === page1, short(info.data?.title));

const text = await call('fox_get_text');
check('fox_get_text', !text.isError && (text.data?.text ?? '').includes(heading), short(text.data?.text, 60));

const find = await call('fox_find_text', { query: heading });
check('fox_find_text', !find.isError && find.data?.count >= 1, `count=${find.data?.count}`);

const opened = await call('fox_navigate', { action: 'goto', url: page2, newTab: true });
const newTabId = opened.data?.tabId;
check('fox_navigate newTab', !opened.isError && newTabId !== undefined, short(opened.text));
const tabs1 = await call('fox_get_tabs');
const newTab = tabs1.data?.tabs?.find((t) => t.id === newTabId);
check('  new tab is open on page 2', newTab?.url === page2, `tabs ${before} -> ${tabCount(tabs1)}`);

const shot = await call('fox_screenshot', { scope: 'viewport' });
const imagePath = shot.data?.imagePath;
check('fox_screenshot', !shot.isError && imagePath && existsSync(imagePath), imagePath ?? short(shot.text));

if (newTabId !== undefined) {
  const close = await call('fox_close_tab', { tabId: newTabId });
  const tabs2 = await call('fox_get_tabs');
  check('fox_close_tab', !close.isError && tabCount(tabs2) === before, `tabs -> ${tabCount(tabs2)}`);
} else {
  check('fox_close_tab', false, 'skipped: no new tab');
}

const safety = await call('fox_safety_status');
check('fox_safety_status', !safety.isError && safety.data !== undefined && safety.data.success !== false, short(safety.text, 80));

await fixtures.close();

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} PASS`);
process.exit(passed === results.length ? 0 : 1);
