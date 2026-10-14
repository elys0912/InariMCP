/**
 * The Extension's URL rule matcher (packages/extension/src/url-rule.ts) and
 * the MCP Server's (packages/mcp-server/src/safety/url-pattern.ts) give the
 * same answer for the same pattern and URL. The server sends each pattern
 * as a WireUrlRule (shared/src/protocol.ts); the Extension has its own copy
 * of the rules (url-pattern.ts is not browser code), imported here.
 */

import { describe, expect, it } from 'vitest';
import { WireUrlRuleSchema } from '@inari-mcp/shared';
import { compileUrlPatterns, type PatternListName } from '../../packages/mcp-server/src/safety/url-pattern.js';
import { SafetyGuard } from '../../packages/mcp-server/src/safety/guard.js';
import { DEFAULT_CONFIG } from '../../packages/mcp-server/src/safety/config.js';
import * as ext from '../../packages/extension/src/url-rule.ts';

/** A wire rule as the Extension reads and compiles it (null if unusable). */
const compileWire = (wire: unknown): ext.CompiledUrlRule | null => {
  const rule = ext.parseUrlRule(wire);
  return rule === null ? null : ext.compileUrlRule(rule);
};

const PATTERNS = [
  'example.test',
  '*.sub.test',
  'example.test/admin',
  'example.test/admin/',
  'example.test/*',
  'https://secure.test',
  'http://plain.test/Path',
  'single',
  '^https://exact\\.test/',
  'paypal\\.test',
  '\\.gov\\.test(/|$)',
  're:^https://re\\.test/(a|b)/.*',
  're:example\\.test',
  'bank|credit',
  '[::1]',
  'http://[0:0::1]:3000/app',
  'example.test:8443',
  'secure.test:443',
  '例え.テスト',
  '*.例え.テスト',
  '[::ffff:192.168.0.1]',
];

const URLS = [
  'https://example.test/', 'https://a.example.test/x', 'https://EXAMPLE.test/', 'https://example.test./',
  'https://example.test.attacker.test/', 'https://notexample.test/', 'https://example.test@attacker.test/',
  'https://user:pw@example.test/admin', 'https://attacker.test/?u=example.test', 'https://attacker.test/example.test',
  'https://example.test/admin', 'https://example.test/admin/x', 'https://example.test/administrator',
  'https://example.test/ADMIN', 'https://example.test//admin', 'https://example.test/%61dmin',
  'https://example.test/%2561dmin', 'https://example.test/%E0%A4%A', 'https://example.test:8443/admin?x#y',
  'https://example.test/a/../admin', 'https://sub.test/', 'https://a.sub.test/', 'https://a.b.sub.test/',
  'https://secure.test/', 'http://secure.test/', 'http://plain.test/Path/x', 'http://plain.test/path',
  'http://plain.test/Pathology', 'https://single/', 'https://www.single/', 'https://single.com/',
  'https://exact.test/', 'https://www.exact.test/', 'http://exact.test/', 'https://Exact.Test/',
  'https://paypal.test/', 'https://www.paypal.test/login', 'https://paypal.test.evil.test/',
  'https://agency.gov.test/', 'https://gov.test/', 'https://re.test/a/', 'https://RE.test/b/x',
  'https://re.test/c/', 'https://mybank.test/', 'https://x.test/?q=credit', 'about:blank',
  'moz-extension://abc/page.html', 'file:///C:/a/example.test', 'not a url', '',
  'http://[::1]/', 'http://[::1]:3000/app/x', 'http://[::1]:3001/app', 'http://[::2]:3000/app',
  'https://example.test:443/', 'http://secure.test:443/', 'https://secure.test:8443/',
  'https://例え.テスト/', 'https://xn--r8jz45g.xn--zckzah/x', 'https://a.例え.テスト/',
  'https://xn--r8jz45g.xn--zckzah.attacker.test/',
  'http://[::ffff:192.168.0.1]/', 'http://[::ffff:c0a8:1]/a', 'http://[fe80::1%25eth0]/',
];

const LISTS: PatternListName[] = ['blocked', 'allowed', 'confirmRead'];

describe('host / regex rules: Extension matcher = server matcher', () => {
  for (const list of LISTS) {
    it(`${list} list`, () => {
      // Patterns that are an error (a bare regex) are never sent: the guard
      // fails closed instead.
      const { patterns } = compileUrlPatterns(PATTERNS, list);
      expect(patterns.length).toBeGreaterThan(5);
      for (const p of patterns) {
        expect(WireUrlRuleSchema.safeParse(p.wire).success, p.source).toBe(true);
        // As it travels: JSON over Native Messaging.
        const compiled = compileWire(JSON.parse(JSON.stringify(p.wire)));
        expect(compiled, p.source).not.toBeNull();
        for (const url of URLS) {
          expect(ext.urlRuleMatches(compiled!, url), `${list} ${p.source} vs ${url}`).toBe(p.test(url));
        }
      }
    });
  }
});

describe('blocked / allowed decision: Extension = guard', () => {
  it.each([
    ['blocked only', ['example.test', 'paypal.test'], []],
    ['allowed only', [], ['example.test/admin', '*.sub.test']],
    ['both', ['example.test/admin'], ['example.test']],
  ] as const)('%s', (_label, blockedSrc, allowedSrc) => {
    const g = new SafetyGuard({
      ...DEFAULT_CONFIG,
      auditLog: false,
      maxActionsPerMinute: 0,
      blockedUrlPatterns: [...blockedSrc],
      allowedUrlPatterns: [...allowedSrc],
    });
    const wire = (src: readonly string[], list: PatternListName) =>
      ext.compileUrlRules(compileUrlPatterns(src, list).patterns.map((p) => p.wire)).rules;
    const blocked = wire(blockedSrc, 'blocked');
    const allowed = wire(allowedSrc, 'allowed');
    for (const url of URLS) {
      const server = g.checkReachedUrl('fox_click', {}, { url }) !== null;
      const v = ext.urlListViolation(url, blocked, allowed, allowedSrc.length > 0);
      expect(v !== null, url).toBe(server);
    }
  });

  it('an allowed list whose entries were all unusable still refuses', () => {
    const { rules, invalid } = ext.compileUrlRules([{ kind: 'host', source: 'x' }]);
    expect(invalid).toBe(1);
    expect(ext.urlListViolation('https://any.test/', [], rules, true)?.decision).toBe('not_allowlisted');
  });
});

describe('hosts the URL parser rewrites, and a rule without `port`', () => {
  /** The single pattern of `source`, which must compile without a fatal issue. */
  const only = (source: string, list: PatternListName = 'confirmRead') => {
    const { patterns, issues } = compileUrlPatterns([source], list);
    expect(issues.filter((i) => i.fatal), source).toEqual([]);
    return patterns[0]!;
  };
  const compiled = (wire: unknown): ext.CompiledUrlRule => {
    const c = compileWire(wire);
    if (c === null) throw new Error(`unusable rule: ${JSON.stringify(wire)}`);
    return c;
  };

  it('an IDN host is punycode on both sides', () => {
    const p = only('例え.テスト');
    expect(p.wire).toMatchObject({ kind: 'host', host: 'xn--r8jz45g.xn--zckzah' });
    const c = compiled(p.wire);
    for (const url of ['https://例え.テスト/', 'https://xn--r8jz45g.xn--zckzah/x', 'https://a.例え.テスト/']) {
      expect(ext.urlRuleMatches(c, url), url).toBe(true);
    }
    // The punycode label is a label, not a prefix of the host.
    expect(ext.urlRuleMatches(c, 'https://xn--r8jz45g.xn--zckzah.attacker.test/')).toBe(false);
  });

  it('`*.` before an IDN host is subdomains only', () => {
    const c = compiled(only('*.例え.テスト').wire);
    expect(ext.urlRuleMatches(c, 'https://a.例え.テスト/')).toBe(true);
    expect(ext.urlRuleMatches(c, 'https://例え.テスト/')).toBe(false);
  });

  it('an IPv4-mapped IPv6 address compares in the compressed form the parser gives', () => {
    const p = only('[::ffff:192.168.0.1]');
    expect(p.wire).toMatchObject({ kind: 'host', host: '[::ffff:c0a8:1]' });
    const c = compiled(p.wire);
    expect(ext.urlRuleMatches(c, 'http://[::ffff:192.168.0.1]/')).toBe(true);
    expect(ext.urlRuleMatches(c, 'http://[::ffff:c0a8:1]/a')).toBe(true);
    expect(ext.urlRuleMatches(c, 'http://[::1]/')).toBe(false);
  });

  it('an IPv6 zone id is refused as a pattern and matches nothing as a URL', () => {
    const { patterns, issues } = compileUrlPatterns(['[fe80::1%25eth0]'], 'confirmRead');
    expect(patterns).toEqual([]);
    expect(issues.map((i) => i.fatal)).toEqual([true]);
    // The URL parser does not accept one either, so no host rule can match
    // it; a confirm-read regex rule still tests the raw URL (matchRaw), which
    // errs on the safe side.
    const zoned = 'http://[fe80::1%25eth0]/';
    for (const source of ['[::1]', 'example.test']) {
      expect(ext.urlRuleMatches(compiled(only(source).wire), zoned), source).toBe(false);
    }
    expect(ext.urlRuleMatches(compiled(only('re:.*').wire), zoned)).toBe(true);
  });

  it('a rule without `port` (an older server) is read as any port', () => {
    const wire = { ...only('example.test').wire } as Record<string, unknown>;
    expect(wire.port).toBeNull();
    delete wire.port;
    const c = compiled(wire);
    expect(c.rule).toMatchObject({ kind: 'host', port: null });
    for (const url of ['https://example.test/', 'https://example.test:8443/', 'http://example.test:81/']) {
      expect(ext.urlRuleMatches(c, url), url).toBe(true);
    }
  });

  it('a port outside 1-65535 makes the rule unusable (it is not read as "any port")', () => {
    const wire = { ...only('example.test:8443').wire, port: 0 };
    expect(ext.parseUrlRule(wire)).toBeNull();
  });
});

describe('fail-closed wire input', () => {
  const hostWire = (path: string | null, pathMatch: 'strict' | 'loose' = 'loose') =>
    ({ kind: 'host', source: 'x', scheme: null, hosts: 'tree', host: 'example.test', port: null, path, pathMatch });

  it('a list that is there but not an array is one unusable entry; undefined is no list', () => {
    expect(ext.compileUrlRules(undefined)).toEqual({ rules: [], invalid: 0 });
    for (const raw of [null, 'https://a.example', 42, {}, { 0: hostWire(null) }, true]) {
      expect(ext.compileUrlRules(raw), JSON.stringify(raw)).toEqual({ rules: [], invalid: 1 });
    }
    expect(ext.compileUrlRules([])).toEqual({ rules: [], invalid: 0 });
  });

  it('a host rule whose path holds a query or fragment is unusable', () => {
    for (const pathMatch of ['strict', 'loose'] as const) {
      for (const path of ['/a?x=1', '/a#f', '/?', '/#']) {
        expect(ext.parseUrlRule(hostWire(path, pathMatch)), `${pathMatch} ${path}`).toBeNull();
      }
      expect(ext.parseUrlRule(hostWire('/a', pathMatch)), pathMatch).not.toBeNull();
    }
    expect(ext.compileUrlRules([hostWire('/a?x=1'), hostWire('/a')]).invalid).toBe(1);
  });

  // That the server refuses `? # %3F %23` in a path is checked by
  // packages/mcp-server/tests/url-pattern.test.ts.
  it('percent-escapes of other characters still decode into a rule the Extension can use', () => {
    for (const list of LISTS) {
      const { patterns } = compileUrlPatterns([...PATTERNS, 'example.test/%61dmin'], list);
      const { invalid } = ext.compileUrlRules(patterns.map((p) => JSON.parse(JSON.stringify(p.wire))));
      expect(invalid, list).toBe(0);
    }
  });
});

describe('a plain string is no rule (the legacy string form is gone)', () => {
  it('is counted as unusable, so the command is refused as config_error', () => {
    const { rules, invalid } = ext.compileUrlRules(['bank\\.test', '(']);
    expect(rules).toEqual([]);
    expect(invalid).toBe(2);
  });
});
