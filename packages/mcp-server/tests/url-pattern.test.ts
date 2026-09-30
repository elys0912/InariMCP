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
    const r = matcher('re:^https://bank\\.test/', 'protected');
    expect(r('https://bank.test./x')).toBe(true);
    const allowed = matcher('re:^https://u@', 'allowed');
    expect(allowed('https://u@example.test/')).toBe(false);
  });

  it('test the normalised URL, case-insensitively', () => {
    const r = matcher('re:^https://mychart\\.');
    expect(r('https://MyChart.clinic.test/')).toBe(true);
    expect(r('https://user@mychart.clinic.test/')).toBe(true);
    expect(r('https://attacker.test/mychart.x')).toBe(false);
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

// TODO(test): wireSource vs test() for percent-encoded paths (/%61dmin): test() decodes, the Extension regex does not.
// TODO(test): IPv6 hosts and ports in patterns (not supported; legacy fallback / fatal paths).
