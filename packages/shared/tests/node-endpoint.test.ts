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

  // InariMCP (AMO): the CLAUDE_BROWSER_* names of the fork are not read.
  it('the old CLAUDE_BROWSER_* names are not read', () => {
    expect(resolveHost({ FOX_HOST: '', CLAUDE_BROWSER_HOST: '127.0.0.2' })).toBe('127.0.0.1');
    expect(resolveHttpPort(undefined, { CLAUDE_BROWSER_HTTP_PORT: '9001' })).toBe(8785);
    expect(resolveWsPort(undefined, { CLAUDE_BROWSER_WS_PORT: '9002' })).toBe(8786);
  });

  it('a blank FOX_HOST counts as unset and a set one is trimmed (R3 N-1)', () => {
    expect(resolveHost({ FOX_HOST: ' ' })).toBe('127.0.0.1');
    expect(resolveHost({ FOX_HOST: '\t' })).toBe('127.0.0.1');
    expect(resolveHost({ FOX_HOST: ' 127.0.0.2 ' })).toBe('127.0.0.2');
  });

  it('a blank FOX_*_PORT counts as unset without a warning; a set one is trimmed (R3 N-1)', () => {
    const reports: string[] = [];
    const onInvalid = (name: string): void => {
      reports.push(name);
    };
    expect(resolveHttpPort(onInvalid, { FOX_HTTP_PORT: ' ' })).toBe(8785);
    expect(resolveWsPort(onInvalid, { FOX_WS_PORT: ' ' })).toBe(8786);
    expect(resolveHttpPort(onInvalid, { FOX_HTTP_PORT: ' 9001 ' })).toBe(9001);
    expect(reports).toEqual([]);
  });

  it('an invalid port is reported under its name, and the default applies', () => {
    const reports: string[] = [];
    const port = resolveHttpPort((name) => reports.push(name), { FOX_HTTP_PORT: 'x' });
    expect(port).toBe(8785);
    expect(reports).toEqual(['FOX_HTTP_PORT']);
  });
});
