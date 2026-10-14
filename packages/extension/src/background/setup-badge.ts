// Setup state (popup guidance) and the toolbar badge (L2). The badge is
// decided in one place (badgeFor) from the consent and the pause switch
// (control-state.ts), the pending approval count (approvals.ts), the running
// commands from the Native Host (dispatch.ts) and the setup state.

import { errorMessage } from "../error-message";
import { t } from "../i18n";
import type { SetupState } from "../types/setup";
import type { ControlView } from "../user-control";
import { controlView } from "./control-state";
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
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    reply = (await Promise.race([
      // The request itself gives up as well, so it does not stay pending.
      sendToNativeHost({ action: "status" }, { timeoutMs: SETUP_STATUS_TIMEOUT_MS }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Native host status timed out")), SETUP_STATUS_TIMEOUT_MS);
      }),
    ])) as HostStatusReply;
  } catch (error) {
    return { kind: "hostError", error: errorMessage(error) };
  } finally {
    clearTimeout(timer);
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
const NO_CONSENT_BADGE_COLOR = "#6C7086";
const PAUSED_BADGE_COLOR = "#1E66F5";
const ACTIVE_BADGE_COLOR = "#40A02B";
/** Badge text while a command from the Native Host runs (no word to translate). */
const ACTIVE_BADGE_TEXT = "●";
const DEFAULT_TITLE = "Inari MCP";

let lastSetupState: SetupState = { kind: "connecting" };

/** Pending approval requests, as approvals.ts last reported them. */
let pendingApprovalCount = 0;

/** Commands from the Native Host being handled now (dispatch.ts). */
let activeHostCommands = 0;

/** approvals.ts: the number of pending approval requests changed. */
export function setPendingApprovalCount(count: number): void {
  pendingApprovalCount = count;
  renderBadge();
}

/**
 * dispatch.ts: a command from the Native Host started. The returned function
 * marks its end; calling it again does nothing.
 */
export function startHostCommand(): () => void {
  activeHostCommands++;
  renderBadge();

  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    activeHostCommands--;
    renderBadge();
  };
}

/** background.ts: the consent or the pause switch changed (control-state.ts). */
export function refreshBadge(): void {
  renderBadge();
}

function applyBadge(state: SetupState): void {
  lastSetupState = state;
  renderBadge();
}

/** Everything the toolbar badge depends on. */
export interface BadgeInputs {
  control: ControlView;
  pendingApprovals: number;
  activeHostCommands: number;
  setup: SetupState;
}

/** What the toolbar badge shows. */
export interface BadgeView {
  text: string;
  color: string;
  title: string;
}

/**
 * The badge for `inputs`: the first of these that applies, so one state is
 * shown at a time.
 *   1. not allowed yet  nothing connects until the user allows it
 *   2. paused           every command from the Native Host is refused
 *   3. approvals        the human answers them in the popup (count)
 *   4. working          a command from the Native Host is running
 *   5. setup state      "!" when the setup needs attention, else no text
 * Approvals come before "working": a request_approval command is itself a
 * running command until the human answers.
 */
export function badgeFor(inputs: BadgeInputs): BadgeView {
  const { control, pendingApprovals, setup } = inputs;
  if (control.consent !== "granted") {
    return { text: t("badgeTextNoConsent"), color: NO_CONSENT_BADGE_COLOR, title: t("badgeNoConsent") };
  }
  if (control.paused) {
    return { text: t("badgeTextPaused"), color: PAUSED_BADGE_COLOR, title: t("badgePaused") };
  }
  if (pendingApprovals > 0) {
    const count = String(pendingApprovals);
    return { text: count, color: APPROVAL_BADGE_COLOR, title: t("badgeApprovalPending", count) };
  }
  if (inputs.activeHostCommands > 0) {
    return { text: ACTIVE_BADGE_TEXT, color: ACTIVE_BADGE_COLOR, title: t("badgeActive") };
  }

  const attention = setup.kind !== "ready" && setup.kind !== "connecting";
  const titleKey = BADGE_TITLE_KEYS[setup.kind];
  return {
    text: attention ? "!" : "",
    color: BADGE_COLOR,
    title: titleKey === null ? DEFAULT_TITLE : t(titleKey),
  };
}

/**
 * Show the badge of the current state (the only place that sets it). Best
 * effort: it runs inside the dispatcher for every command from the Native
 * Host, and a badge that cannot be drawn must not fail that command.
 */
function renderBadge(): void {
  try {
    const badge = badgeFor({
      control: controlView(),
      pendingApprovals: pendingApprovalCount,
      activeHostCommands,
      setup: lastSetupState,
    });
    browser.browserAction.setBadgeBackgroundColor({ color: badge.color }).catch(() => {});
    browser.browserAction.setBadgeText({ text: badge.text }).catch(() => {});
    browser.browserAction.setTitle({ title: badge.title }).catch(() => {});
  } catch (error) {
    console.error("[InariMCP] Could not update the toolbar badge:", errorMessage(error));
  }
}

/** Order of refreshSetupState calls, and the newest one whose state was applied. */
let setupRequested = 0;
let setupApplied = 0;

/**
 * Work out the setup state and show it on the badge. Calls overlap (the
 * interval, connection events, the popup's status); a result that arrives
 * after a later call's result is dropped, and that call gets the newer state.
 */
export async function refreshSetupState(): Promise<SetupState> {
  const call = ++setupRequested;
  const state = await getSetupState();
  if (call < setupApplied) return lastSetupState;
  setupApplied = call;
  applyBadge(state);
  return state;
}
