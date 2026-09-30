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
 *                                        (at a segment boundary)
 *   scheme         `https://example.com` ... over that scheme only
 *   regex          `re:<regex>`          tested (case-insensitive) against the
 *                                        normalised URL: scheme://host[:port]
 *                                        /path?query#hash, lower-case host, no
 *                                        userinfo. Anchor it yourself.
 *
 * Earlier releases treated every pattern as an unanchored regex over the raw
 * URL. Such legacy patterns keep working where possible:
 *   - simple ones (`paypal\.com`, `\.gov(/|$)`, `^https://a\.example/`) are
 *     read as the equivalent host pattern;
 *   - any other legacy regex keeps its old meaning in blocked/protected lists
 *     (over-matching errs on the safe side there), with a warning;
 *   - in the allowed list it is an error: an unanchored allowlist regex is
 *     exactly the bypass this module exists to close.
 *
 * Host and scheme compare case-insensitively (the URL parser lower-cases
 * them, IDN hosts become punycode). Paths compare case-insensitively in the
 * blocked and protected lists and case-sensitively in the allowed list, so
 * each list errs towards refusing.
 */

export type PatternListName = 'blocked' | 'allowed' | 'protected';

export interface UrlPattern {
  /** The pattern as written in safety.json. */
  readonly source: string;
  readonly kind: 'host' | 'regex' | 'legacy';
  test(url: string): boolean;
  /**
   * Equivalent regex source for the Extension, which tests
   * `new RegExp(source, 'i')` against the raw tab URL.
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
  subdomainsOnly: boolean;
  host: string;
  path: string | null;
}

function parseHostForm(s: string): HostSpec | null {
  const m = HOST_FORM_RE.exec(s);
  if (!m) return null;
  const host = canonicalHost(m[3]!);
  if (host === null) return null;
  return {
    scheme: m[1] ? m[1].toLowerCase() : null,
    subdomainsOnly: m[2] !== undefined,
    host,
    path: m[4] ?? null,
  };
}

/**
 * Read a legacy regex as a host pattern when that keeps its intent:
 * `\.` → `.`, `\/` → `/`, a trailing `(/|$)`, a leading `^https?://` and a
 * leading `\.` (the old "any host ending in") are understood.
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
  if (!anchored && t.startsWith('.')) t = t.slice(1);
  if (REGEX_META_RE.test(t)) return null;
  const spec = parseHostForm(t);
  if (spec === null) return null;
  return { ...spec, scheme: spec.scheme ?? scheme };
}

function hostPattern(source: string, spec: HostSpec, list: PatternListName): UrlPattern {
  const caseSensitivePath = list === 'allowed';
  const path = spec.path;
  const pathBoundary = path !== null && !path.endsWith('/');

  const test = (raw: string): boolean => {
    const n = normalizeUrl(raw);
    if (n === null || n.hostname === '') return false;
    if (spec.scheme !== null && n.url.protocol !== `${spec.scheme}:`) return false;
    const h = n.hostname;
    const hostOk = spec.subdomainsOnly
      ? h.endsWith(`.${spec.host}`)
      : h === spec.host || h.endsWith(`.${spec.host}`);
    if (!hostOk) return false;
    if (path === null) return true;
    const actual = caseSensitivePath ? n.url.pathname : n.url.pathname.toLowerCase();
    const want = caseSensitivePath ? path : path.toLowerCase();
    if (!actual.startsWith(want)) return false;
    return !pathBoundary || actual.length === want.length || actual[want.length] === '/';
  };

  const scheme = spec.scheme !== null ? escapeRegex(spec.scheme) : '[a-z][a-z0-9+.-]*';
  const sub = spec.subdomainsOnly ? '(?:[^/?#@]+\\.)' : '(?:[^/?#@]+\\.)?';
  const tail = path === null
    ? '(?:[/?#]|$)'
    : escapeRegex(path) + (pathBoundary ? '(?:[/?#]|$)' : '');
  const wireSource =
    `^${scheme}:\\/\\/(?:[^/?#]*@)?${sub}${escapeRegex(spec.host)}\\.?(?::\\d+)?${tail}`;

  return { source, kind: 'host', test, wireSource };
}

function regexPattern(
  source: string,
  regexSource: string,
  kind: 'regex' | 'legacy',
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
    test: (raw: string) => {
      const n = normalizeUrl(raw);
      return re.test(n ? n.normalized : raw);
    },
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
      const compiled = regexPattern(source, s.slice(3), 'regex');
      if (typeof compiled === 'string') {
        issues.push({ pattern: source, message: `invalid regex: ${compiled}`, fatal: true });
      } else {
        patterns.push(compiled);
      }
      continue;
    }

    const spec = parseHostForm(s) ?? (REGEX_META_RE.test(s) ? convertLegacy(s) : null);
    if (spec !== null) {
      patterns.push(hostPattern(source, spec, list));
      if (list !== 'allowed' && !spec.host.includes('.') && !spec.subdomainsOnly && s === spec.host) {
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

    const legacy = regexPattern(source, s, 'legacy');
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
