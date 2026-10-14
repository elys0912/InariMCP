import { describe, expect, it } from 'vitest';
import {
  isLoopbackHost,
  parsePort,
  resolveDaemonHost,
  resolveHost,
  resolveHttpPort,
  resolveWsPort,
} from '@inari-mcp/shared/node';

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

describe('isLoopbackHost (the address of the daemon link)', () => {
  it.each([
    '127.0.0.1', '127.1.2.3', '127.255.255.255', 'localhost', 'LOCALHOST', ' localhost ',
    '::1', '[::1]', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1', '[::FFFF:127.0.0.1]', '::ffff:7f00:1', '::ffff:7f01:203',
  ])('%s is loopback', (host) => {
    expect(isLoopbackHost(host)).toBe(true);
  });

  it.each([
    ['an octet above 255 (a name, not an address)', '127.999.0.1'],
    ['a short form the resolver would expand', '127.1'],
    ['leading zeros', '127.000.000.001'],
    ['every interface', '0.0.0.0'],
    ['every IPv6 interface', '::'],
    ['another network', '192.168.1.10'],
    ['an address just outside 127.0.0.0/8', '128.0.0.1'],
    ['0.127.0.1 mapped into IPv6', '::ffff:7f:1'],
    ['128.0.0.1 mapped into IPv6', '::ffff:128.0.0.1'],
    ['another IPv6 address', '[::2]'],
    ['an IPv6 address with a zone', 'fe80::1%eth0'],
    ['a name', 'example.test'],
    ['a name that starts with a loopback address', '127.0.0.1.example.test'],
    ['localhost with a trailing dot', 'localhost.'],
    ['empty', ''],
  ])('%s (%s) is not', (_what, host) => {
    expect(isLoopbackHost(host)).toBe(false);
  });
});

describe('resolveDaemonHost (the daemon, the Native Host and the relays)', () => {
  it('returns FOX_HOST (or the default) when it is a loopback address', () => {
    expect(resolveDaemonHost({})).toBe('127.0.0.1');
    expect(resolveDaemonHost({ FOX_HOST: ' localhost ' })).toBe('localhost');
    expect(resolveDaemonHost({ FOX_HOST: '', CLAUDE_BROWSER_HOST: '127.0.0.2' })).toBe('127.0.0.2');
  });

  it.each(['0.0.0.0', '127.999.0.1', '192.168.1.10'])('throws for FOX_HOST=%s, naming the variable and what to set', (host) => {
    expect(() => resolveDaemonHost({ FOX_HOST: host })).toThrow(
      `FOX_HOST=${host} is not a loopback address (127.0.0.0/8, ::1, localhost)`,
    );
    expect(() => resolveDaemonHost({ FOX_HOST: host })).toThrow(/unset FOX_HOST or set it to 127\.0\.0\.1/);
  });
});
