// Message dispatch of the content script: one command from the background
// to its handler.

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
  getText,
} from "./inspect";
import { cancelHumanWait } from "./overlay";
import type { ContentMessage } from "./types";
import { waitForElement, waitForNetworkIdle } from "./wait";

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
    case "waitForNetworkIdle":
      return waitForNetworkIdle(message);
    case "scrollAndCapture":
      return scrollAndCapture(message);
    case "captureFullPage":
      return captureFullPage();
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
