/**
 * Extension content/mask.ts: credentials in logged network headers are
 * replaced before the log leaves the page.
 */

import { describe, expect, it } from 'vitest';
import { maskHeaders } from '../../packages/extension/src/content/mask.ts';

describe('content/mask.ts maskHeaders', () => {
  it('masks every credential header and keeps the others as they are', () => {
    const headers = {
      Authorization: 'Bearer secret-token',
      Cookie: 'sid=secret',
      'Set-Cookie': 'sid=secret; HttpOnly',
      'Proxy-Authorization': 'Basic c2VjcmV0',
      'X-Api-Key': 'secret-key',
      'Content-Type': 'application/json',
      Accept: '*/*',
    };
    const masked = maskHeaders(headers);
    expect(masked).toEqual({
      Authorization: '[MASKED]',
      Cookie: '[MASKED]',
      'Set-Cookie': '[MASKED]',
      'Proxy-Authorization': '[MASKED]',
      'X-Api-Key': '[MASKED]',
      'Content-Type': 'application/json',
      Accept: '*/*',
    });
    expect(JSON.stringify(masked)).not.toContain('secret');
  });

  it('matches header names in any case and keeps the original name', () => {
    expect(maskHeaders({ AUTHORIZATION: 'x', cookie: 'y', 'x-API-key': 'z' }))
      .toEqual({ AUTHORIZATION: '[MASKED]', cookie: '[MASKED]', 'x-API-key': '[MASKED]' });
  });

  it('does not mask by substring and returns a new object', () => {
    const headers = { 'X-Authorization-Hint': 'keep', 'Cookie-Policy': 'keep', authorization: 'drop' };
    const masked = maskHeaders(headers);
    expect(masked).toEqual({ 'X-Authorization-Hint': 'keep', 'Cookie-Policy': 'keep', authorization: '[MASKED]' });
    expect(headers.authorization).toBe('drop'); // the input is not modified
    expect(maskHeaders({})).toEqual({});
  });
});
