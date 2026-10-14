/**
 * approval-site.ts: the one rule of the site a human approval is bound to,
 * used by the MCP Server (safety/approval.ts) and the Extension (approval.ts
 * isApprovedSite). The Extension's check is tested in
 * tests/contract/approval-flow.test.ts and extension-background-async.test.ts.
 */

import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { approvalSiteOf, bareHost } from '@inari-mcp/shared/approval-site';
import * as root from '@inari-mcp/shared';

describe('approvalSiteOf', () => {
  it('is the lower-case hostname without a trailing dot, the scheme of a URL without one, null for non-URLs', () => {
    expect(approvalSiteOf('https://Pay.Example.TEST:8443/x?y')).toBe('pay.example.test');
    expect(approvalSiteOf('https://pay.example.test./x')).toBe('pay.example.test');
    expect(approvalSiteOf('about:blank')).toBe('about:');
    expect(approvalSiteOf('file:///tmp/page.html')).toBe('file:');
    expect(approvalSiteOf('(target tab)')).toBeNull();
    expect(approvalSiteOf('')).toBeNull();
    expect(approvalSiteOf(null)).toBeNull();
    expect(approvalSiteOf(undefined)).toBeNull();
  });
});

describe('bareHost', () => {
  it('lower-cases and drops one trailing dot', () => {
    expect(bareHost('Bank.Example.TEST.')).toBe('bank.example.test');
    expect(bareHost('bank.example.test')).toBe('bank.example.test');
    expect(bareHost('.')).toBe('');
  });
});

describe('the module', () => {
  it('imports nothing (the Extension bundles it) and is exported by the package root too', () => {
    const text = fs.readFileSync(fileURLToPath(new URL('../src/approval-site.ts', import.meta.url)), 'utf-8');
    expect(text).not.toMatch(/^import /m);
    expect(root.approvalSiteOf).toBe(approvalSiteOf);
    expect(root.bareHost).toBe(bareHost);
  });
});
