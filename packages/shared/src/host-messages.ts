/**
 * Messages the Extension sends to the Native Host for the host itself (not
 * MCP tool responses, which carry a requestId and no action):
 *
 *   ping                              → pong
 *   status                            → daemon / WebSocket / version info
 *   saveScreenshot | screenshotTaken  → save a screenshot the Extension took
 *                                       on its own (popup, context menu)
 *
 * Extra fields (requestId, …) pass through.
 */

import { z } from 'zod';
import { formatZodIssues } from './util.js';

export const HostPingSchema = z.object({ action: z.literal('ping') }).passthrough();

export const HostStatusSchema = z.object({ action: z.literal('status') }).passthrough();

export const HostSaveScreenshotSchema = z
  .object({
    action: z.enum(['saveScreenshot', 'screenshotTaken']),
    /** The data URL, or `{ imageData }`. */
    data: z.union([z.string(), z.object({ imageData: z.string() }).passthrough()]),
    /** Ignored unless a string (then sanitized by the host). */
    filename: z.string().optional().catch(undefined),
  })
  .passthrough();

export type HostLocalMessage =
  | z.infer<typeof HostPingSchema>
  | z.infer<typeof HostStatusSchema>
  | z.infer<typeof HostSaveScreenshotSchema>;

export type HostLocalAction = HostLocalMessage['action'];

/** A schema whose output is a host-local message (input: anything). */
type HostMessageSchema = z.ZodType<HostLocalMessage, z.ZodTypeDef, unknown>;

// satisfies: a missing or an extra action is a compile error
const SCHEMAS = {
  ping: HostPingSchema,
  status: HostStatusSchema,
  saveScreenshot: HostSaveScreenshotSchema,
  screenshotTaken: HostSaveScreenshotSchema,
} satisfies Record<HostLocalAction, HostMessageSchema>;

function isHostLocalAction(action: string): action is HostLocalAction {
  // hasOwn: 'constructor', '__proto__', … must not resolve to Object.prototype members
  return Object.hasOwn(SCHEMAS, action);
}

export type ParsedHostMessage =
  | { ok: true; message: HostLocalMessage }
  | { ok: false; action: HostLocalAction; error: string }
  | { ok: false; action: undefined; error: 'not a host message' };

/**
 * Validate a host-local message. `action: undefined` in the failure means
 * the message is not one of the host's own (a response, or unknown).
 */
export function parseHostMessage(raw: Record<string, unknown>): ParsedHostMessage {
  const action = raw['action'];
  if (typeof action !== 'string' || !isHostLocalAction(action)) {
    return { ok: false, action: undefined, error: 'not a host message' };
  }
  const schema: HostMessageSchema = SCHEMAS[action];
  const result = schema.safeParse(raw);
  if (result.success) return { ok: true, message: result.data };
  return { ok: false, action, error: `invalid ${action} message: ${formatZodIssues(result.error.issues)}` };
}
