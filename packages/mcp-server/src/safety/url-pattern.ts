/**
 * URL patterns of safety.json (blocked / allowed / protected_url_patterns).
 *
 * A pattern is matched against the parsed URL, never against the raw string,
 * so `example.com.attacker.net`, `https://example.com@attacker.net/` or a
 * query string that mentions a host cannot satisfy it.
 *
 * Forms:
 *   host           `example.com`         the host and every subdomain
 *   subdomains     `*.example.com`       subdomains only
 *   host + path    `example.com/admin`   ... whose path starts with /admin
 *                                        (`example.com/*` = any path)
 *   scheme         `https://example.com` ... over that scheme only
 *   regex          `re:<regex>`          tested (case-insensitive) against the
 *                                        normalised URL: scheme://host[:port]
 *                                        /path?query#hash, lower-case host, no
 *                                        userinfo. Anchor it yourself.
 *
 * Earlier releases treated every pattern as an unanchored regex over the raw
 * URL. Such legacy patterns keep working where possible:
 *   - simple ones are read as the equivalent host pattern: `paypal\.com`
 *     (host and subdomains), `\.gov(/|$)` (subdomains only),
 *     `^https://a\.example/` (that host only, as the anchor meant);
 *   - any other legacy regex keeps its old meaning in blocked/protected lists
 *     (over-matching errs on the safe side there), with a warning;
 *   - in the allowed list it is an error: an unanchored allowlist regex is
 *     exactly the bypass this module exists to close.
 *
 * Host and scheme compare case-insensitively (the URL parser lower-cases
 * them, IDN hosts become punycode). Each list errs towards refusing:
 *   - allowed: the path matches as written (case-sensitive, at a segment
 *     boundary: /admin does not cover /administrator);
 *   - blocked / protected: the path matches any continuation after
 *     percent-escapes are decoded, repeated slashes collapsed and case
 *     folded (/admin covers /ADMIN, //admin, /%61dmin, /admin;x, /administrator).
 */

import type { WireUrlRule } from '@kitsune-mcp/shared';

export type PatternListName = 'blocked' | 'allowed' | 'protected';

export interface UrlPattern {
  /** The pattern as written in safety.json. */
  readonly source: string;
  readonly kind: 'host' | 'regex' | 'legacy';
  test(url: string): boolean;
  /**
   * The same pattern as a URL rule for the Extension (BrowserCommand
   * `protectedUrlRules` / `blockedUrlRules` / `allowedUrlRules`), which
   * matches it like test() (extension/src/url-rule.ts, contract test
   * tests/contract/url-rule.test.ts).
   */
  readonly wire: WireUrlRule;
  /**
   * Legacy: equivalent regex source for Extension builds that only know
   * `protectedUrlPatterns` and test `new RegExp(source, 'i')` against the
   * raw tab URL (percent-escapes not decoded).
   */
  readonly wireSource: string;
}

export interface PatternIssue {
  pattern: string;
  message: string;
  /** true: the pattern cannot be used and the policy must fail closed. */
  fatal: boolean;
}

export interface CompiledPatterns {
  patterns: UrlPattern[];
  issues: PatternIssue[];
}

// ---------------------------------------------------------------------------
// URL normalisation
// ---------------------------------------------------------------------------

export interface NormalizedUrl {
  url: URL;
  /** Lower-case, no trailing dot. '' for URLs without a host (about:blank). */
  hostname: string;
  /** scheme://host[:port]/path?query#hash without userinfo. */
  normalized: string;
  hasUserinfo: boolean;
}

export function normalizeUrl(raw: string): NormalizedUrl | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const hostname = url.hostname.replace(/\.$/, '');
  const hasUserinfo = url.username !== '' || url.password !== '';
  const normalized = url.host
    ? `${url.protocol}//${hostname}${url.port ? `:${url.port}` : ''}${url.pathname}${url.search}${url.hash}`
    : url.href;
  return { url, hostname, normalized, hasUserinfo };
}

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

const HOST_FORM_RE =
  /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*\.)?([^\s/?#:@*\\^$()[\]{}|+]+)(\/[^\s]*)?$/i;

const REGEX_META_RE = /[\\^$()[\]{}|+?*]/;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/** `example.com` → 'example.com' (punycode, lower-case) or null if not a host. */
function canonicalHost(host: string): string | null {
  if (host.startsWith('.') || host.endsWith('.') || host.includes('..')) return null;
  try {
    const parsed = new URL(`http://${host}/`);
    // Anything the parser moved out of the host (port, path) means not a host.
    if (parsed.port || parsed.pathname !== '/') return null;
    return parsed.hostname;
  } catch {
    return null;
  }
}

interface HostSpec {
  scheme: string | null;
  /** 'tree': the host and its subdomains; 'sub': subdomains only; 'exact': the host only. */
  hosts: 'tree' | 'sub' | 'exact';
  host: string;
  /** Path prefix, or null for any path. */
  path: string | null;
}

/** Why a host-form pattern is unusable, or a spec. */
type ParseResult = HostSpec | { error: string } | null;

function parseHostForm(s: string): ParseResult {
  const m = HOST_FORM_RE.exec(s);
  if (!m) return null;
  const host = canonicalHost(m[3]!);
  if (host === null) return null;
  let path: string | null = m[4] ?? null;
  // A trailing `/*` is the usual way to write "any path below".
  if (path !== null && path.endsWith('/*')) path = path.slice(0, -1);
  if (path !== null && path.includes('*')) {
    return { error: "'*' in a path is only supported as a trailing '/*'" };
  }
  if (path === '/') path = null;
  return {
    scheme: m[1] ? m[1].toLowerCase() : null,
    hosts: m[2] !== undefined ? 'sub' : 'tree',
    host,
    path,
  };
}

/**
 * Read a legacy regex as a host pattern when that keeps its intent:
 * `\.` → `.`, `\/` → `/`, a trailing `(/|$)`, a leading `^https?://`
 * (then the host is exact, as the anchor meant) and a leading `\.` (then
 * subdomains only, as the old "any host ending in .x") are understood.
 */
function convertLegacy(s: string): HostSpec | null {
  let t = s;
  let scheme: string | null = null;
  const anchored = /^\^(https?)(\?)?:\\?\/\\?\//i.exec(t);
  if (anchored) {
    scheme = anchored[2] ? null : anchored[1]!.toLowerCase();
    t = t.slice(anchored[0].length);
  }
  t = t.replace(/\((?:\/\|\$|\$\|\/)\)$/, '');
  t = t.replace(/\\([./-])/g, '$1');
  let subdomainsOnly = false;
  if (!anchored && t.startsWith('.')) {
    t = t.slice(1);
    subdomainsOnly = true;
  }
  if (REGEX_META_RE.test(t)) return null;
  const spec = parseHostForm(t);
  if (spec === null || 'error' in spec) return null;
  return {
    ...spec,
    scheme: spec.scheme ?? scheme,
    hosts: anchored ? 'exact' : subdomainsOnly ? 'sub' : spec.hosts,
  };
}

/**
 * Path as compared by blocked/protected entries: percent-escapes decoded,
 * repeated slashes collapsed, lower case, so `/%61dmin`, `//admin` and
 * `/ADMIN` all read as `/admin`.
 */
function loosePath(pathname: string): string {
  let p = pathname;
  try {
    p = decodeURIComponent(p);
  } catch {
    // Malformed escapes: compare as written.
  }
  return p.replace(/\/{2,}/g, '/').toLowerCase();
}

function hostPattern(source: string, spec: HostSpec, list: PatternListName): UrlPattern {
  // Each list errs towards refusing: an allowed entry matches its path
  // exactly (case-sensitive, at a segment boundary); a blocked or protected
  // entry matches any path that starts with it once normalised.
  const strictPath = list === 'allowed';
  const path = spec.path;
  const wantPath = path === null ? null : strictPath ? path : loosePath(path);
  const pathBoundary = strictPath && path !== null && !path.endsWith('/');

  const test = (raw: string): boolean => {
    const n = normalizeUrl(raw);
    if (n === null || n.hostname === '') return false;
    if (spec.scheme !== null && n.url.protocol !== `${spec.scheme}:`) return false;
    const h = n.hostname;
    const isSub = h.endsWith(`.${spec.host}`);
    const hostOk =
      spec.hosts === 'exact' ? h === spec.host
        : spec.hosts === 'sub' ? isSub
          : h === spec.host || isSub;
    if (!hostOk) return false;
    if (wantPath === null) return true;
    const actual = strictPath ? n.url.pathname : loosePath(n.url.pathname);
    if (!actual.startsWith(wantPath)) return false;
    return !pathBoundary || actual.length === wantPath.length || actual[wantPath.length] === '/';
  };

  const scheme = spec.scheme !== null ? escapeRegex(spec.scheme) : '[a-z][a-z0-9+.-]*';
  const sub =
    spec.hosts === 'exact' ? '' : spec.hosts === 'sub' ? '(?:[^/?#@]+\\.)' : '(?:[^/?#@]+\\.)?';
  let tail: string;
  if (wantPath === null) {
    tail = '(?:[/?#]|$)';
  } else {
    // Repeated slashes as in loosePath(); percent-escapes cannot be decoded
    // in a regex and are matched as written.
    const pathRe = wantPath.split('/').map(escapeRegex).join('\\/+');
    tail = pathRe + (pathBoundary ? '(?:[/?#]|$)' : '');
  }
  const wireSource =
    `^${scheme}:\\/\\/(?:[^/?#]*@)?${sub}${escapeRegex(spec.host)}\\.?(?::\\d+)?${tail}`;

  const wire: WireUrlRule = {
    kind: 'host',
    source,
    scheme: spec.scheme,
    hosts: spec.hosts,
    host: spec.host,
    path: wantPath,
    pathMatch: strictPath ? 'strict' : 'loose',
  };

  return { source, kind: 'host', test, wire, wireSource };
}

function regexPattern(
  source: string,
  regexSource: string,
  kind: 'regex' | 'legacy',
  list: PatternListName,
): UrlPattern | string {
  let re: RegExp;
  try {
    re = new RegExp(regexSource, 'i');
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  return {
    source,
    kind,
    // Allowed: the normalised URL only. Blocked / protected: either form
    // (the Extension tests the raw tab URL with wireSource).
    test: (raw: string) => {
      const n = normalizeUrl(raw);
      if (n === null) return list !== 'allowed' && re.test(raw);
      return re.test(n.normalized) || (list !== 'allowed' && re.test(raw));
    },
    wire: { kind: 'regex', source, re: regexSource, matchRaw: list !== 'allowed' },
    wireSource: regexSource,
  };
}

export function compileUrlPatterns(
  sources: readonly string[],
  list: PatternListName,
): CompiledPatterns {
  const patterns: UrlPattern[] = [];
  const issues: PatternIssue[] = [];

  for (const source of sources) {
    const s = source.trim();
    if (s === '') {
      issues.push({ pattern: source, message: 'empty pattern', fatal: true });
      continue;
    }

    if (s.startsWith('re:')) {
      const compiled = regexPattern(source, s.slice(3), 'regex', list);
      if (typeof compiled === 'string') {
        issues.push({ pattern: source, message: `invalid regex: ${compiled}`, fatal: true });
      } else {
        patterns.push(compiled);
      }
      continue;
    }

    const parsed = parseHostForm(s);
    if (parsed !== null && 'error' in parsed) {
      issues.push({ pattern: source, message: parsed.error, fatal: true });
      continue;
    }
    const spec = parsed ?? (REGEX_META_RE.test(s) ? convertLegacy(s) : null);
    if (spec !== null) {
      patterns.push(hostPattern(source, spec, list));
      if (list !== 'allowed' && !spec.host.includes('.') && spec.hosts === 'tree' && s === spec.host) {
        issues.push({
          pattern: source,
          message:
            `matches only the host '${spec.host}' and its subdomains ` +
            `(e.g. www.${spec.host}), not '${spec.host}.com' or other names containing it`,
          fatal: false,
        });
      }
      continue;
    }

    if (list === 'allowed') {
      issues.push({
        pattern: source,
        message:
          'not a host pattern (e.g. "example.com", "*.example.com", "example.com/path"); ' +
          'an allowlist entry that is a bare regex could match unintended URLs. ' +
          'Rewrite it as a host pattern, or as "re:^https://example\\.com/" with explicit anchors',
        fatal: true,
      });
      continue;
    }

    const legacy = regexPattern(source, s, 'legacy', list);
    if (typeof legacy === 'string') {
      issues.push({ pattern: source, message: `invalid pattern: ${legacy}`, fatal: true });
      continue;
    }
    patterns.push(legacy);
    issues.push({
      pattern: source,
      message:
        'legacy regex, matched anywhere in the URL; rewrite it as a host pattern ' +
        'or as "re:" with explicit anchors',
      fatal: false,
    });
  }

  return { patterns, issues };
}
