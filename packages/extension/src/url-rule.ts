// InariMCP URL rules (background script)
//
// Matches the safety.json URL patterns the MCP Server attaches to a command
// (BrowserCommand confirmReadUrlRules / blockedUrlRules / allowedUrlRules,
// shared/src/protocol.ts WireUrlRuleSchema) against a tab URL, by the rules
// of mcp-server src/safety/url-pattern.ts:
//   host   the URL is parsed and its hostname (lower-case, no trailing dot)
//          compared, never the raw string: `example.com.attacker.net`,
//          `https://example.com@attacker.net/` or a query naming the host
//          do not match. `port` (null = any) compares to the URL's port or
//          its scheme's default. `path` is a prefix: 'strict' as written, at a
//          segment boundary; 'loose' after percent-decoding, collapsing
//          repeated slashes and lower-casing.
//   regex  tested (flag i) against the normalised URL, and with matchRaw
//          also against the URL as given.
// This is a separate implementation of the same rules (url-pattern.ts is
// not browser code; moving the rules to packages/shared is left for later);
// tests/contract/url-rule.test.ts checks that both give the same result.
//
// Imported by the background modules (bundled into dist/background.js). Keep
// it dependency-free and without top-level side effects.

export interface HostUrlRule {
  kind: "host";
  source: string;
  scheme: string | null;
  hosts: "tree" | "sub" | "exact";
  host: string;
  /** null: any port (also when an older server sent none). */
  port: number | null;
  path: string | null;
  pathMatch: "strict" | "loose";
}

export interface RegexUrlRule {
  kind: "regex";
  source: string;
  re: string;
  matchRaw: boolean;
}

export type UrlRule = HostUrlRule | RegexUrlRule;

/** A rule ready to test (its regex compiled once). */
export interface CompiledUrlRule {
  rule: UrlRule;
  regex: RegExp | null;
}

// Named result types: tests cut these functions out of the source, which
// needs the body to be the first `{` after the parameter list.

/** compileUrlRules: usable rules, and how many entries were not. */
export interface CompiledUrlRules {
  rules: CompiledUrlRule[];
  invalid: number;
}

/** normalizeRuleUrl. */
export interface RuleUrl {
  url: URL;
  hostname: string;
  normalized: string;
}

/** urlListViolation. */
export interface UrlListViolation {
  decision: "blocked_url" | "not_allowlisted";
  reason: string;
}

/** A TCP port number (1-65535). */
function isPortNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
}

function isHostsKind(value: unknown): value is HostUrlRule["hosts"] {
  return value === "tree" || value === "sub" || value === "exact";
}

function isPathMatch(value: unknown): value is HostUrlRule["pathMatch"] {
  return value === "strict" || value === "loose";
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

/**
 * A rule's path: null, or a string without `?` / `#`. A path is compared
 * with the URL's pathname, which never holds a query or fragment: such a
 * rule would match nothing (the server refuses the pattern; this guards
 * against a server that does not).
 */
function isRulePath(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && !/[?#]/.test(value));
}

/** A rule's port: null (any port) or a port number. */
function isRulePort(value: unknown): value is number | null {
  return value === null || isPortNumber(value);
}

/** Validate a wire entry of kind "host". null if unusable. */
function parseHostRule(r: Record<string, unknown>, source: string): HostUrlRule | null {
  const { host, hosts, scheme, path, pathMatch } = r;
  // A missing port is any port (also when an older server sent none).
  const port = r.port ?? null;
  if (typeof host !== "string" || host === "") return null;
  if (!isHostsKind(hosts) || !isNullableString(scheme) || !isRulePath(path)) return null;
  if (!isPathMatch(pathMatch) || !isRulePort(port)) return null;

  return { kind: "host", source, scheme, hosts, host, port, path, pathMatch };
}

/** Validate a wire entry of kind "regex". null if unusable. */
function parseRegexRule(r: Record<string, unknown>, source: string): RegexUrlRule | null {
  const { re, matchRaw } = r;
  if (typeof re !== "string" || typeof matchRaw !== "boolean") return null;

  return { kind: "regex", source, re, matchRaw };
}

/** Validate one wire entry. null if unusable. */
export function parseUrlRule(raw: unknown): UrlRule | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.source !== "string") return null;
  if (r.kind === "host") return parseHostRule(r, r.source);
  if (r.kind === "regex") return parseRegexRule(r, r.source);
  return null;
}

/** Compile a parsed rule; null when its regex does not compile. */
export function compileUrlRule(rule: UrlRule): CompiledUrlRule | null {
  if (rule.kind === "host") return { rule, regex: null };
  try {
    return { rule, regex: new RegExp(rule.re, "i") };
  } catch {
    return null;
  }
}

/**
 * Compile a wire list (undefined: no rules). `invalid` counts the entries
 * that could not be used, and a list that is there but not an array counts
 * as one; the caller decides whether that fails closed.
 */
export function compileUrlRules(raw: unknown): CompiledUrlRules {
  const rules: CompiledUrlRule[] = [];
  let invalid = 0;
  if (raw === undefined) return { rules, invalid };
  if (!Array.isArray(raw)) return { rules, invalid: 1 };
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
export function normalizeRuleUrl(raw: string): RuleUrl | null {
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

/** The URL's port, or its scheme's default (url-pattern.ts effectivePort); null if none. */
function effectiveRulePort(url: URL): number | null {
  if (url.port !== "") return Number(url.port);
  const defaults: Record<string, number> = { "http:": 80, "https:": 443, "ws:": 80, "wss:": 443, "ftp:": 21 };
  return defaults[url.protocol] ?? null;
}

/** Path as 'loose' rules compare it: decoded, single slashes, lower case. */
export function looseRulePath(pathname: string): string {
  let p = pathname;
  try {
    p = decodeURIComponent(p);
  } catch {
    // Malformed escapes: compare as written.
  }
  return p.replace(/\/{2,}/g, "/").toLowerCase();
}

/** A regex rule: the normalised URL, and with matchRaw the URL as given (also when it does not parse). */
function regexRuleMatches(rule: RegexUrlRule, re: RegExp | null, raw: string, n: RuleUrl | null): boolean {
  if (re === null) return false;
  if (n === null) return rule.matchRaw && re.test(raw);
  return re.test(n.normalized) || (rule.matchRaw && re.test(raw));
}

/** Whether `hostname` is one of the hosts the rule covers ('exact', 'sub' or 'tree'). */
function ruleHostMatches(rule: HostUrlRule, hostname: string): boolean {
  const isSub = hostname.endsWith(`.${rule.host}`);
  if (rule.hosts === "exact") return hostname === rule.host;
  if (rule.hosts === "sub") return isSub;
  return hostname === rule.host || isSub;
}

/** Whether the URL's path starts with the rule's (null: any path), strict at a segment boundary. */
function rulePathMatches(rule: HostUrlRule, url: URL): boolean {
  const want = rule.path;
  if (want === null) return true;
  const strict = rule.pathMatch === "strict";
  const actual = strict ? url.pathname : looseRulePath(url.pathname);
  if (!actual.startsWith(want)) return false;
  const boundary = strict && !want.endsWith("/");
  return !boundary || actual.length === want.length || actual[want.length] === "/";
}

/** A host rule: scheme, host, port and path of the parsed URL (one with a host). */
function hostRuleMatches(rule: HostUrlRule, n: RuleUrl | null): boolean {
  if (n === null || n.hostname === "") return false;
  if (rule.scheme !== null && n.url.protocol !== `${rule.scheme}:`) return false;
  if (!ruleHostMatches(rule, n.hostname)) return false;
  if (rule.port !== null && effectiveRulePort(n.url) !== rule.port) return false;
  return rulePathMatches(rule, n.url);
}

/** Whether the URL matches the rule (url-pattern.ts UrlPattern.test). */
export function urlRuleMatches(compiled: CompiledUrlRule, raw: string): boolean {
  const rule = compiled.rule;
  const n = normalizeRuleUrl(raw);
  return rule.kind === "regex" ? regexRuleMatches(rule, compiled.regex, raw, n) : hostRuleMatches(rule, n);
}

/** The first rule the URL matches, if any. */
export function findUrlRule(url: string | undefined, rules: CompiledUrlRule[]): CompiledUrlRule | undefined {
  if (!url) return undefined;
  return rules.find((r) => urlRuleMatches(r, url));
}

/**
 * Whether the URL violates the blocked / allowed lists (guard.ts
 * _listViolation). Only http(s) URLs are subject to them. `allowlistActive`:
 * the server sent an allowed list (even if none of its entries was usable,
 * so that a broken list cannot open everything).
 */
export function urlListViolation(
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
