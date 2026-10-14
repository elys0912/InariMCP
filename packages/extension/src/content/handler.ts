// Message dispatch of the content script: one command from the background
// to its handler.

import { assertReadSelector } from "@inari-mcp/shared/field-mask";
import { solveCaptcha } from "./captcha";
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
import type { ContentAction, ContentMessage } from "./types";
import {
  waitForElement,
  waitForChange,
  waitForNetworkIdle,
  clickAndWait,
} from "./wait";

/**
 * The CSS selector fields of the commands that run without a human
 * approval (reads, waits, scroll, highlight), checked here once for all of
 * them (shared/src/field-mask.ts readSelectorProblem) before any handler
 * uses them. A new such command gets a row here.
 */
const READ_SELECTOR_FIELDS: Partial<Record<ContentAction, readonly string[]>> = {
  getElements: ["selector"],
  getText: ["selector"],
  getValue: ["selector"],
  highlight: ["selector"],
  scroll: ["selector", "toElement"],
  waitForElement: ["selector"],
  waitForChange: ["selector"],
};

/** Refuse a reading command whose selector could test a masked value. */
function assertReadSelectors(message: ContentMessage): void {
  for (const field of READ_SELECTOR_FIELDS[message.action] ?? []) {
    const selector: unknown = Object.getOwnPropertyDescriptor(message, field)?.value;
    if (typeof selector === "string") assertReadSelector(selector);
  }
}

/**
 * One command from the background (content.ts): its read selectors checked,
 * then handleMessage.
 */
export async function runContentCommand(message: ContentMessage): Promise<Record<string, unknown>> {
  assertReadSelectors(message);
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
