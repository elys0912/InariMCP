// The user's consent and pause switch (L0): held in memory, saved in
// storage.local. background.ts loads them at startup (loadControlState) and
// reacts to each change through the hook it sets (setControlHook). The
// memory copy changes before the write, so a pause takes effect at once even
// while storage is still being written.

import type { ConsentState, ControlView } from "../user-control";

/** storage.local keys. */
const STORAGE_KEY = {
  CONSENT: "consent",
  PAUSED: "paused",
} as const;

let consent: ConsentState = "undecided";
let paused = false;

/**
 * Aborted when agent actions are paused, so the commands still running are
 * answered at once (dispatch.ts). A fresh one replaces it for the commands
 * that come after.
 */
let pauseController = new AbortController();

/** Which of the two choices a change was about. */
export type ControlChange = "consent" | "paused";

let onChange: (view: ControlView, change: ControlChange) => void = () => {};

export function setControlHook(hook: (view: ControlView, change: ControlChange) => void): void {
  onChange = hook;
}

export function controlView(): ControlView {
  return { consent, paused };
}

export function isConsentGranted(): boolean {
  return consent === "granted";
}

export function isPaused(): boolean {
  return paused;
}

/** Aborted by the next pause (setPaused(true)). */
export function pauseSignal(): AbortSignal {
  return pauseController.signal;
}

/**
 * Read the saved choices. A failed read leaves the defaults (undecided, not
 * paused): without consent nothing connects, which is the safe side.
 */
export async function loadControlState(): Promise<ControlView> {
  try {
    const stored = await browser.storage.local.get([STORAGE_KEY.CONSENT, STORAGE_KEY.PAUSED]);
    const savedConsent = stored[STORAGE_KEY.CONSENT];
    consent = savedConsent === "granted" || savedConsent === "denied" ? savedConsent : "undecided";
    paused = stored[STORAGE_KEY.PAUSED] === true;
  } catch (error) {
    console.error("[InariMCP] Could not read the consent and pause state:", error);
  }

  return controlView();
}

/**
 * Write one choice. A failed write is only logged: the choice is in effect
 * already, and the page must show it as it is (not as it was).
 */
async function save(items: Record<string, unknown>): Promise<void> {
  try {
    await browser.storage.local.set(items);
  } catch (error) {
    console.error("[InariMCP] Could not save the consent and pause state:", error);
  }
}

/** The consent page: the user pressed Allow (true) or Don't allow (false). */
export async function setConsent(granted: boolean): Promise<ControlView> {
  consent = granted ? "granted" : "denied";
  onChange(controlView(), "consent");
  await save({ [STORAGE_KEY.CONSENT]: consent });

  return controlView();
}

/** The popup's pause switch. */
export async function setPaused(next: boolean): Promise<ControlView> {
  paused = next;
  if (next) {
    pauseController.abort();
    pauseController = new AbortController();
  }
  onChange(controlView(), "paused");
  await save({ [STORAGE_KEY.PAUSED]: paused });

  return controlView();
}
