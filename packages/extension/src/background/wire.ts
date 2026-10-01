// Wire protocol helpers: action names in, response envelope out (L0, pure).

import { WIRE_ACTION_MAP } from "../action-map";
import type { CommandResult } from "./types";

type ResolvedAction =
  | { kind: "action"; action: string | undefined }
  | { kind: "notImplemented"; wireName: string };

/**
 * Convert a wire action name (snake_case, see action-map.ts) to the internal
 * name. Names not in the table pass through unchanged: internal callers
 * (popup, content script) already use internal names such as "status", and
 * anything unknown still ends in the dispatcher's "Unknown action" branch.
 */
export function resolveWireAction(raw: string | undefined): ResolvedAction {
  if (raw === undefined) return { kind: "action", action: undefined };
  const mapped = WIRE_ACTION_MAP.get(raw);
  if (mapped === null) return { kind: "notImplemented", wireName: raw };
  return { kind: "action", action: mapped ?? raw };
}

/** Response envelope sent back over Native Messaging (BrowserResponse). */
interface WireResponse {
  requestId: number | string;
  success: boolean;
  error?: string;
  safetyDecision?: string;
  data?: Record<string, unknown>;
}

/**
 * Wrap a handler result in the wire contract: success / error /
 * safetyDecision stay top-level, every other field goes into `data`.
 */
export function toWireResponse(requestId: number | string, result: CommandResult): WireResponse {
  const { success, error, safetyDecision, ...rest } = result;
  const response: WireResponse = { requestId, success };
  if (typeof error === "string") response.error = error;
  if (typeof safetyDecision === "string") response.safetyDecision = safetyDecision;
  if (Object.keys(rest).length > 0) response.data = rest;
  return response;
}
