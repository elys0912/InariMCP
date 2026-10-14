import { z } from 'zod';
import { BrowserActionSchema } from './actions.js';
import { MAX_PORT } from './constants.js';
import { formatZodIssues, isRecord } from './util.js';

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

/** Standard error codes returned in ToolResult.code */
export const ErrorCode = {
  SAFETY_BLOCKED: 'SAFETY_BLOCKED',
  ELEMENT_NOT_FOUND: 'ELEMENT_NOT_FOUND',
  TIMEOUT: 'TIMEOUT',
  CONNECTION_ERROR: 'CONNECTION_ERROR',
  INVALID_ARGUMENTS: 'INVALID_ARGUMENTS',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

// ---------------------------------------------------------------------------
// URL rule  (one safety.json URL pattern, as the Extension matches it)
// ---------------------------------------------------------------------------

/**
 * One URL pattern of safety.json (blocked_url_patterns, allowed_url_patterns,
 * confirm_read_sites), compiled by
 * the MCP Server (safety/url-pattern.ts) into the form the Extension
 * matches against a tab URL (extension/src/url-rule.ts applies the same
 * rules; tests/contract/url-rule.test.ts checks both give the same result).
 *
 *   host   the URL is parsed; `host` (lower-case, punycode) compares to its
 *          hostname without a trailing dot: `hosts` 'tree' = the host and
 *          every subdomain, 'sub' = subdomains only, 'exact' = the host only.
 *          `scheme` (lower-case, no ':') restricts the scheme when not null.
 *          An IPv6 host is written in brackets, as URL.hostname has it.
 *          `port` restricts the URL's port when not null (absent = null,
 *          older servers); a URL without one has its scheme's default
 *          (http / ws 80, https / wss 443, ftp 21).
 *          `path` (null = any) is a prefix of the URL path:
 *            'strict' (allowed list): as written, case-sensitive, at a
 *                     segment boundary unless it ends with '/';
 *            'loose'  (blocked / confirm-read): `path` is already normalised;
 *                     the URL path is compared after percent-decoding,
 *                     collapsing repeated slashes and lower-casing, as a
 *                     plain prefix (/admin covers /administrator).
 *   regex  `re` is tested with flag i against the normalised URL
 *          (scheme://host[:port]/path?query#hash, lower-case host without a
 *          trailing dot, no userinfo); with `matchRaw` also against the URL
 *          as given (blocked / confirm-read lists: over-matching errs on the
 *          safe side).
 *
 * `source` is the pattern as written in safety.json (reported back as
 * `matchedPattern`, never matched itself).
 */
export const WireUrlRuleSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('host'),
    source: z.string(),
    scheme: z.string().nullable(),
    hosts: z.enum(['tree', 'sub', 'exact']),
    host: z.string(),
    port: z.number().int().min(1).max(MAX_PORT).nullable().optional(),
    path: z.string().nullable(),
    pathMatch: z.enum(['strict', 'loose']),
  }),
  z.object({
    kind: z.literal('regex'),
    source: z.string(),
    re: z.string(),
    matchRaw: z.boolean(),
  }),
]);

export type WireUrlRule = z.infer<typeof WireUrlRuleSchema>;

// ---------------------------------------------------------------------------
// BrowserCommand  (MCP Server → Extension / Headless Backend)
// ---------------------------------------------------------------------------

export const BrowserCommandSchema = z.object({
  action: BrowserActionSchema,
  tabId: z.number().int().optional(),
  data: z.record(z.unknown()).optional(),
  requestId: z.string(),
  /**
   * Layer 0 container scope. Attached to EVERY command when
   * safety.json `container_scope.enabled` is true. The Extension enforces it
   * against the target tab's cookieStoreId (the MCP Server cannot see tabs).
   */
  containerScope: z.object({ containerName: z.string().min(1) }).optional(),
  /**
   * safety.json `confirm_read_sites` as URL rules. Attached when the guard is
   * enabled and the list is not empty, to every command of a reading tool
   * (screenshots, text, elements, page info, find). The Extension refuses
   * with `safetyDecision: "confirmation_required"` when the actual target
   * tab matches (unless `approvedHost` is its site); screenshot_all_tabs
   * skips such tabs. Covers the case where the server does not know the
   * tab's URL.
   */
  confirmReadUrlRules: z.array(WireUrlRuleSchema).optional(),
  /**
   * safety.json `blocked_url_patterns` / `allowed_url_patterns` as URL
   * rules. Attached when the guard is enabled and the list is not empty, to
   * every command the guard checks against the target tab's last-known URL
   * (tools that act on or read an existing tab without a `url` target; see
   * attachSafetyMetadata). The Extension refuses the command when the
   * actual target tab is on an http(s) URL that a blocked rule matches
   * (safetyDecision "blocked_url") or, with allowed rules, that no allowed
   * rule matches ("not_allowlisted"); multi-tab actions skip such tabs.
   * Covers the case where the server does not know the tab's URL.
   */
  blockedUrlRules: z.array(WireUrlRuleSchema).optional(),
  allowedUrlRules: z.array(WireUrlRuleSchema).optional(),
  /**
   * Set only on a call the human approved (one-time approval token consumed
   * by the MCP Server): the site the approval covers (lower-case hostname,
   * or the scheme such as `file:` for a URL without one). The Extension runs
   * an acting command only when the site it acts on (the target tab, or the
   * URL it opens) is this site, and lets a read run on a confirm_read_sites
   * tab of this site. It does not lift the blocked / allowed rules.
   */
  approvedHost: z.string().optional(),
});

export type BrowserCommand = z.infer<typeof BrowserCommandSchema>;

// ---------------------------------------------------------------------------
// Approval prompt  (data of a `request_approval` command the MCP Server
// sends for a tool call that needs human approval; shown in the Extension's
// popup)
// ---------------------------------------------------------------------------

/**
 * `BrowserCommand.data` of `request_approval` when the MCP Server asks the
 * human whether to allow one tool call (kind `tool_call`): an acting tool,
 * or a read of a confirm_read_sites site. The Extension shows it in its
 * toolbar popup — never in the page — and answers
 * `{ approved, timedOut, cancelled, approvalId }`.
 *
 * fox_request_approval sends `{ message, detail?, timeout }` instead (no
 * `kind`); its answer never unlocks anything.
 */
export const ApprovalPromptSchema = z.object({
  kind: z.literal('tool_call'),
  approvalId: z.string(),
  toolName: z.string(),
  /** The site the approval covers (see BrowserCommand `approvedHost`). */
  host: z.string(),
  url: z.string(),
  /** The confirm_read_sites entry of a read; null for an acting tool. */
  matchedPattern: z.string().nullable(),
  /** Argument summary, one `key: value` per line. */
  summary: z.string(),
  /** Epoch ms after which the MCP Server no longer accepts the answer. */
  expiresAt: z.number(),
  /** How long the Extension waits for the human (ms). */
  timeout: z.number(),
});

export type ApprovalPrompt = z.infer<typeof ApprovalPromptSchema>;

// ---------------------------------------------------------------------------
// BrowserResponse  (Extension → MCP Server)
// ---------------------------------------------------------------------------

/**
 * The `safetyDecision` values the Extension sends with a refusal
 * (background/url-policy.ts, container-scope.ts, dispatch.ts). The wire
 * field stays a string, so that an older or newer Extension still parses;
 * the MCP Server narrows it against this list and treats any other value
 * as an unknown refusal.
 */
export const BROWSER_SAFETY_DECISIONS = [
  'confirmation_required',
  'blocked_url',
  'not_allowlisted',
  'out_of_scope',
  'config_error',
  // The user paused agent actions in the toolbar popup (dispatch.ts).
  'paused',
] as const;
export type BrowserSafetyDecision = (typeof BROWSER_SAFETY_DECISIONS)[number];

export const BrowserResponseSchema = z.object({
  requestId: z.string(),
  success: z.boolean(),
  /**
   * Result payload, passed through whole. Well-known keys:
   *   - `url`: page URL after the operation (feeds SafetyGuard.noteUrl)
   *   - `closed`: id of the tab close_tab closed (SafetyGuard forgets its URL)
   *   - `imagePath`: screenshot file saved by the Native Host / headless
   *     backend (`imageData` never reaches the MCP Server on the Extension
   *     path — the Native Host swaps it for a file path)
   *   - `screenshots[i].imagePath`: same, for scope all_tabs
   */
  data: z.record(z.unknown()).optional(),
  error: z.string().optional(),
  /**
   * Set when the Extension refused the command for a safety reason
   * (e.g. 'out_of_scope' from Layer 0). Lets the MCP Server distinguish
   * safety denials from ordinary browser errors.
   */
  safetyDecision: z.string().optional(),
});

export type BrowserResponse = z.infer<typeof BrowserResponseSchema>;

/** Result of {@link parseBrowserResponse}. */
export type ParsedBrowserResponse =
  | { ok: true; response: BrowserResponse }
  | {
      ok: false;
      /** requestId, when one could be recovered from the invalid frame. */
      requestId: string | undefined;
      error: string;
    };

/**
 * Validate one decoded browser response frame against BrowserResponseSchema.
 *
 * Single entry point for every transport that receives responses (the WS
 * bridge today). Unknown top-level keys are stripped; `data` is kept whole.
 * When validation fails but a string `requestId` is present, it is returned
 * so the caller can fail that pending request right away instead of letting
 * it time out.
 */
export function parseBrowserResponse(raw: unknown): ParsedBrowserResponse {
  const result = BrowserResponseSchema.safeParse(raw);
  if (result.success) {
    return { ok: true, response: result.data };
  }

  const id = isRecord(raw) ? raw['requestId'] : undefined;
  const requestId = typeof id === 'string' ? id : undefined;
  return { ok: false, requestId, error: `Invalid browser response: ${formatZodIssues(result.error.issues)}` };
}

// ---------------------------------------------------------------------------
// Safety block detail  (attached to ToolResult when code === SAFETY_BLOCKED)
// ---------------------------------------------------------------------------

export const SafetyBlockDetailSchema = z.object({
  layer: z.number().int(),
  decision: z.string(),
  url: z.string().optional(),
  resolution: z.string().optional(),
});

export type SafetyBlockDetail = z.infer<typeof SafetyBlockDetailSchema>;

// ---------------------------------------------------------------------------
// Elicitation payload  (what the human is asked to approve)
// ---------------------------------------------------------------------------

export const ElicitationPayloadSchema = z.object({
  /** The URL the call acts on or reads; null when the server does not know the tab's page. */
  url: z.string().nullable(),
  /** The confirm_read_sites entry of a read; null for an acting tool. */
  matchedPattern: z.string().nullable(),
  toolName: z.string(),
});

export type ElicitationPayload = z.infer<typeof ElicitationPayloadSchema>;

// ---------------------------------------------------------------------------
// ToolResult  (MCP Server → Claude Code)
//
// Unified envelope for all tool responses. On success, `data` carries the
// result payload. On failure, `error` is a human-readable message, `code`
// is a machine-readable error code, and `details` may carry structured
// context (e.g. SafetyBlockDetail).
//
// When confirmationRequired is true, the MCP Server has opened a one-time
// human-approval request (details.approval); the stdio relay asks the human
// (MCP elicitation, else the Extension's popup) and retries with the token.
// ---------------------------------------------------------------------------

export const ToolResultSchema = z.object({
  success: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional(),
  code: z.string().optional(),
  details: z.record(z.unknown()).optional(),
  confirmationRequired: z.boolean().optional(),
  elicitation: ElicitationPayloadSchema.optional(),
});

export type ToolResult = z.infer<typeof ToolResultSchema>;
