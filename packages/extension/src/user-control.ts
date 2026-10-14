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
// each). The background holds the state in background/control-state.ts.
// Contract tests import it as a module.

/**
 * Where the privacy policy linked from the consent page lives: on main, so
 * that an installed add-on always shows the current policy (the AMO listing
 * links to the policy of its own version tag instead).
 */
const PRIVACY_POLICY_DIR = "https://github.com/elys0912/InariMCP/blob/main/docs/";

/** The privacy policy in the UI language: Japanese for "ja" / "ja-*", else English. */
export function privacyPolicyUrl(uiLanguage: string): string {
  const japanese = /^ja(-|$)/i.test(uiLanguage);
  return `${PRIVACY_POLICY_DIR}${japanese ? "PRIVACY.ja.md" : "PRIVACY.md"}`;
}

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

/** `value` as a ControlView, or null when it is not one (a failed reply). */
export function parseControlView(value: unknown): ControlView | null {
  if (typeof value !== "object" || value === null) return null;
  const { consent, paused } = value as Record<string, unknown>;
  const isConsent = consent === "undecided" || consent === "granted" || consent === "denied";
  if (!isConsent || typeof paused !== "boolean") return null;

  return { consent, paused };
}

/**
 * Send a control message to the background (from a page: popup.ts,
 * consent.ts). The choices it answers with and whether it saved the change
 * (`saved` is true for GET, which changes nothing); null when the request
 * failed or the answer is not a ControlView.
 */
export async function requestControl(message: { type: string } & Record<string, unknown>): Promise<ControlReply | null> {
  try {
    const reply: unknown = await browser.runtime.sendMessage(message);
    const control = parseControlView(reply);
    if (control === null) return null;

    return { ...control, saved: (reply as Record<string, unknown>).saved !== false };
  } catch {
    return null;
  }
}
