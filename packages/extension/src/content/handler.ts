// Message dispatch of the content script: one message from the background
// (content.ts), either the abort of the running commands (the pause switch)
// or one command to its handler -- an acting one only while the page is still
// on the origin it was approved on.

import { approvalOriginOf } from "../site-origin";
import { abortRunningCommands, beginCommand } from "./abort";
import { solveCaptcha } from "./captcha";
import { ABORT_REQUEST_TYPE } from "./constants";
import {
  performClick,
  performType,
  performScroll,
  setValue,
  hoverElement,
  selectOption,
  pressKey,
} from "./input";
import {
  getPageInfo,
  getElements,
  highlightElement,
  scrollAndCapture,
  captureFullPage,
  getValue,
  getText,
} from "./inspect";
import { cancelHumanWait } from "./overlay";
import type { ContentEnvelope, ContentMessage } from "./types";
import {
  waitForElement,
  waitForChange,
  waitForNetworkIdle,
  clickAndWait,
} from "./wait";

/** Whether `request` is the background's abort of the running commands. */
function isAbortRequest(request: unknown): boolean {
  return typeof request === "object" && request !== null && (request as { type?: unknown }).type === ABORT_REQUEST_TYPE;
}

/**
 * Stop the commands running in this frame: their next step ends them
 * (abort.ts), and the captcha wait ends like a cancel_human_wait, so a late
 * click cannot look like an answer.
 */
function abortCommands(): Record<string, unknown> {
  abortRunningCommands();
  cancelHumanWait();

  return { success: true, aborted: true };
}

/**
 * An acting command carries the origin it was approved on (the background's
 * check of the tab's URL, background/dispatch.ts). The tab may have gone to
 * another page since: the command is then refused here, just before it would
 * act, with the page's URL, so that the MCP Server can ask the human about it.
 */
function refuseOffOrigin(approvedOrigin: unknown): Record<string, unknown> | null {
  if (approvedOrigin === undefined) return null;
  const url = window.location.href;
  if (typeof approvedOrigin === "string" && approvalOriginOf(url) === approvedOrigin) return null;

  return {
    success: false,
    safetyDecision: "confirmation_required",
    error: "Human approval required: the tab left the approved site before the command ran",
    url,
  };
}

/**
 * One runtime message from the background. content.ts takes any message as
 * a request; a command's options are read defensively by its handler.
 */
export async function handleRequest(request: unknown): Promise<Record<string, unknown>> {
  if (isAbortRequest(request)) return abortCommands();
  const message = request as ContentMessage & ContentEnvelope;
  const refusal = refuseOffOrigin(message.approvedOrigin);
  if (refusal) return refusal;

  beginCommand();
  return handleMessage(message);
}

export async function handleMessage(
  message: ContentMessage,
): Promise<Record<string, unknown>> {
  switch (message.action) {
    case "click":
      return performClick(message);
    case "type":
      return performType(message);
    case "scroll":
      return performScroll(message);
    case "getPageInfo":
      return getPageInfo();
    case "getElements":
      return getElements(message);
    case "highlight":
      return highlightElement(message);
    case "waitForElement":
      return waitForElement(message);
    case "waitForChange":
      return waitForChange(message);
    case "waitForNetworkIdle":
      return waitForNetworkIdle(message);
    case "scrollAndCapture":
      return scrollAndCapture(message);
    case "clickAndWait":
      return clickAndWait(message);
    case "captureFullPage":
      return captureFullPage();
    case "getValue":
      return getValue(message);
    case "setValue":
      return setValue(message);
    case "hover":
      return hoverElement(message);
    case "selectOption":
      return selectOption(message);
    case "pressKey":
      return pressKey(message);
    case "getText":
      return getText(message);
    case "solveCaptcha":
      return solveCaptcha(message);
    case "cancelHumanWait":
      return cancelHumanWait();
    default: {
      // Reached by a message whose action is not a ContentAction (content.ts
      // takes any runtime message as a ContentMessage).
      const unhandled: never = message;
      throw new Error(`Unknown action: ${String((unhandled as { action: unknown }).action)}`);
    }
  }
}
