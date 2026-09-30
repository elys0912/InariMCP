import { z } from 'zod';
import { BrowserActionSchema } from './actions.js';

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
  containerScope: z.object({ containerName: z.string() }).optional(),
  /**
   * Protected-domain regex patterns (safety.json `protected_url_patterns`).
   * Attached to `screenshot` and `screenshot_all_tabs` when the guard is
   * enabled and `confirm_protected_actions` is true. For all_tabs the
   * Extension excludes protected tabs; for a single screenshot it refuses
   * with `safetyDecision: "confirmation_required"` when the target tab's URL
   * matches (the MCP Server cannot see which tab is actually captured).
   * Also attached to `start_logging`, `get_console_logs` and
   * `get_network_logs` (same condition): start_logging on a protected tab is
   * refused the same way, and recording pauses while a logging tab is on a
   * protected page (`pausedForProtectedDomain` in the get_* results).
   * Also attached to every acting tool without a `url` argument; the
   * Extension refuses it the same way when the actual target tab matches.
   */
  protectedUrlPatterns: z.array(z.string()).optional(),
  /**
   * Set only on a call the human approved (one-time approval token consumed
   * by the MCP Server): lower-case hostname the approval covers. The
   * Extension still applies `protectedUrlPatterns`, but lets the command run
   * on a protected tab whose hostname equals this value.
   */
  approvedHost: z.string().optional(),
});

export type BrowserCommand = z.infer<typeof BrowserCommandSchema>;

// ---------------------------------------------------------------------------
// Approval prompt  (data of a `request_approval` command the MCP Server
// sends for a protected-site action; shown in the Extension's popup)
// ---------------------------------------------------------------------------

/**
 * `BrowserCommand.data` of `request_approval` when the MCP Server asks the
 * human about a protected-site action (kind `protected_action`). The
 * Extension shows it in its toolbar popup — never in the page — and answers
 * `{ approved, timedOut, cancelled, approvalId }`.
 *
 * fox_request_approval sends `{ message, detail?, timeout }` instead (no
 * `kind`); its answer never unlocks anything.
 */
export const ApprovalPromptSchema = z.object({
  kind: z.literal('protected_action'),
  approvalId: z.string(),
  toolName: z.string(),
  host: z.string(),
  url: z.string(),
  matchedPattern: z.string(),
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

export const BrowserResponseSchema = z.object({
  requestId: z.string(),
  success: z.boolean(),
  /**
   * Result payload, passed through whole. Well-known keys:
   *   - `url`: page URL after the operation (feeds SafetyGuard.noteUrl)
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

  let requestId: string | undefined;
  if (typeof raw === 'object' && raw !== null && 'requestId' in raw) {
    const id: unknown = (raw as { requestId: unknown }).requestId;
    if (typeof id === 'string') requestId = id;
  }

  const issues = result.error.issues
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
  return { ok: false, requestId, error: `Invalid browser response: ${issues}` };
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
// Elicitation payload  (for MCP elicitation on protected domains)
// ---------------------------------------------------------------------------

export const ElicitationPayloadSchema = z.object({
  protectedUrl: z.string(),
  matchedPattern: z.string(),
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
