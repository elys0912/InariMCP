// InariMCP user control: the first-run consent and the pause switch (shared
// by the background, the popup and the consent page)
//
// The consent page (consent/consent.html) opens once, right after install.
// Until the user allows it there, the background does not connect to the
// Native Host at all. The pause switch in the toolbar popup makes the
// background refuse every command from the Native Host. The background keeps
// both in storage.local and is their only writer: the pages ask it through
// the runtime messages below (background/listeners.ts checks the sender).
//
// Imported by the background modules, popup.ts and consent.ts (bundled into
// each). Contract tests import it as a module.

/** Privacy policy linked from the consent page (also the AMO listing's). */
export const PRIVACY_POLICY_URL = "https://github.com/elys0912/InariMCP/blob/main/docs/PRIVACY.md";

/** The consent page, as a path for runtime.getURL. */
export const CONSENT_PAGE_PATH = "/dist/consent/consent.html";

/** runtime.sendMessage types between the pages and the background. */
export const CONTROL_MESSAGE = {
  /** any extension page → background: {} → ControlView */
  GET: "inari:control:get",
  /** consent page → background: { granted } → ControlReply */
  SET_CONSENT: "inari:control:consent",
  /** toolbar popup → background: { paused } → ControlReply */
  SET_PAUSED: "inari:control:pause",
} as const;

/** "undecided": neither button of the consent page was pressed yet. */
export type ConsentState = "undecided" | "granted" | "denied";

/** The user's choices, as the background holds them (serializable). */
export interface ControlView {
  consent: ConsentState;
  paused: boolean;
}

/**
 * The background's answer to SET_CONSENT / SET_PAUSED: the choices, and
 * whether storage.local kept the change. A change that was not saved is in
 * effect until Firefox restarts, then the last saved choice is back.
 */
export interface ControlReply extends ControlView {
  saved: boolean;
}

/** Whether `value` is a reply that says the change was not saved. */
export function isUnsavedReply(value: unknown): boolean {
  return typeof value === "object" && value !== null && (value as Record<string, unknown>).saved === false;
}

/** `value` as a ControlView, or null when it is not one (a failed reply). */
export function parseControlView(value: unknown): ControlView | null {
  if (typeof value !== "object" || value === null) return null;
  const { consent, paused } = value as Record<string, unknown>;
  const isConsent = consent === "undecided" || consent === "granted" || consent === "denied";
  if (!isConsent || typeof paused !== "boolean") return null;

  return { consent, paused };
}
