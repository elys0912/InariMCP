/**
 * scripts/e2e/reviewer-smoke.mjs: its helpers (smoke-core.mjs), its fixture
 * server (fixture-server.mjs) and its arguments; no daemon or Firefox is
 * started.
 */

import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REVIEWER_FIXTURES, startFixtureServer } from '../../scripts/e2e/fixture-server.mjs';
import {
  fixtureFileFor,
  formFieldValues,
  formatTable,
  interpretToolResult,
  needsApproval,
  parseReviewerSmokeArgs,
} from '../../scripts/e2e/smoke-core.mjs';

describe('reviewer-smoke: interpretToolResult', () => {
  it('joins the text blocks and parses them as JSON', () => {
    const r = interpretToolResult({ content: [{ type: 'text', text: '{"tabId":3}' }, { type: 'resource_link', uri: 'file:///x.png' }] });
    expect(r.isError).toBe(false);
    expect(r.data).toEqual({ tabId: 3 });
    expect(r.content).toHaveLength(2);
  });

  it('keeps isError and leaves data undefined for text that is not one JSON document', () => {
    const r = interpretToolResult({ isError: true, content: [{ type: 'text', text: 'Browser error: boom' }] });
    expect(r.isError).toBe(true);
    expect(r.text).toBe('Browser error: boom');
    expect(r.data).toBeUndefined();
  });

  it('treats a result without content as empty', () => {
    expect(interpretToolResult({})).toEqual({ isError: false, text: '', data: undefined, content: [] });
  });
});

describe('reviewer-smoke: needsApproval', () => {
  const refusal = (extra: Record<string, unknown>) => ({
    isError: true,
    content: [
      { type: 'text', text: 'fox_click targets a protected site' },
      { type: 'text', text: JSON.stringify({ code: 'SAFETY_BLOCKED', ...extra }) },
    ],
  });

  it('is true for a result with a confirmationRequired block', () => {
    expect(needsApproval(refusal({ confirmationRequired: true }))).toBe(true);
  });

  it('is false for other refusals, plain errors and successes', () => {
    expect(needsApproval(refusal({ decision: 'read_only' }))).toBe(false);
    expect(needsApproval({ isError: true, content: [{ type: 'text', text: 'Browser error: confirmationRequired' }] })).toBe(false);
    expect(needsApproval({ content: [{ type: 'text', text: '{"success":true}' }] })).toBe(false);
    expect(needsApproval({})).toBe(false);
  });
});

describe('reviewer-smoke: formFieldValues', () => {
  const pageInfo = {
    forms: [
      { fields: [{ type: 'text', value: 'Sample name' }, { type: 'password', value: '[MASKED]' }] },
      { fields: [{ type: 'hidden', value: 'abc' }, { type: 'password', value: 'leaked' }] },
    ],
  };

  it('returns the values of the fields of one type across all forms, in page order', () => {
    expect(formFieldValues(pageInfo, 'password')).toEqual(['[MASKED]', 'leaked']);
    expect(formFieldValues(pageInfo, 'hidden')).toEqual(['abc']);
  });

  it('returns nothing for an answer without forms (headless: URL and title only)', () => {
    expect(formFieldValues({ url: 'http://127.0.0.1/', title: 't' }, 'password')).toEqual([]);
    expect(formFieldValues(undefined, 'password')).toEqual([]);
  });
});

describe('reviewer-smoke: fixtureFileFor', () => {
  const files = ['index.html', 'page2.html'];

  it('maps / to index.html and a listed name to itself, ignoring query and fragment', () => {
    expect(fixtureFileFor('/', files)).toBe('index.html');
    expect(fixtureFileFor('/page2.html?x=1#top', files)).toBe('page2.html');
  });

  it('serves nothing outside the list', () => {
    expect(fixtureFileFor('/../package.json', files)).toBeNull();
    expect(fixtureFileFor('/sub/index.html', files)).toBeNull();
    expect(fixtureFileFor('/favicon.ico', files)).toBeNull();
  });
});

describe('reviewer-smoke: parseReviewerSmokeArgs', () => {
  it('accepts --headless and --help, nothing else', () => {
    expect(parseReviewerSmokeArgs([])).toEqual({ headless: false, help: false });
    expect(parseReviewerSmokeArgs(['--headless'])).toEqual({ headless: true, help: false });
    expect(parseReviewerSmokeArgs(['-h'])).toEqual({ headless: false, help: true });
    expect(parseReviewerSmokeArgs(['--auto-approve'])).toEqual({ error: 'unknown argument: --auto-approve' });
  });
});

describe('scripts/e2e/reviewer-smoke.mjs arguments (no daemon is started)', () => {
  const script = path.resolve(__dirname, '..', '..', 'scripts', 'e2e', 'reviewer-smoke.mjs');
  const run = (args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf-8', timeout: 10_000 });

  it('--help exits 0; an unknown argument such as --auto-approve exits 2', () => {
    const help = run(['--help']);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('Usage: npm run smoke:reviewer');
    const bad = run(['--auto-approve']);
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain('unknown argument: --auto-approve');
  });
});

describe('reviewer-smoke: formatTable', () => {
  it('pads each column to its longest cell and draws a rule under the heading', () => {
    const table = formatTable({ n: '#', result: 'Result' }, [{ n: 1, result: 'PASS' }, { n: 10, result: 'FAIL' }]);
    expect(table.split('\n')).toEqual([
      '#   Result',
      '--  ------',
      '1   PASS',
      '10  FAIL',
    ]);
  });
});

describe('reviewer-smoke: fixture server', () => {
  it('serves the test pages on 127.0.0.1 and nothing else', async () => {
    const server = await startFixtureServer(REVIEWER_FIXTURES);
    try {
      expect(server.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);

      const index = await fetch(server.baseUrl);
      expect(index.status).toBe(200);
      const html = await index.text();
      expect(html).toContain('type="password"');
      expect(html).toContain('type="hidden"');
      expect(html).toContain('href="page2.html"');

      expect((await fetch(new URL('page2.html', server.baseUrl))).status).toBe(200);
      expect((await fetch(new URL('missing.html', server.baseUrl))).status).toBe(404);
      expect((await fetch(server.baseUrl, { method: 'POST' })).status).toBe(404);
    } finally {
      await server.close();
    }
  });
});
