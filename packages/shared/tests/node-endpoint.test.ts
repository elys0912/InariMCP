import { describe, expect, it } from 'vitest';
import { parsePort, resolveHost, resolveHttpPort, resolveWsPort } from '@inari-mcp/shared/node';

describe('parsePort (4.A3)', () => {
  it.each([
    ['8785', 8785],
    ['1', 1],
    ['65535', 65535],
    [' 8785 ', 8785],
  ])('accepts %j', (raw, port) => {
    expect(parsePort(raw, 9)).toBe(port);
  });

  it.each(['0', '-1', '65536', '80.5', 'abc', '1e3x'])('falls back on %j', (raw) => {
    expect(parsePort(raw, 9)).toBe(9);
  });

  it.each([undefined, '', ' ', '\t'])('falls back when unset or blank (%j)', (raw) => {
    expect(parsePort(raw, 9)).toBe(9);
  });
});

describe('shared/node endpoint', () => {
  it('an empty FOX_HOST counts as unset: the default applies, not "" (every interface)', () => {
    expect(resolveHost({ FOX_HOST: '' })).toBe('127.0.0.1');
  });

  it('an empty FOX_HOST falls through to CLAUDE_BROWSER_HOST', () => {
    expect(resolveHost({ FOX_HOST: '', CLAUDE_BROWSER_HOST: '127.0.0.2' })).toBe('127.0.0.2');
    expect(resolveHost({ FOX_HOST: '127.0.0.3', CLAUDE_BROWSER_HOST: '127.0.0.2' })).toBe('127.0.0.3');
  });

  it('a blank FOX_HOST counts as unset and a set one is trimmed (R3 N-1)', () => {
    expect(resolveHost({ FOX_HOST: ' ' })).toBe('127.0.0.1');
    expect(resolveHost({ FOX_HOST: '\t', CLAUDE_BROWSER_HOST: ' 127.0.0.2 ' })).toBe('127.0.0.2');
    expect(resolveHost({ FOX_HOST: ' 127.0.0.1 ' })).toBe('127.0.0.1');
  });

  it('an empty FOX_*_PORT falls through to the legacy port variable', () => {
    expect(resolveHttpPort(undefined, { FOX_HTTP_PORT: '', CLAUDE_BROWSER_HTTP_PORT: '9001' })).toBe(9001);
    expect(resolveWsPort(undefined, { FOX_WS_PORT: '', CLAUDE_BROWSER_WS_PORT: '9002' })).toBe(9002);
  });

  it('a blank FOX_*_PORT counts as unset without a warning; a set one is trimmed (R3 N-1)', () => {
    const reports: string[] = [];
    const onInvalid = (name: string): void => {
      reports.push(name);
    };
    expect(resolveHttpPort(onInvalid, { FOX_HTTP_PORT: ' ', CLAUDE_BROWSER_HTTP_PORT: '9001' })).toBe(9001);
    expect(resolveWsPort(onInvalid, { FOX_WS_PORT: ' ' })).toBe(8786);
    expect(resolveHttpPort(onInvalid, { FOX_HTTP_PORT: ' 8785 ' })).toBe(8785);
    expect(reports).toEqual([]);
  });

  it('an invalid port is reported under the name it was read from', () => {
    const reports: string[] = [];
    const port = resolveHttpPort((name) => reports.push(name), { FOX_HTTP_PORT: '', CLAUDE_BROWSER_HTTP_PORT: 'x' });
    expect(port).toBe(8785);
    expect(reports).toEqual(['CLAUDE_BROWSER_HTTP_PORT']);
  });
});
