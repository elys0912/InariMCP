#!/usr/bin/env node
// Smoke test for add-on reviewers (docs/amo/reviewer-smoke.md): checks the
// basic features with a local test page, without Claude Code, any account or
// internet access.
//
//   1. Serves scripts/e2e/fixtures/reviewer/ on 127.0.0.1 (a free port).
//   2. Starts the MCP server (packages/mcp-server/dist/index.js) over stdio,
//      as an MCP client does; it connects to the daemon or starts one.
//   3. Calls the tools as an MCP client (@modelcontextprotocol/sdk): fox_tabs,
//      fox_tab create, fox_read (password and hidden fields are [MASKED]),
//      fox_find, fox_screenshot (a file is written), fox_click (the human
//      approves it in the add-on's toolbar popup; the page moves to page 2),
//      fox_tab close.
//   4. Prints a table; exit code 1 when a check FAILs.
//
// The script installs nothing and never approves anything itself: the
// client declares no MCP elicitation, so the MCP server asks in Firefox.
// Prerequisites: npm run build; npm run setup (Native Messaging host);
// Firefox running with the add-on (from AMO or `npx web-ext run`), its
// first-run permission allowed.
//
// --headless: the daemon drives Playwright's Firefox instead (no add-on, no
// native host; needs `npx playwright install firefox`). It runs on free
// ports, so a daemon in use is not touched, and is stopped at the end.
// Headless mode has no popup: a call that needs approval is reported as
// SKIP, and fox_read returns only the URL and title (no mask check).
//
// Usage: npm run smoke:reviewer [-- --headless]
// Exit code: 0 = no check failed, 1 = a check failed, 2 = bad arguments

import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { dataPaths, httpEndpoint } from '../lib/core.mjs';
import { httpGet, httpPost, stopDaemonGracefully } from '../lib/system.mjs';
import { REVIEWER_FIXTURES, startFixtureServer } from './fixture-server.mjs';
import { formFieldValues, formatTable, interpretToolResult, needsApproval, parseReviewerSmokeArgs, truncate } from './smoke-core.mjs';

const USAGE = `Usage: npm run smoke:reviewer [-- --headless]
       node scripts/e2e/reviewer-smoke.mjs [--headless]

Checks the basic features against a local test page (127.0.0.1) as an MCP
client: tabs, read (masked fields), find, screenshot, click (you approve it
in the add-on's toolbar popup) and closing the tab.

  --headless  use the daemon's headless Firefox (Playwright) instead of
              Firefox with the add-on; no approval popup there
  -h, --help  show this help

Exit code: 0 = no check failed, 1 = a check failed, 2 = bad arguments.
`;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SERVER_ENTRY = path.join(ROOT, 'packages', 'mcp-server', 'dist', 'index.js');

/** One tool call; an approval needs longer (the popup waits 60 s, the request expires after 120 s). */
const CALL_TIMEOUT_MS = 90_000;
const APPROVAL_CALL_TIMEOUT_MS = 180_000;
/** How long to wait for Firefox with the add-on to connect, and for a page to load. */
const BROWSER_WAIT_MS = 30_000;
const PAGE_WAIT_MS = 15_000;
const POLL_MS = 500;
/** Grace for the headless daemon to stop at the end. */
const SHUTDOWN_GRACE_MS = 10_000;
/** Lines of the MCP server's stderr shown when a check failed. */
const STDERR_TAIL_LINES = 30;
/** Characters of a check's detail in the table, and on its progress line (a screenshot path stays whole). */
const TABLE_DETAIL_LENGTH = 80;
const LINE_DETAIL_LENGTH = 300;

/** As in fixtures/reviewer/*.html. */
const PAGE_1 = { file: 'index.html', title: 'InariMCP reviewer smoke: page 1', heading: 'InariMCP reviewer smoke test' };
const PAGE_2 = { file: 'page2.html', title: 'InariMCP reviewer smoke: page 2' };
const LINK_TO_PAGE_2 = '#to-page-2';
const SECRET_VALUES = { password: 'reviewer-smoke-password-value', hidden: 'reviewer-smoke-hidden-value' };
const MASK = '[MASKED]';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function playwrightFirefox() {
  try {
    const require = createRequire(path.join(ROOT, 'packages', 'mcp-server', 'package.json'));
    return require('playwright').firefox.executablePath();
  } catch {
    return undefined;
  }
}

/** Browsers connected to the daemon at `endpoint` (0 when nothing answers). */
async function connectedBrowsers(endpoint) {
  const res = await httpGet({ ...endpoint, urlPath: '/health' });
  if (!res) return 0;

  try {
    return Number(JSON.parse(res.body.toString('utf8')).browsers_connected) || 0;
  } catch {
    return 0;
  }
}

async function waitForBrowser(endpoint) {
  console.log(`Waiting up to ${BROWSER_WAIT_MS / 1000} s for Firefox with the add-on to connect ...`);
  const deadline = Date.now() + BROWSER_WAIT_MS;
  while (Date.now() < deadline) {
    if (await connectedBrowsers(endpoint) > 0) return true;
    await sleep(POLL_MS);
  }

  return false;
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

/** Rows of the result table, printed as they come. */
const rows = [];

function report(check, tool, result, detail = '') {
  rows.push({ n: rows.length + 1, check, tool, result, detail: truncate(detail, TABLE_DETAIL_LENGTH) });
  console.log(`${result.padEnd(4)}  ${check}${detail ? `  — ${truncate(detail, LINE_DETAIL_LENGTH)}` : ''}`);
}

/**
 * Report a check of a call. A call the human did not approve is a FAIL
 * (SKIP in headless mode: nobody can be asked there).
 */
function judge(ctx, check, tool, res, passed, detail) {
  if (res.approvalMissing) {
    if (ctx.headless) report(check, tool, 'SKIP', 'needs human approval; headless mode has no popup');
    else report(check, tool, 'FAIL', `not approved: ${res.text}`);
    return false;
  }

  report(check, tool, passed ? 'PASS' : 'FAIL', passed ? detail : `${detail} ${res.isError ? res.text : ''}`.trim());
  return passed;
}

function printApprovalHint(ctx, tool) {
  if (ctx.headless) return;
  console.log(`      ${tool}: if the InariMCP toolbar button shows a badge, open its popup and press "Approve".`);
}

/** Poll fox_read until the tab shows `page` (by title); the last answer. */
async function waitForPage(ctx, tabId, page) {
  const deadline = Date.now() + PAGE_WAIT_MS;
  for (;;) {
    const res = await ctx.call('fox_read', { mode: 'info', tabId });
    if (res.data?.title === page.title) return { ...res, loaded: true };
    if (Date.now() >= deadline) return { ...res, loaded: false };
    await sleep(POLL_MS);
  }
}

function checkMasked(ctx, info, type) {
  const check = `fox_read: ${type} field is ${MASK}`;
  if (ctx.headless) {
    report(check, 'fox_read', 'SKIP', 'headless fox_read returns only the URL and title');
    return;
  }

  const values = formFieldValues(info.data, type);
  const leaked = info.text.includes(SECRET_VALUES[type]);
  const masked = values.length > 0 && values.every((v) => v === MASK) && !leaked;
  report(check, 'fox_read', masked ? 'PASS' : 'FAIL', leaked ? 'the field value appears in the answer' : `values: ${JSON.stringify(values)}`);
}

async function checkTabs(ctx) {
  const res = await ctx.call('fox_tabs', { what: 'tabs' });
  const tabs = res.data?.tabs;
  judge(ctx, 'fox_tabs: list the tabs', 'fox_tabs', res, !res.isError && Array.isArray(tabs), `tabs=${tabs?.length}`);
}

/** Open page 1 in a new tab; its tab ID, or undefined. */
async function openTestPage(ctx) {
  const url = new URL(PAGE_1.file, ctx.baseUrl).href;
  printApprovalHint(ctx, 'fox_tab create');
  const res = await ctx.call('fox_tab', { action: 'create', url, active: true });
  // The Extension answers tab.id, headless tabId.
  const tabId = res.data?.tabId ?? res.data?.tab?.id;
  const opened = judge(ctx, 'fox_tab create: open the local test page', 'fox_tab', res, !res.isError && Number.isInteger(tabId), url);

  return opened ? tabId : undefined;
}

async function checkRead(ctx, tabId) {
  const info = await waitForPage(ctx, tabId, PAGE_1);
  judge(ctx, 'fox_read: page 1 is loaded', 'fox_read', info, !info.isError && info.loaded, `title: ${info.data?.title}`);
  checkMasked(ctx, info, 'password');
  checkMasked(ctx, info, 'hidden');
}

async function checkFind(ctx, tabId) {
  const res = await ctx.call('fox_find', { by: 'text', text: PAGE_1.heading, tabId });
  const count = res.data?.count;
  judge(ctx, 'fox_find: find the heading text', 'fox_find', res, !res.isError && count >= 1, `count=${count}`);
}

async function checkScreenshot(ctx, tabId) {
  const res = await ctx.call('fox_screenshot', { scope: 'viewport', tabId });
  const imagePath = res.data?.imagePath;
  const written = typeof imagePath === 'string' && existsSync(imagePath) && statSync(imagePath).size > 0;
  judge(ctx, 'fox_screenshot: a PNG file is written', 'fox_screenshot', res, !res.isError && written, imagePath ?? '');
}

async function checkClick(ctx, tabId) {
  if (ctx.headless) {
    console.log('      fox_click: headless mode has no approval popup.');
  } else {
    console.log('');
    console.log('      fox_click is an action on the page: Inari MCP for Firefox asks you before it runs.');
    console.log('      Click the InariMCP button in the Firefox toolbar (it shows a badge) and press "Approve".');
    console.log('      Waiting for your answer (the popup gives you 60 s). This script never approves by itself.');
  }

  const res = await ctx.call('fox_click', { selector: LINK_TO_PAGE_2, tabId }, APPROVAL_CALL_TIMEOUT_MS);
  const check = ctx.headless ? 'fox_click: click "Go to page 2"' : 'fox_click: click "Go to page 2" (after your approval)';
  if (!judge(ctx, check, 'fox_click', res, !res.isError, LINK_TO_PAGE_2)) return;

  const page2 = await waitForPage(ctx, tabId, PAGE_2);
  judge(ctx, 'fox_click: the tab moved to page 2', 'fox_read', page2, !page2.isError && page2.loaded, page2.data?.url ?? '');
}

/** Close the tab; whether it is gone. */
async function closeTestPage(ctx, tabId) {
  printApprovalHint(ctx, 'fox_tab close');
  const res = await ctx.call('fox_tab', { action: 'close', tabId });
  const after = await ctx.call('fox_tabs', { what: 'tabs' });
  const isGone = Array.isArray(after.data?.tabs) && !after.data.tabs.some((t) => t.id === tabId);

  return judge(ctx, 'fox_tab close: close the test tab', 'fox_tab', res, !res.isError && isGone, `tabId=${tabId}`);
}

async function runChecks(ctx) {
  await checkTabs(ctx);
  const tabId = await openTestPage(ctx);
  if (tabId === undefined) {
    report('remaining checks', '-', 'SKIP', 'no test tab');
    return;
  }

  try {
    await checkRead(ctx, tabId);
    await checkFind(ctx, tabId);
    await checkScreenshot(ctx, tabId);
    await checkClick(ctx, tabId);
  } finally {
    await closeTestPage(ctx, tabId);
  }
}

// ---------------------------------------------------------------------------
// Set-up and tear-down
// ---------------------------------------------------------------------------

/** The MCP server over stdio, as an MCP client starts it; stderr is kept for the report. */
async function connectClient(env) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER_ENTRY], env, stderr: 'pipe' });
  const stderrLines = [];
  transport.stderr?.on('data', (chunk) => {
    stderrLines.push(...chunk.toString('utf8').split(/\r?\n/).filter((l) => l !== ''));
    stderrLines.splice(0, Math.max(0, stderrLines.length - STDERR_TAIL_LINES));
  });
  // No capabilities: without elicitation the approval goes to the Firefox popup.
  const client = new Client({ name: 'inari-reviewer-smoke', version: '0.0.0' });
  await client.connect(transport);

  return { client, stderrLines };
}

function toolCaller(client) {
  return async (name, args, timeout = CALL_TIMEOUT_MS) => {
    try {
      const result = await client.callTool({ name, arguments: args }, undefined, { timeout });
      return { ...interpretToolResult(result), approvalMissing: needsApproval(result) };
    } catch (err) {
      return { isError: true, text: err instanceof Error ? err.message : String(err), data: undefined, content: [], approvalMissing: false };
    }
  };
}

/** Where the daemon listens, and the environment of the MCP server. */
async function daemonSettings(headless) {
  if (!headless) {
    return { endpoint: httpEndpoint(process.env), env: { ...process.env, FOX_HEADLESS: '0' } };
  }

  const httpPort = await freePort();
  const wsPort = await freePort();
  const env = {
    ...process.env,
    FOX_HEADLESS: '1',
    FOX_HOST: '127.0.0.1',
    FOX_HTTP_PORT: String(httpPort),
    FOX_WS_PORT: String(wsPort),
    // A daemon left behind (stop failed) exits soon by itself.
    FOX_DAEMON_IDLE_TIMEOUT: '30',
  };
  return { endpoint: { host: '127.0.0.1', port: httpPort }, env };
}

async function stopHeadlessDaemon(endpoint) {
  const { tokenPath } = dataPaths(process.platform, homedir());
  if (!existsSync(tokenPath)) return;

  const token = readFileSync(tokenPath, 'utf8').trim();
  const outcome = await stopDaemonGracefully({ httpGet, httpPost, sleep }, endpoint, token, SHUTDOWN_GRACE_MS);
  if (outcome !== 'stopped') {
    console.log(`note: the headless daemon on port ${endpoint.port} did not stop (${outcome}); it exits by itself when idle`);
  }
}

function precheck(headless) {
  if (!existsSync(SERVER_ENTRY)) return `${SERVER_ENTRY} not found: run npm run build first`;
  if (!headless) return undefined;

  const firefox = playwrightFirefox();
  if (!firefox || !existsSync(firefox)) return "Playwright's Firefox not found: run npx playwright install firefox";
  return undefined;
}

function printBrowserHelp() {
  console.log(`No Firefox with the add-on is connected. Check that:
  - npm run setup was run (Native Messaging host registered),
  - Firefox runs with Inari MCP for Firefox installed,
  - "Allow" was pressed on the add-on's first-run page, and the popup is not paused.
Diagnose with: node packages/mcp-server/dist/index.js --doctor`);
}

function printSummary(stderrLines) {
  const count = (result) => rows.filter((r) => r.result === result).length;
  console.log('');
  console.log(formatTable({ n: '#', check: 'Check', tool: 'Tool', result: 'Result', detail: 'Detail' }, rows));
  console.log('');
  console.log(`${count('PASS')} PASS, ${count('FAIL')} FAIL, ${count('SKIP')} SKIP`);
  if (count('FAIL') > 0 && stderrLines.length > 0) {
    console.log(`--- MCP server stderr (last ${stderrLines.length} lines) ---\n${stderrLines.join('\n')}`);
  }

  return count('FAIL') === 0 && count('PASS') > 0;
}

async function main() {
  const args = parseReviewerSmokeArgs(process.argv.slice(2));
  if (args.error) {
    process.stderr.write(`reviewer-smoke: ${args.error}\n\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const problem = precheck(args.headless);
  if (problem) {
    console.error(problem);
    return 1;
  }

  const { endpoint, env } = await daemonSettings(args.headless);
  console.log(`mode: ${args.headless ? 'headless (Playwright Firefox, no add-on)' : 'Firefox with the add-on'}`);
  if (!args.headless && !(await waitForBrowser(endpoint))) {
    printBrowserHelp();
    return 1;
  }

  const fixtures = await startFixtureServer(REVIEWER_FIXTURES);
  console.log(`test page: ${fixtures.baseUrl}${PAGE_1.file}\n`);
  let session;
  try {
    session = await connectClient(env);
    await runChecks({ headless: args.headless, baseUrl: fixtures.baseUrl, call: toolCaller(session.client) });
  } catch (err) {
    report('MCP connection', '-', 'FAIL', err instanceof Error ? err.message : String(err));
  } finally {
    await session?.client.close();
    if (args.headless) await stopHeadlessDaemon(endpoint);
    await fixtures.close();
  }

  return printSummary(session?.stderrLines ?? []) ? 0 : 1;
}

process.exit(await main());
