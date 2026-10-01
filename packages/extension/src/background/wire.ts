// Wire protocol helpers: action names in, response envelope out (L0, pure).

import { WIRE_ACTION_MAP } from "../action-map";
import type { CommandResult } from "./types";

type ResolvedAction =
  | { kind: "action"; action: string | undefined }
  | { kind: "notImplemented"; wireName: string }
  | { kind: "unknown"; wireName: string };

/**
 * Convert a wire action name (snake_case, see action-map.ts) to the internal
 * name. `fromHost`: the command came over Native Messaging (it carries a
 * requestId); only the wire names of the table are accepted there, anything
 * else is `unknown`. Other names pass through unchanged for the Extension's
 * own pages (popup), which use internal names such as "status"; an unknown
 * one still ends in the dispatcher's "Unknown action" branch.
 */
export function resolveWireAction(raw: string | undefined, fromHost = false): ResolvedAction {
  if (raw === undefined) return { kind: "action", action: undefined };
  const mapped = WIRE_ACTION_MAP.get(raw);
  if (mapped === null) return { kind: "notImplemented", wireName: raw };
  if (mapped === undefined && fromHost) return { kind: "unknown", wireName: raw };
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
