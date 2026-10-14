/**
 * Static HTTP server for the local test pages of the smoke scripts
 * (scripts/e2e/fixtures/). Node's http only, bound to 127.0.0.1 on a free
 * port, so the smoke tests need no internet access.
 *
 * Only the .html files directly in the directory are served (GET / HEAD);
 * anything else is 404.
 */

import { readdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fixtureFileFor } from './smoke-core.mjs';

/** The test pages of reviewer-smoke.mjs and tools-smoke.mjs. */
export const REVIEWER_FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'reviewer');

/**
 * The pages in REVIEWER_FIXTURES, with their <title> and <h1> as in the HTML
 * (tests/scripts/reviewer-smoke.test.ts checks that they still match).
 */
export const REVIEWER_PAGES = {
  page1: { file: 'index.html', title: 'InariMCP reviewer smoke: page 1', heading: 'InariMCP reviewer smoke test' },
  page2: { file: 'page2.html', title: 'InariMCP reviewer smoke: page 2', heading: 'Page 2' },
};

/**
 * Serve the .html files of `dir`.
 * @param {string} dir
 * @returns {Promise<{baseUrl: string, close: () => Promise<void>}>}  baseUrl ends with '/'
 */
export async function startFixtureServer(dir) {
  const pages = new Map(
    readdirSync(dir)
      .filter((name) => name.endsWith('.html'))
      .map((name) => [name, readFileSync(path.join(dir, name))]),
  );
  const fileNames = [...pages.keys()];

  const server = http.createServer((req, res) => {
    const name = fixtureFileFor(req.url ?? '/', fileNames);
    const isRead = req.method === 'GET' || req.method === 'HEAD';
    if (name === null || !isRead) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : pages.get(name));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/`,
    // Firefox keeps its connections open; close() alone would wait for them.
    close: () => new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}
