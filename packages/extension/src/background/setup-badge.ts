// Setup state (popup guidance) and the toolbar badge (L2). The badge shows
// the pending approval count reported by approvals.ts, else the setup state.

import { t } from "../i18n";
import type { SetupState } from "../types/setup";
import { hostStatus, sendToNativeHost } from "./native-connection";

/** Native Host reply to `status` (packages/native-host/src/index.ts). */
interface HostStatusReply {
  mcp_server?: { url?: string; available?: boolean; relays?: number | null };
  claude_register_command?: string;
}

const NATIVE_HOST_MISSING = /No such native application/i;
/** The host checks /health and /daemon/info with 3 s timeouts each. */
const SETUP_STATUS_TIMEOUT_MS = 5_000;
/** Matches the relay heartbeat, so a new session shows up within ~30 s. */
export const SETUP_REFRESH_MS = 30_000;
export const BADGE_COLOR = "#D9372B";

async function getSetupState(): Promise<SetupState> {
  const host = hostStatus();
  if (!host.confirmed || !host.portOpen) {
    const lastHostError = host.lastError;
    if (lastHostError === null) return { kind: "connecting" };
    return NATIVE_HOST_MISSING.test(lastHostError)
      ? { kind: "hostMissing", error: lastHostError }
      : { kind: "hostError", error: lastHostError };
  }

  let reply: HostStatusReply;
  try {
    reply = (await Promise.race([
      sendToNativeHost({ action: "status" }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Native host status timed out")), SETUP_STATUS_TIMEOUT_MS),
      ),
    ])) as HostStatusReply;
  } catch (error) {
    return { kind: "hostError", error: (error as Error).message };
  }

  const server = reply.mcp_server ?? {};
  const serverUrl = typeof server.url === "string" ? server.url : undefined;
  // Native Hosts before 0.1.2 do not send `relays` at all (current ones send
  // null when the daemon info is unavailable): not a daemon problem.
  if (server.available === true && !("relays" in server)) {
    return { kind: "hostOutdated", serverUrl };
  }
  if (server.available !== true || typeof server.relays !== "number") {
    return { kind: "daemonDown", serverUrl };
  }
  if (server.relays === 0) {
    return {
      kind: "noSession",
      serverUrl,
      registerCommand:
        typeof reply.claude_register_command === "string" ? reply.claude_register_command : undefined,
    };
  }
  return { kind: "ready", serverUrl, relays: server.relays };
}

/** Toolbar tooltip per state (message keys); null = the plain name. */
const BADGE_TITLE_KEYS: Record<SetupState["kind"], string | null> = {
  connecting: null,
  hostMissing: "badgeSetupNeeded",
  hostError: "badgeHostError",
  hostOutdated: "badgeHostOutdated",
  daemonDown: "badgeDaemonDown",
  noSession: "badgeNoSession",
  ready: null,
};

const APPROVAL_BADGE_COLOR = "#E5A00D";
let lastSetupState: SetupState = { kind: "connecting" };

/** Pending approval requests, as approvals.ts last reported them. */
let pendingApprovalCount = 0;

/** approvals.ts: the number of pending approval requests changed. */
export function setPendingApprovalCount(count: number): void {
  pendingApprovalCount = count;
  renderBadge();
}

function applyBadge(state: SetupState): void {
  lastSetupState = state;
  renderBadge();
}

/**
 * Pending approval requests take precedence (count on an amber badge): the
 * popup is where the human answers them. Otherwise the setup state.
 */
function renderBadge(): void {
  const pending = pendingApprovalCount;
  if (pending > 0) {
    browser.browserAction.setBadgeBackgroundColor({ color: APPROVAL_BADGE_COLOR }).catch(() => {});
    browser.browserAction.setBadgeText({ text: String(pending) }).catch(() => {});
    browser.browserAction.setTitle({ title: t("badgeApprovalPending", String(pending)) }).catch(() => {});
    return;
  }
  const state = lastSetupState;
  const attention = state.kind !== "ready" && state.kind !== "connecting";
  const titleKey = BADGE_TITLE_KEYS[state.kind];
  browser.browserAction.setBadgeBackgroundColor({ color: BADGE_COLOR }).catch(() => {});
  browser.browserAction.setBadgeText({ text: attention ? "!" : "" }).catch(() => {});
  browser.browserAction
    .setTitle({ title: titleKey === null ? "KitsuneMCP" : t(titleKey) })
    .catch(() => {});
}

export async function refreshSetupState(): Promise<SetupState> {
  const state = await getSetupState();
  applyBadge(state);
  return state;
}
