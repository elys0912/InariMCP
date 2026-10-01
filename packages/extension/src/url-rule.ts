// KitsuneMCP URL rules (shared by the background and content scripts)
//
// Matches the safety.json URL patterns the MCP Server attaches to a command
// (BrowserCommand protectedUrlRules / blockedUrlRules / allowedUrlRules,
// shared/src/protocol.ts WireUrlRuleSchema) against a tab URL, by the rules
// of mcp-server src/safety/url-pattern.ts:
//   host   the URL is parsed and its hostname (lower-case, no trailing dot)
//          compared, never the raw string: `example.com.attacker.net`,
//          `https://example.com@attacker.net/` or a query naming the host
//          do not match. `path` is a prefix: 'strict' as written, at a
//          segment boundary; 'loose' after percent-decoding, collapsing
//          repeated slashes and lower-casing.
//   regex  tested (flag i) against the normalised URL, and with matchRaw
//          also against the URL as given.
// The Extension cannot import url-pattern.ts (classic scripts, no bundler),
// so this is a separate implementation of the same rules;
// tests/contract/url-rule.test.ts checks that both give the same result.
//
// A plain string is the legacy form (`protectedUrlPatterns` of older MCP
// Servers): a regex over the raw URL, read as a regex rule with matchRaw.
//
// Loading: classic script without imports, loaded before background.js and
// before content.js (manifest.json). Keep it dependency-free.

interface HostUrlRule {
  kind: "host";
  source: string;
  scheme: string | null;
  hosts: "tree" | "sub" | "exact";
  host: string;
  path: string | null;
  pathMatch: "strict" | "loose";
}

interface RegexUrlRule {
  kind: "regex";
  source: string;
  re: string;
  matchRaw: boolean;
}

type UrlRule = HostUrlRule | RegexUrlRule;

/** A rule ready to test (its regex compiled once). */
interface CompiledUrlRule {
  rule: UrlRule;
  regex: RegExp | null;
}

// Named result types: tests cut these functions out of the source, which
// needs the body to be the first `{` after the parameter list.

/** compileUrlRules: usable rules, and how many entries were not. */
interface CompiledUrlRules {
  rules: CompiledUrlRule[];
  invalid: number;
}

/** normalizeRuleUrl. */
interface RuleUrl {
  url: URL;
  hostname: string;
  normalized: string;
}

/** urlListViolation. */
interface UrlListViolation {
  decision: "blocked_url" | "not_allowlisted";
  reason: string;
}

/** Validate one wire entry; a string is a legacy regex. null if unusable. */
function parseUrlRule(raw: unknown): UrlRule | null {
  if (typeof raw === "string") {
    return raw === "" ? null : { kind: "regex", source: raw, re: raw, matchRaw: true };
  }
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.source !== "string") return null;
  if (r.kind === "host") {
    if (typeof r.host !== "string" || r.host === "") return null;
    if (r.hosts !== "tree" && r.hosts !== "sub" && r.hosts !== "exact") return null;
    if (r.scheme !== null && typeof r.scheme !== "string") return null;
    if (r.path !== null && typeof r.path !== "string") return null;
    if (r.pathMatch !== "strict" && r.pathMatch !== "loose") return null;
    return {
      kind: "host",
      source: r.source,
      scheme: r.scheme,
      hosts: r.hosts,
      host: r.host,
      path: r.path,
      pathMatch: r.pathMatch,
    };
  }
  if (r.kind === "regex") {
    if (typeof r.re !== "string" || typeof r.matchRaw !== "boolean") return null;
    return { kind: "regex", source: r.source, re: r.re, matchRaw: r.matchRaw };
  }
  return null;
}

/** Compile a parsed rule; null when its regex does not compile. */
function compileUrlRule(rule: UrlRule): CompiledUrlRule | null {
  if (rule.kind === "host") return { rule, regex: null };
  try {
    return { rule, regex: new RegExp(rule.re, "i") };
  } catch {
    return null;
  }
}

/**
 * Compile a wire list (not an array: no rules). `invalid` counts the entries
 * that could not be used; the caller decides whether that fails closed.
 */
function compileUrlRules(raw: unknown): CompiledUrlRules {
  const rules: CompiledUrlRule[] = [];
  let invalid = 0;
  if (!Array.isArray(raw)) return { rules, invalid };
  for (const entry of raw) {
    const parsed = parseUrlRule(entry);
    const compiled = parsed === null ? null : compileUrlRule(parsed);
    if (compiled === null) invalid++;
    else rules.push(compiled);
  }
  return { rules, invalid };
}

/**
 * Parsed URL as the rules see it (url-pattern.ts normalizeUrl): hostname
 * lower-case without a trailing dot, '' when the URL has no host;
 * `normalized` is scheme://host[:port]/path?query#hash without userinfo.
 */
function normalizeRuleUrl(raw: string): RuleUrl | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const hostname = url.hostname.replace(/\.$/, "");
  const normalized = url.host
    ? `${url.protocol}//${hostname}${url.port ? `:${url.port}` : ""}${url.pathname}${url.search}${url.hash}`
    : url.href;
  return { url, hostname, normalized };
}

/** Path as 'loose' rules compare it: decoded, single slashes, lower case. */
function looseRulePath(pathname: string): string {
  let p = pathname;
  try {
    p = decodeURIComponent(p);
  } catch {
    // Malformed escapes: compare as written.
  }
  return p.replace(/\/{2,}/g, "/").toLowerCase();
}

/** Whether the URL matches the rule (url-pattern.ts UrlPattern.test). */
function urlRuleMatches(compiled: CompiledUrlRule, raw: string): boolean {
  const rule = compiled.rule;
  const n = normalizeRuleUrl(raw);
  if (rule.kind === "regex") {
    const re = compiled.regex;
    if (re === null) return false;
    if (n === null) return rule.matchRaw && re.test(raw);
    return re.test(n.normalized) || (rule.matchRaw && re.test(raw));
  }
  if (n === null || n.hostname === "") return false;
  if (rule.scheme !== null && n.url.protocol !== `${rule.scheme}:`) return false;
  const h = n.hostname;
  const isSub = h.endsWith(`.${rule.host}`);
  const hostOk =
    rule.hosts === "exact" ? h === rule.host
      : rule.hosts === "sub" ? isSub
        : h === rule.host || isSub;
  if (!hostOk) return false;
  const want = rule.path;
  if (want === null) return true;
  const strict = rule.pathMatch === "strict";
  const actual = strict ? n.url.pathname : looseRulePath(n.url.pathname);
  if (!actual.startsWith(want)) return false;
  const boundary = strict && !want.endsWith("/");
  return !boundary || actual.length === want.length || actual[want.length] === "/";
}

/** The first rule the URL matches, if any. */
function findUrlRule(url: string | undefined, rules: CompiledUrlRule[]): CompiledUrlRule | undefined {
  if (!url) return undefined;
  return rules.find((r) => urlRuleMatches(r, url));
}

/**
 * Whether the URL violates the blocked / allowed lists (guard.ts
 * _listViolation). Only http(s) URLs are subject to them. `allowlistActive`:
 * the server sent an allowed list (even if none of its entries was usable,
 * so that a broken list cannot open everything).
 */
function urlListViolation(
  url: string | undefined,
  blocked: CompiledUrlRule[],
  allowed: CompiledUrlRule[],
  allowlistActive: boolean,
): UrlListViolation | null {
  if (!url) return null;
  const n = normalizeRuleUrl(url);
  if (n === null || (n.url.protocol !== "http:" && n.url.protocol !== "https:")) return null;
  const hit = findUrlRule(url, blocked);
  if (hit) {
    return {
      decision: "blocked_url",
      reason: `matches blocked_url_patterns entry '${hit.rule.source}' in safety.json`,
    };
  }
  if (allowlistActive && findUrlRule(url, allowed) === undefined) {
    return {
      decision: "not_allowlisted",
      reason: "does not match allowed_url_patterns in safety.json (allowlist mode is active)",
    };
  }
  return null;
}
