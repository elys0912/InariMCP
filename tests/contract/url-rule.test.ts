/**
 * The Extension's URL rule matcher (packages/extension/src/url-rule.ts) and
 * the MCP Server's (packages/mcp-server/src/safety/url-pattern.ts) give the
 * same answer for the same pattern and URL. The server sends each pattern
 * as a WireUrlRule (shared/src/protocol.ts); the Extension cannot import
 * url-pattern.ts (classic scripts, no bundler), so it has its own copy of
 * the rules, cut out of the source here (helpers/extension-source.ts).
 *
 * TODO(test): IDN hosts (punycode on both sides) and IPv6 / port patterns
 *   once url-pattern.ts supports them.
 * TODO(test): content.ts onProtectedPage with a fake window.location (the
 *   rules it receives from the background are the compiled wire rules).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { WireUrlRuleSchema } from '@kitsune-mcp/shared';
import { compileUrlPatterns, type PatternListName } from '../../packages/mcp-server/src/safety/url-pattern.js';
import { SafetyGuard } from '../../packages/mcp-server/src/safety/guard.js';
import { DEFAULT_CONFIG } from '../../packages/mcp-server/src/safety/config.js';
import { loadExtensionFunctions } from './helpers/extension-source.js';

type Compiled = { rule: { source: string }; regex: RegExp | null };
interface UrlRuleFns {
  parseUrlRule(raw: unknown): unknown;
  compileUrlRule(rule: unknown): Compiled | null;
  compileUrlRules(raw: unknown): { rules: Compiled[]; invalid: number };
  urlRuleMatches(rule: Compiled, url: string): boolean;
  urlListViolation(
    url: string | undefined,
    blocked: Compiled[],
    allowed: Compiled[],
    allowlistActive: boolean,
  ): { decision: string; reason: string } | null;
}

const URL_RULE_FUNCTIONS = [
  'parseUrlRule', 'compileUrlRule', 'compileUrlRules', 'normalizeRuleUrl',
  'looseRulePath', 'urlRuleMatches', 'findUrlRule', 'urlListViolation',
] as const;

let ext: UrlRuleFns;

beforeAll(async () => {
  ext = await loadExtensionFunctions<UrlRuleFns>('url-rule.ts', URL_RULE_FUNCTIONS);
});

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
  're:^https://re\\.test/(a|b)/',
  'bank|credit',
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
];

const LISTS: PatternListName[] = ['blocked', 'allowed', 'protected'];

describe('host / regex rules: Extension matcher = server matcher', () => {
  for (const list of LISTS) {
    it(`${list} list`, () => {
      // Patterns that are an error in this list (bare regex in allowed) are
      // never sent: the guard fails closed instead.
      const { patterns } = compileUrlPatterns(PATTERNS, list);
      expect(patterns.length).toBeGreaterThan(5);
      for (const p of patterns) {
        expect(WireUrlRuleSchema.safeParse(p.wire).success, p.source).toBe(true);
        // As it travels: JSON over Native Messaging.
        const compiled = ext.compileUrlRule(ext.parseUrlRule(JSON.parse(JSON.stringify(p.wire))));
        expect(compiled, p.source).not.toBeNull();
        for (const url of URLS) {
          expect(ext.urlRuleMatches(compiled!, url), `${list} ${p.source} vs ${url}`).toBe(p.test(url));
        }
      }
    });
  }

  it('decodes percent-escapes for protected paths (the legacy wireSource regex did not)', () => {
    const [p] = compileUrlPatterns(['example.test/admin'], 'protected').patterns;
    const compiled = ext.compileUrlRule(p!.wire)!;
    expect(ext.urlRuleMatches(compiled, 'https://example.test/%61dmin')).toBe(true);
    expect(new RegExp(p!.wireSource, 'i').test('https://example.test/%61dmin')).toBe(false);
  });
});

describe('blocked / allowed decision: Extension = guard', () => {
  it.each([
    ['blocked only', ['example.test', 'paypal\\.test'], []],
    ['allowed only', [], ['example.test/admin', '*.sub.test']],
    ['both', ['example.test/admin'], ['example.test']],
  ] as const)('%s', (_label, blockedSrc, allowedSrc) => {
    const g = new SafetyGuard({
      ...DEFAULT_CONFIG,
      auditLog: false,
      maxActionsPerMinute: 0,
      protectedUrlPatterns: [],
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

describe('legacy form (older MCP Servers: protectedUrlPatterns strings)', () => {
  it('a string is a regex over the raw URL, as before (flag i)', () => {
    const { rules, invalid } = ext.compileUrlRules(['bank\\.test', '(']);
    expect(invalid).toBe(1);
    expect(ext.urlRuleMatches(rules[0]!, 'https://x.test/?next=BANK.test')).toBe(true);
    expect(ext.urlRuleMatches(rules[0]!, 'https://other.test/')).toBe(false);
  });
});
