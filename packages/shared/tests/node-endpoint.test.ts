import { describe, expect, it } from 'vitest';
import { resolveHost, resolveHttpPort, resolveWsPort } from '@kitsune-mcp/shared/node';

describe('shared/node endpoint', () => {
  it('an empty FOX_HOST counts as unset: the default applies, not "" (every interface)', () => {
    expect(resolveHost({ FOX_HOST: '' })).toBe('127.0.0.1');
  });

  it('an empty FOX_HOST falls through to CLAUDE_BROWSER_HOST', () => {
    expect(resolveHost({ FOX_HOST: '', CLAUDE_BROWSER_HOST: '127.0.0.2' })).toBe('127.0.0.2');
    expect(resolveHost({ FOX_HOST: '127.0.0.3', CLAUDE_BROWSER_HOST: '127.0.0.2' })).toBe('127.0.0.3');
  });

  it('an empty FOX_*_PORT falls through to the legacy port variable', () => {
    expect(resolveHttpPort(undefined, { FOX_HTTP_PORT: '', CLAUDE_BROWSER_HTTP_PORT: '9001' })).toBe(9001);
    expect(resolveWsPort(undefined, { FOX_WS_PORT: '', CLAUDE_BROWSER_WS_PORT: '9002' })).toBe(9002);
  });

  it('an invalid port is reported under the name it was read from', () => {
    const reports: string[] = [];
    const port = resolveHttpPort((name) => reports.push(name), { FOX_HTTP_PORT: '', CLAUDE_BROWSER_HTTP_PORT: 'x' });
    expect(port).toBe(8765);
    expect(reports).toEqual(['CLAUDE_BROWSER_HTTP_PORT']);
  });
});
