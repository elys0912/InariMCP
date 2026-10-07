/**
 * scripts/e2e/tools-smoke.mjs helpers (smoke-core.mjs); no daemon is started.
 */

import { describe, expect, it } from 'vitest';
import { interpretCallResponse, truncate } from '../../scripts/e2e/smoke-core.mjs';

// ---------------------------------------------------------------------------
// scripts/e2e/tools-smoke.mjs helpers
// ---------------------------------------------------------------------------

describe('tools-smoke: interpretCallResponse', () => {
  const answer = (status: number, body: unknown) =>
    ({ status, body: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)) });

  it('treats an error status with { error } only (no success field) as an error', () => {
    // the daemon's auth failure: 403 { error } (http-bridge.ts reply.error)
    const r = interpretCallResponse(answer(403, { error: 'Unauthorized' }));
    expect(r.isError).toBe(true);
    expect(r.text).toBe('HTTP 403: Unauthorized');
    expect(r.data).toBeUndefined();
    expect(interpretCallResponse(answer(500, { error: 'boom' })).isError).toBe(true);
  });

  it('passes a successful call through, with its text parsed as JSON', () => {
    const r = interpretCallResponse(answer(200, {
      success: true,
      result: { content: [{ type: 'text', text: '{"success":true,"tabs":[]}' }] },
    }));
    expect(r.isError).toBe(false);
    expect(r.data).toEqual({ success: true, tabs: [] });
    // a tool error inside a 200 answer stays an error
    expect(interpretCallResponse(answer(200, { success: true, result: { isError: true, content: [] } })).isError).toBe(true);
    expect(interpretCallResponse(answer(400, { success: false, error: 'bad args' })).isError).toBe(true);
  });

  it('reports a body that is not JSON, or no answer, as an error instead of throwing', () => {
    const r = interpretCallResponse(answer(200, '<html>proxy error</html>'));
    expect(r.isError).toBe(true);
    expect(r.text).toContain('not JSON');
    expect(interpretCallResponse(answer(502, '')).isError).toBe(true);
    expect(interpretCallResponse(null).isError).toBe(true);
  });

  it('truncate counts code points (does not split a surrogate pair)', () => {
    expect(truncate('a\u{1F98A}b', 2)).toBe('a\u{1F98A}');
    expect(truncate('  x \n y  ', 120)).toBe(' x y ');
    expect(truncate(undefined)).toBe('');
  });
});
