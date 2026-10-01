import { describe, expect, it } from 'vitest';
import { compileUrlPatterns, normalizeUrl, type PatternListName } from '../src/safety/url-pattern.js';
import { DEFAULT_CONFIG } from '../src/safety/config.js';

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

  it('an allowed path matches as written, at a segment boundary', () => {
    const p = matcher('example.test/admin', 'allowed');
    expect(p('https://example.test/admin')).toBe(true);
    expect(p('https://example.test/admin/users?x=1')).toBe(true);
    expect(p('https://example.test/administrator')).toBe(false);
    expect(p('https://example.test/%61dmin')).toBe(false);
    expect(p('https://example.test/')).toBe(false);
  });

  it('a blocked / protected path matches any spelling and continuation of it', () => {
    for (const list of ['blocked', 'protected'] as const) {
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
    for (const list of ['blocked', 'allowed', 'protected'] as const) {
      expect(compileUrlPatterns(['blocked.test/a*b'], list).issues[0]?.fatal).toBe(true);
    }
  });

  it('paths compare case-insensitively except in the allowlist', () => {
    expect(matcher('example.test/admin', 'blocked')('https://example.test/ADMIN')).toBe(true);
    expect(matcher('example.test/admin', 'allowed')('https://example.test/ADMIN')).toBe(false);
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
  it('in blocked / protected lists also test the raw URL (what the Extension sees)', () => {
    const r = matcher('re:^https://bank\\.test/.*', 'protected');
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
    for (const list of ['blocked', 'allowed', 'protected'] as const) {
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
    expect(p!.wireSource).toBe('^(?:https://example\\.com/)$');
  });

  it('are fatal when invalid, in every list', () => {
    for (const list of ['blocked', 'allowed', 'protected'] as const) {
      const { patterns, issues } = compileUrlPatterns(['re:(unclosed'], list);
      expect(patterns).toEqual([]);
      expect(issues[0]?.fatal).toBe(true);
    }
  });
});

describe('legacy regex patterns', () => {
  it.each([
    ['paypal\\.com', 'https://www.paypal.com/', 'https://paypal.com.attacker.test/'],
    ['\\.gov(/|$)', 'https://irs.gov/', 'https://gov.attacker.test/'],
    ['stripe\\.com/dashboard', 'https://stripe.com/dashboard/x', 'https://stripe.com/docs'],
    ['^https://a\\.example/', 'https://a.example/x', 'http://a.example/x'],
    ['^https://a\\.example/', 'https://a.example/x', 'https://sub.a.example/x'],
    ['^https?://a\\.example(/|$)', 'http://a.example', 'https://sub.a.example/'],
    ['\\.a\\.example', 'https://sub.a.example/', 'https://a.example/'],
  ])('%s is read as a host pattern (%s yes, %s no)', (source, hit, miss) => {
    const { patterns, issues } = compileUrlPatterns([source], 'allowed');
    expect(issues).toEqual([]);
    expect(patterns[0]!.kind).toBe('host');
    expect(patterns[0]!.test(hit)).toBe(true);
    expect(patterns[0]!.test(miss)).toBe(false);
  });

  it('other regexes keep their old meaning in blocked/protected, with a warning', () => {
    const { patterns, issues } = compileUrlPatterns(['mychart\\.'], 'protected');
    expect(patterns[0]!.kind).toBe('legacy');
    expect(patterns[0]!.test('https://mychart.clinic.test/')).toBe(true);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.fatal).toBe(false);
  });

  it('are fatal in the allowlist', () => {
    const { patterns, issues } = compileUrlPatterns(['(www\\.)?example\\.test'], 'allowed');
    expect(patterns).toEqual([]);
    expect(issues[0]!.fatal).toBe(true);
  });

  it('are fatal when not a valid regex', () => {
    const { issues } = compileUrlPatterns(['(unclosed'], 'blocked');
    expect(issues[0]!.fatal).toBe(true);
  });
});

describe('other issues', () => {
  it('an empty pattern is fatal', () => {
    expect(compileUrlPatterns(['  '], 'blocked').issues[0]!.fatal).toBe(true);
  });

  it('a bare single label warns that it is not a substring match', () => {
    const { patterns, issues } = compileUrlPatterns(['paypal'], 'blocked');
    expect(patterns).toHaveLength(1);
    expect(issues[0]!.fatal).toBe(false);
  });
});

describe('wireSource (sent to the Extension, compiled there with flag i)', () => {
  it('matches the same URLs as test() for host patterns', () => {
    const { patterns } = compileUrlPatterns(
      ['example.test', '*.sub.test', 'example.test/admin', '^https://exact\\.test/'],
      'protected',
    );
    const urls = [
      'https://example.test/', 'https://a.example.test/x', 'https://example.test.attacker.test/',
      'https://attacker.test/?example.test', 'https://example.test@attacker.test/',
      'https://sub.test/', 'https://a.sub.test/', 'https://example.test/admin/x',
      'https://example.test/administrator', 'https://example.test:8443/admin',
      'https://example.test//admin', 'https://EXAMPLE.test/ADMIN', 'https://exact.test/',
      'https://www.exact.test/', 'http://exact.test/',
    ];
    for (const p of patterns) {
      const re = new RegExp(p.wireSource, 'i');
      for (const url of urls) {
        expect(re.test(url), `${p.source} vs ${url}`).toBe(p.test(url));
      }
    }
  });
});

describe('DEFAULT_CONFIG protectedUrlPatterns', () => {
  it('compile without issues', () => {
    expect(compileUrlPatterns(DEFAULT_CONFIG.protectedUrlPatterns, 'protected').issues).toEqual([]);
  });
});

describe('wireSource vs test() for percent-encoded paths', () => {
  it('test() decodes the path, the legacy regex matches it as written', () => {
    const [p] = compileUrlPatterns(['example.test/admin'], 'blocked').patterns;
    const re = new RegExp(p!.wireSource, 'i');
    // Both agree on the spellings a regex can express.
    for (const path of ['/admin', '/ADMIN', '//admin', '/admin/x', '/administrator']) {
      expect(re.test(`https://example.test${path}`), path).toBe(true);
      expect(p!.test(`https://example.test${path}`), path).toBe(true);
    }
    // Percent escapes: only test() decodes them, so the Extension build that
    // still uses wireSource lets /%61dmin through. The rule sent next to it
    // (`wire`, matched like test() — tests/contract/url-rule.test.ts) does not.
    expect(p!.test('https://example.test/%61dmin')).toBe(true);
    expect(re.test('https://example.test/%61dmin')).toBe(false);
    expect(p!.wire).toMatchObject({ kind: 'host', path: '/admin', pathMatch: 'loose' });
  });

  it('an allowlist entry refuses the encoded spelling on both sides', () => {
    const [p] = compileUrlPatterns(['example.test/admin'], 'allowed').patterns;
    const re = new RegExp(p!.wireSource, 'i');
    expect(p!.test('https://example.test/%61dmin')).toBe(false);
    expect(re.test('https://example.test/%61dmin')).toBe(false);
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

  it('an unusable IPv6 address or port is fatal in every list, not a legacy regex', () => {
    for (const list of ['blocked', 'allowed', 'protected'] as const) {
      for (const p of ['[::g]', 'example.test:0', 'example.test:70000', 'example.test:abc', '*.[::1]']) {
        const { patterns, issues } = compileUrlPatterns([p], list);
        expect(patterns, `${list} ${p}`).toEqual([]);
        expect(issues[0]?.fatal, `${list} ${p}`).toBe(true);
      }
    }
  });
  it('a legacy regex after host: stays a legacy regex in blocked / protected', () => {
    const { patterns, issues } = compileUrlPatterns(['localhost:\\d+'], 'blocked');
    expect(patterns[0]?.kind).toBe('legacy');
    expect(issues[0]?.fatal).toBe(false);
  });
  it('wireSource matches the same URLs as test() for IPv6 and non-default ports', () => {
    const { patterns } = compileUrlPatterns(['[::1]', 'example.test:8443'], 'blocked');
    const urls = [
      'http://[::1]:3000/', 'https://[::1]/', 'http://[::2]/', 'https://example.com:8443/',
      'https://example.test:8443/x', 'https://example.test/x', 'https://a.example.test:8443/',
      'https://attacker.test/?u=https://example.test:8443/',
      'https://example.test:8443@attacker.test/',
    ];
    for (const p of patterns) {
      const re = new RegExp(p.wireSource, 'i');
      for (const url of urls) {
        expect(re.test(url), `${p.source} vs ${url}`).toBe(p.test(url));
      }
    }
  });

  it('a default port is optional in wireSource, so it also matches the other scheme', () => {
    const [p] = compileUrlPatterns(['example.test:443'], 'blocked').patterns;
    const re = new RegExp(p!.wireSource, 'i');
    expect(p!.test('https://example.test/')).toBe(true);
    expect(re.test('https://example.test/')).toBe(true);
    // The legacy regex cannot tell the scheme's default port apart: it
    // over-matches here, which errs on the safe side for a blocked entry.
    expect(p!.test('http://example.test/')).toBe(false);
    expect(re.test('http://example.test/')).toBe(true);
  });

  it('scheme, port and path together all have to match', () => {
    const [p] = compileUrlPatterns(['https://example.test:8443/admin'], 'blocked').patterns;
    expect(p!.wire).toMatchObject({
      kind: 'host', scheme: 'https', host: 'example.test', port: 8443, path: '/admin',
    });
    const re = new RegExp(p!.wireSource, 'i');
    const urls = [
      'https://example.test:8443/admin', 'https://example.test:8443/admin/users',
      'http://example.test:8443/admin', 'https://example.test/admin',
      'https://example.test:8443/other', 'https://a.example.test:8443/admin',
    ];
    for (const url of urls) expect(re.test(url), url).toBe(p!.test(url));
    expect(p!.test('https://example.test:8443/admin/users')).toBe(true);
    expect(p!.test('http://example.test:8443/admin')).toBe(false);
    expect(p!.test('https://example.test/admin')).toBe(false);
    expect(p!.test('https://example.test:8443/other')).toBe(false);
  });

  it('a legacy regex with a character class keeps its old meaning', () => {
    const { patterns, issues } = compileUrlPatterns(['[Bb]ank\\.test'], 'protected');
    expect(patterns[0]!.kind).toBe('legacy');
    expect(issues[0]!.fatal).toBe(false);
    expect(patterns[0]!.test('https://bank.test/')).toBe(true);
    expect(patterns[0]!.test('https://Bank.test.attacker.test/')).toBe(true); // unanchored, as before
    expect(patterns[0]!.wireSource).toBe('[Bb]ank\\.test');
    // The same source is fatal in the allowlist.
    expect(compileUrlPatterns(['[Bb]ank\\.test'], 'allowed').issues[0]!.fatal).toBe(true);
  });
});
