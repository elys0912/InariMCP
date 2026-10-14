// Message dispatch of the content script: one message from the background
// (content.ts), either the abort of the running commands (the pause switch)
// or one command to its handler -- not one sent before the latest pause, an
// acting one only while the page is still on the origin it was approved on,
// and a reading one only with CSS selectors that cannot test a masked value.

import { assertReadSelector } from "@inari-mcp/shared/field-mask";
import { approvalOriginOf } from "../site-origin";
import { ABORTED_MESSAGE, abortRunningCommands, beginCommand, isSentBeforeAbort } from "./abort";
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
  getText,
  hasMaskedFields,
} from "./inspect";
import { cancelHumanWait } from "./overlay";
import type { ContentAction, ContentEnvelope, ContentMessage, ContentOptionsByAction } from "./types";
import { waitForElement, waitForNetworkIdle } from "./wait";

/**
 * The locator fields of the commands that run without a human approval
 * (reads, waits, scroll, highlight): CSS selectors only, checked here once
 * for all of them (shared/src/field-mask.ts readSelectorProblem) before any
 * handler uses them. A new such command gets a row here.
 */
const READ_LOCATOR_FIELDS: Partial<Record<ContentAction, readonly string[]>> = {
  getElements: ["selector"],
  getText: ["selector"],
  highlight: ["selector"],
  scroll: ["selector", "toElement"],
  waitForElement: ["selector"],
};

/**
 * The other ways to find an element (types.ts FindElementOptions). The
 * selector check cannot look into them -- an XPath such as
 * `//input[starts-with(@value,'a')]` tests a value too -- so a reading
 * command that carries one is refused. The MCP Server's schemas of these
 * commands have none of them.
 */
const NON_SELECTOR_LOCATORS: readonly string[] = ["xpath", "text", "x", "y", "id", "name", "ariaLabel", "placeholder", "role"];

function fieldValue(message: ContentMessage, field: string): unknown {
  return Object.getOwnPropertyDescriptor(message, field)?.value;
}

/**
 * Refuse a reading command that finds its element by anything but a CSS
 * selector, or whose selector could test a masked value.
 */
function assertReadLocators(message: ContentMessage): void {
  const fields = Object.hasOwn(READ_LOCATOR_FIELDS, message.action) ? READ_LOCATOR_FIELDS[message.action] : undefined;
  if (fields === undefined) return;

  const other = NON_SELECTOR_LOCATORS.find((field) => !fields.includes(field) && fieldValue(message, field) !== undefined);
  if (other !== undefined) {
    throw new Error(`Locator refused: ${message.action} finds its element by CSS selector only (got ${other})`);
  }
  for (const field of fields) {
    const selector = fieldValue(message, field);
    if (typeof selector === "string") assertReadSelector(selector);
  }
}

/** The background's abort of the running commands (its pause count), or null for any other message. */
function abortRequestOf(request: unknown): { pauseCount?: unknown } | null {
  if (typeof request !== "object" || request === null) return null;
  const message = request as { type?: unknown; pauseCount?: unknown };

  return message.type === ABORT_REQUEST_TYPE ? message : null;
}

/**
 * Stop the commands running in this frame: their next step ends them
 * (abort.ts), and the captcha wait ends like a cancel_human_wait, so a late
 * click cannot look like an answer.
 */
function abortCommands(pauseCount: unknown): Record<string, unknown> {
  abortRunningCommands(pauseCount);
  cancelHumanWait();

  return { success: true, aborted: true };
}

/**
 * A command the background sent before the latest pause, arriving after its
 * abort (the background has answered the MCP Server with "paused" already):
 * refused before it starts.
 */
function refuseSentBeforeAbort(pauseCount: unknown): Record<string, unknown> | null {
  if (!isSentBeforeAbort(pauseCount)) return null;

  return { success: false, safetyDecision: "paused", error: ABORTED_MESSAGE };
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
  const abort = abortRequestOf(request);
  if (abort !== null) return abortCommands(abort.pauseCount);
  const message = request as ContentMessage & ContentEnvelope;
  const refusal = refuseSentBeforeAbort(message.pauseCount) ?? refuseOffOrigin(message.approvedOrigin);
  if (refusal) return refusal;
  assertReadLocators(message);

  beginCommand();
  return handleMessage(message);
}

type ContentResult = Record<string, unknown> | Promise<Record<string, unknown>>;

/** The handler of each background → content action (a key per ContentAction, checked by the type). */
const CONTENT_HANDLERS: { [A in ContentAction]: (options: ContentOptionsByAction[A]) => ContentResult } = {
  click: performClick,
  type: performType,
  scroll: performScroll,
  getPageInfo,
  getElements,
  highlight: highlightElement,
  waitForElement,
  waitForNetworkIdle,
  scrollAndCapture,
  captureFullPage,
  setValue,
  hover: hoverElement,
  selectOption,
  pressKey,
  getText,
  hasMaskedFields,
  solveCaptcha,
  cancelHumanWait,
};

/**
 * Run the command's handler. A message whose action is not a ContentAction
 * (content.ts takes any runtime message as a request) is refused.
 */
async function handleMessage(message: ContentMessage): Promise<Record<string, unknown>> {
  const action: unknown = message.action;
  if (typeof action !== "string" || !Object.hasOwn(CONTENT_HANDLERS, action)) {
    throw new Error(`Unknown action: ${String(action)}`);
  }

  // The lookup loses the pairing of the action and its options: the handler
  // of message.action gets the options sent with it.
  const handler = CONTENT_HANDLERS[message.action] as (options: ContentMessage) => ContentResult;
  return handler(message);
}
