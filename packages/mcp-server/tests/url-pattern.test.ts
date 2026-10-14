import { describe, expect, it } from 'vitest';
import { compileUrlPatterns, normalizeUrl, type PatternListName } from '../src/safety/url-pattern.js';

function matcher(source: string, list: PatternListName = 'blocked') {
  const { patterns, issues } = compileUrlPatterns([source], list);
  expect(issues.filter((i) => i.fatal), source).toEqual([]);
  expect(patterns).toHaveLength(1);
  return (url: string) => patterns[0]!.test(url);
}

describe('normalizeUrl', () => {
  it('lower-cases the host, drops userinfo and the trailing dot', () => {
    const n = normalizeUrl('HTTPS://user:pw@WWW.Example.TEST.:8443/A?b#c')!;
    expect(n.hostname).toBe('www.example.test');
    expect(n.normalized).toBe('https://www.example.test:8443/A?b#c');
    expect(n.hasUserinfo).toBe(true);
  });

  it('returns null for a relative or malformed URL', () => {
    expect(normalizeUrl('example.test/path')).toBeNull();
    expect(normalizeUrl('http://')).toBeNull();
  });
});

describe('host patterns', () => {
  const m = matcher('example.test');

  it('match the host and its subdomains', () => {
    expect(m('https://example.test/')).toBe(true);
    expect(m('http://a.b.example.test/x')).toBe(true);
    expect(m('https://EXAMPLE.test/')).toBe(true);
    expect(m('https://example.test.:443/')).toBe(true);
  });

  it('do not match look-alike hosts, userinfo or other URL parts', () => {
    expect(m('https://example.test.attacker.test/')).toBe(false);
    expect(m('https://notexample.test/')).toBe(false);
    expect(m('https://example.test@attacker.test/')).toBe(false);
    expect(m('https://attacker.test/?u=https://example.test/')).toBe(false);
    expect(m('https://attacker.test/example.test')).toBe(false);
    expect(m('about:blank')).toBe(false);
    expect(m('not a url')).toBe(false);
  });

  it('*. matches subdomains only', () => {
    const sub = matcher('*.example.test');
    expect(sub('https://a.example.test/')).toBe(true);
    expect(sub('https://example.test/')).toBe(false);
  });

  it('an allowed path matches as written (case-sensitive, no decoding), at a segment boundary', () => {
    const p = matcher('example.test/admin', 'allowed');
    expect(p('https://example.test/admin')).toBe(true);
    expect(p('https://example.test/ADMIN')).toBe(false);
    expect(p('https://example.test/admin/users?x=1')).toBe(true);
    expect(p('https://example.test/administrator')).toBe(false);
    expect(p('https://example.test/%61dmin')).toBe(false);
    expect(p('https://example.test/')).toBe(false);
  });

  it('a blocked / confirm-read path matches any spelling and continuation of it', () => {
    for (const list of ['blocked', 'confirmRead'] as const) {
      const p = matcher('example.test/admin', list);
      for (const path of ['/admin', '/ADMIN', '//admin', '/%61dmin', '/admin;x', '/administrator', '/admin/x']) {
        expect(p(`https://example.test${path}`), `${list} ${path}`).toBe(true);
      }
      expect(p('https://example.test/docs/admin')).toBe(false);
    }
  });

  it('a trailing /* means any path; * elsewhere in a path is fatal', () => {
    const any = matcher('blocked.test/*');
    expect(any('https://blocked.test/login')).toBe(true);
    expect(any('https://blocked.test')).toBe(true);
    const below = matcher('blocked.test/app/*');
    expect(below('https://blocked.test/app/x')).toBe(true);
    expect(below('https://blocked.test/other')).toBe(false);
    for (const list of ['blocked', 'allowed', 'confirmRead'] as const) {
      expect(compileUrlPatterns(['blocked.test/a*b'], list).issues[0]?.fatal).toBe(true);
    }
  });

  it('a scheme restricts the match', () => {
    const s = matcher('https://example.test');
    expect(s('https://example.test/')).toBe(true);
    expect(s('http://example.test/')).toBe(false);
  });

  it('IDN hosts compare in punycode', () => {
    const idn = matcher('bücher.example');
    expect(idn('https://xn--bcher-kva.example/')).toBe(true);
    expect(idn('https://BÜCHER.example/')).toBe(true);
  });
});

describe('re: patterns', () => {
  it('in the blocked and confirm-read lists also test the raw URL (what the Extension sees)', () => {
    const r = matcher('re:^https://bank\\.test/.*', 'confirmRead');
    expect(r('https://bank.test./x')).toBe(true);
    const allowed = matcher('re:^https://u@.*', 'allowed');
    expect(allowed('https://u@example.test/')).toBe(false);
  });

  it('test the normalised URL, case-insensitively', () => {
    const r = matcher('re:^https://mychart\\..*');
    expect(r('https://MyChart.clinic.test/')).toBe(true);
    expect(r('https://user@mychart.clinic.test/')).toBe(true);
    expect(r('https://attacker.test/mychart.x')).toBe(false);
  });

  it('must match the whole URL, in every list (M3)', () => {
    for (const list of ['blocked', 'allowed', 'confirmRead'] as const) {
      const host = matcher('re:example\\.com', list);
      expect(host('https://example.com.attacker.net/'), list).toBe(false);
      expect(host('https://attacker.net/?example.com'), list).toBe(false);
      const prefix = matcher('re:https://example\\.com/.*', list);
      expect(prefix('https://example.com/a?b'), list).toBe(true);
      expect(prefix('https://example.com.attacker.net/'), list).toBe(false);
      // Anchors written by the user are not doubled; an escaped `$` stays literal.
      const anchored = matcher('re:^https://example\\.com/$', list);
      expect(anchored('https://example.com/'), list).toBe(true);
      expect(anchored('https://example.com/x'), list).toBe(false);
      expect(matcher('re:https://example\\.com/a\\$', list)('https://example.com/a$'), list).toBe(true);
    }
    const [p] = compileUrlPatterns(['re:^https://example\\.com/$'], 'allowed').patterns;
    expect(p!.wire).toMatchObject({ kind: 'regex', re: '^(?:https://example\\.com/)$' });
  });

  it('are fatal when invalid, in every list', () => {
    for (const list of ['blocked', 'allowed', 'confirmRead'] as const) {
      const { patterns, issues } = compileUrlPatterns(['re:(unclosed'], list);
      expect(patterns).toEqual([]);
      expect(issues[0]?.fatal).toBe(true);
    }
  });
});

describe('a bare regex is no pattern', () => {
  it.each([
    'paypal\\.com', '\\.gov(/|$)', '^https://a\\.example/', 'mychart\\.', '(www\\.)?example\\.test',
    '[Bb]ank\\.test', 'localhost:\\d+', 'example\\.test/a\\?x=1', '(unclosed',
  ])('%s is fatal in every list', (source) => {
    for (const list of ['blocked', 'allowed', 'confirmRead'] as const) {
      const { patterns, issues } = compileUrlPatterns([source], list);
      expect(patterns, `${list} ${source}`).toEqual([]);
      expect(issues.map((i) => i.fatal), `${list} ${source}`).toEqual([true]);
    }
  });

  it('says how to write it instead', () => {
    expect(compileUrlPatterns(['paypal\\.com'], 'blocked').issues[0]!.message)
      .toMatch(/^not a host pattern .*Rewrite it as a host pattern, or as "re:/);
  });
});

describe('other issues', () => {
  it('an empty pattern is fatal', () => {
    expect(compileUrlPatterns(['  '], 'blocked').issues[0]!.fatal).toBe(true);
  });

  it('a query or fragment in a host pattern path is fatal in every list', () => {
    const sources = [
      'example.test/a?x=1', 'example.test/a#f', 'example.test/?x=1', 'example.test/#top',
      'https://example.test/login?next=1', 'example.test:8443/a?x', 'example.test/a%3Fx', 'example.test/a%23f',
      '[::1]/a?x',
    ];
    for (const list of ['blocked', 'allowed', 'confirmRead'] as const) {
      for (const source of sources) {
        const { patterns, issues } = compileUrlPatterns([source], list);
        expect(patterns, `${list} ${source}`).toEqual([]);
        expect(issues.map((i) => i.fatal), `${list} ${source}`).toEqual([true]);
        expect(issues[0]!.message).toMatch(/cannot appear in a path/);
      }
    }
  });

  it('a bare single label warns that it is not a substring match', () => {
    const { patterns, issues } = compileUrlPatterns(['paypal'], 'blocked');
    expect(patterns).toHaveLength(1);
    expect(issues[0]!.fatal).toBe(false);
  });

  // The warning was given only when the entry was written exactly
  // as the (lower-cased) host, so these spellings went without it.
  it.each(['LOCALHOST', 'intranet/', 'intranet:8080', 'http://intranet', 'intranet/admin'])(
    'a single label written as %j warns as well',
    (source) => {
      for (const list of ['blocked', 'confirmRead'] as const) {
        const { patterns, issues } = compileUrlPatterns([source], list);
        expect(patterns, `${list} ${source}`).toHaveLength(1);
        expect(issues.map((i) => [i.fatal, /not '.+\.com' or other names containing it/.test(i.message)]), `${list} ${source}`)
          .toEqual([[false, true]]);
      }
    },
  );

  it.each([
    ['allowed', 'intranet'],
    ['blocked', 'intra.net'],
    ['blocked', '*.intranet'],
    ['blocked', '[::1]'],
  ] as const)('no single-label warning for %s %j', (list, source) => {
    expect(compileUrlPatterns([source], list).issues).toEqual([]);
  });
});

describe('the wire rule of a path (matched like test() by the Extension, tests/contract/url-rule.test.ts)', () => {
  it('is loose in the blocked and confirm-read lists, strict in the allowlist', () => {
    for (const list of ['blocked', 'confirmRead'] as const) {
      const [p] = compileUrlPatterns(['example.test/admin'], list).patterns;
      expect(p!.wire, list).toMatchObject({ kind: 'host', path: '/admin', pathMatch: 'loose' });
    }
    const [a] = compileUrlPatterns(['example.test/admin'], 'allowed').patterns;
    expect(a!.wire).toMatchObject({ kind: 'host', path: '/admin', pathMatch: 'strict' });
  });
});

describe('IPv6 and port patterns (L6)', () => {
  it('[::1] and host:port match by address and effective port, not as a regex', () => {
    const { patterns, issues } = compileUrlPatterns(['[::1]', 'example.test:8443', 'example.test:443'], 'blocked');
    expect(issues).toEqual([]);
    const [v6, alt, std] = patterns;
    expect(v6!.test('http://[::1]:3000/')).toBe(true);
    expect(v6!.test('https://example.com:8443/')).toBe(false); // the old regex reading matched any ':'
    expect(alt!.test('https://example.test:8443/x')).toBe(true);
    expect(alt!.test('https://example.test/x')).toBe(false);
    expect(std!.test('https://example.test/')).toBe(true); // default port
    expect(std!.test('http://example.test/')).toBe(false);
  });

  it('an unusable IPv6 address or port is fatal in every list', () => {
    for (const list of ['blocked', 'allowed', 'confirmRead'] as const) {
      for (const p of ['[::g]', 'example.test:0', 'example.test:70000', 'example.test:abc', '*.[::1]']) {
        const { patterns, issues } = compileUrlPatterns([p], list);
        expect(patterns, `${list} ${p}`).toEqual([]);
        expect(issues[0]?.fatal, `${list} ${p}`).toBe(true);
      }
    }
  });
  it('scheme, port and path together all have to match', () => {
    const [p] = compileUrlPatterns(['https://example.test:8443/admin'], 'blocked').patterns;
    expect(p!.wire).toMatchObject({
      kind: 'host', scheme: 'https', host: 'example.test', port: 8443, path: '/admin',
    });
    expect(p!.test('https://example.test:8443/admin/users')).toBe(true);
    expect(p!.test('http://example.test:8443/admin')).toBe(false);
    expect(p!.test('https://example.test/admin')).toBe(false);
    expect(p!.test('https://example.test:8443/other')).toBe(false);
  });
});
