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
   * Layer 0 container scope (design.md 7.1). Attached to EVERY command when
   * safety.json `container_scope.enabled` is true. The Extension enforces it
   * against the target tab's cookieStoreId (the MCP Server cannot see tabs).
   */
  containerScope: z.object({ containerName: z.string() }).optional(),
  /**
   * Protected-domain regex patterns (safety.json `protected_url_patterns`).
   * Attached only to `screenshot_all_tabs` when `confirm_protected_actions`
   * is true, so the Extension can exclude protected tabs from the capture.
   */
  protectedUrlPatterns: z.array(z.string()).optional(),
});

export type BrowserCommand = z.infer<typeof BrowserCommandSchema>;

// ---------------------------------------------------------------------------
// BrowserResponse  (Extension → MCP Server)
// ---------------------------------------------------------------------------

export const BrowserResponseSchema = z.object({
  requestId: z.string(),
  success: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional(),
  /**
   * Set when the Extension refused the command for a safety reason
   * (e.g. 'out_of_scope' from Layer 0). Lets the MCP Server distinguish
   * safety denials from ordinary browser errors.
   */
  safetyDecision: z.string().optional(),
});

export type BrowserResponse = z.infer<typeof BrowserResponseSchema>;

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
// When confirmationRequired is true, the caller should use MCP elicitation
// to ask the human for approval before retrying.
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
