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

const SCHEMAS: Record<string, z.ZodTypeAny> = {
  ping: HostPingSchema,
  status: HostStatusSchema,
  saveScreenshot: HostSaveScreenshotSchema,
  screenshotTaken: HostSaveScreenshotSchema,
};

export type ParsedHostMessage =
  | { ok: true; message: HostLocalMessage }
  | { ok: false; action: string; error: string }
  | { ok: false; action: undefined; error: 'not a host message' };

/**
 * Validate a host-local message. `action: undefined` in the failure means
 * the message is not one of the host's own (a response, or unknown).
 */
export function parseHostMessage(raw: Record<string, unknown>): ParsedHostMessage {
  const action = typeof raw['action'] === 'string' ? raw['action'] : undefined;
  const schema = action === undefined ? undefined : SCHEMAS[action];
  if (action === undefined || schema === undefined) {
    return { ok: false, action: undefined, error: 'not a host message' };
  }
  const result = schema.safeParse(raw);
  if (result.success) return { ok: true, message: result.data as HostLocalMessage };
  const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
  return { ok: false, action, error: `invalid ${action} message: ${issues}` };
}
