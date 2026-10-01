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
  inspectElement,
  getValue,
  getText,
} from "./inspect";
import { startLogging, stopLogging, flushLogs, clearLogs } from "./log-store";
import { cancelHumanWait } from "./overlay";
import type {
  ContentMessage,
  ClickOptions,
  TypeOptions,
  ScrollOptions,
  HighlightOptions,
  WaitOptions,
  WaitForChangeOptions,
  NetworkIdleOptions,
  ObserveOptions,
  ScrollCaptureOptions,
  ClickAndWaitOptions,
  FindElementOptions,
  SetValueOptions,
  SelectOptionOptions,
  PressKeyOptions,
  TextOptions,
  CaptchaOptions,
  LoggingOptions,
  ClearLogsOptions,
} from "./types";
import {
  waitForElement,
  waitForChange,
  waitForNetworkIdle,
  observeElement,
  stopObserving,
  clickAndWait,
} from "./wait";

export async function handleMessage(
  message: ContentMessage,
): Promise<Record<string, unknown>> {
  switch (message.action) {
    case "click":
      return performClick(message as unknown as ClickOptions);
    case "type":
      return performType(message as unknown as TypeOptions);
    case "scroll":
      return performScroll(message as unknown as ScrollOptions);
    case "getPageInfo":
      return getPageInfo();
    case "getElements":
      return getElements(message as unknown as { selector?: string; limit?: number });
    case "highlight":
      return highlightElement(message as unknown as HighlightOptions);
    case "waitForElement":
      return waitForElement(message as unknown as WaitOptions);
    case "waitForChange":
      return waitForChange(message as unknown as WaitForChangeOptions);
    case "waitForNetworkIdle":
      return waitForNetworkIdle(message as unknown as NetworkIdleOptions);
    case "observeElement":
      return observeElement(message as unknown as ObserveOptions);
    case "stopObserving":
      return stopObserving(message as unknown as { observerId: string });
    case "scrollAndCapture":
      return scrollAndCapture(message as unknown as ScrollCaptureOptions);
    case "clickAndWait":
      return clickAndWait(message as unknown as ClickAndWaitOptions);
    case "captureFullPage":
      return captureFullPage();
    case "inspectElement":
      return inspectElement();
    case "getValue":
      return getValue(message as unknown as FindElementOptions);
    case "setValue":
      return setValue(message as unknown as SetValueOptions);
    case "hover":
      return hoverElement(message as unknown as FindElementOptions);
    case "selectOption":
      return selectOption(message as unknown as SelectOptionOptions);
    case "pressKey":
      return pressKey(message as unknown as PressKeyOptions);
    case "getText":
      return getText(message as unknown as TextOptions);
    case "solveCaptcha":
      return solveCaptcha(message as unknown as CaptchaOptions);
    case "cancelHumanWait":
      return cancelHumanWait();
    case "startLogging":
      return startLogging(message as unknown as LoggingOptions);
    case "stopLogging":
      return stopLogging();
    case "flushLogs":
      return flushLogs();
    case "clearLogs":
      return clearLogs(message as unknown as ClearLogsOptions);
    default:
      throw new Error(`Unknown action: ${message.action}`);
  }
}
