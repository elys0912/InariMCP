// Types of the content script modules (types only).

export interface FindElementOptions {
  selector?: string;
  xpath?: string;
  text?: string;
  x?: number;
  y?: number;
  id?: string;
  name?: string;
  ariaLabel?: string;
  placeholder?: string;
  role?: string;
}

export interface ElementInfo {
  tag: string;
  id: string | null;
  classes: string[];
  name: string | null;
  type: string | null;
  text: string | null;
  value: string | null;
  href: string | null;
  src: string | null;
  placeholder: string | null;
  ariaLabel: string | null;
  role: string | null;
  disabled: boolean;
  checked: boolean;
  visible: boolean;
  position: {
    x: number;
    y: number;
    width: number;
    height: number;
    centerX: number;
    centerY: number;
  };
  selector: string;
}

export interface ClickOptions extends FindElementOptions {
  rightClick?: boolean;
  doubleClick?: boolean;
}

export interface TypeOptions extends FindElementOptions {
  text?: string;
  clear?: boolean;
  instant?: boolean;
  delay?: number;
  pressEnter?: boolean;
  submitForm?: boolean;
  focusFirst?: boolean;
  allowPassword?: boolean;
}

export type ScrollDirection = "up" | "down" | "left" | "right" | "top" | "bottom";

export interface ScrollOptions extends FindElementOptions {
  toElement?: string;
  direction?: ScrollDirection;
  amount?: number;
  smooth?: boolean;
  block?: ScrollLogicalPosition;
}

export interface HighlightOptions extends FindElementOptions {
  label?: string;
  duration?: number;
}

export interface WaitOptions extends FindElementOptions {
  timeout?: number;
  interval?: number;
  visible?: boolean;
}

/** waitForChange filter: "text" is characterData. */
export type ChangeType = "childList" | "attributes" | "text";

export interface WaitForChangeOptions {
  selector?: string;
  timeout?: number;
  changeType?: ChangeType;
  waitForAll?: boolean;
  subtree?: boolean;
  attributes?: boolean;
  characterData?: boolean;
  attributeOldValue?: boolean;
}

export interface NetworkIdleOptions {
  timeout?: number;
  idleTime?: number;
}

export interface ObserveOptions {
  selector: string;
  observerId?: string;
  /** fox_inject_observer switches (default true each). */
  observeAttributes?: boolean;
  observeChildList?: boolean;
  observeSubtree?: boolean;
}

export interface ScrollCaptureOptions {
  scrollStep?: number;
  delay?: number;
  maxScrolls?: number;
  restore?: boolean;
}

export interface ClickAndWaitOptions extends ClickOptions {
  waitTimeout?: number;
  waitForSelector?: string;
  waitForChange?: boolean;
}

export interface SetValueOptions extends FindElementOptions {
  value: string;
  allowPassword?: boolean;
}

export interface SelectOptionOptions extends FindElementOptions {
  value?: string;
  index?: number;
  text?: string;
}

export interface PressKeyOptions extends FindElementOptions {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
}

export interface TextOptions extends FindElementOptions {
  maxLength?: number;
}

export interface CaptchaOptions {
  detectOnly?: boolean;
  timeout?: number;
}

export interface LoggingOptions {
  clearExisting?: boolean;
  protectedPatterns?: unknown;
}

export interface ClearLogsOptions {
  console?: boolean;
  network?: boolean;
}

export interface GetElementsOptions {
  selector?: string;
  limit?: number;
}

export interface StopObservingOptions {
  observerId: string;
}

/**
 * The options each background → content action carries next to `action`
 * (one key per case of handler.ts handleMessage). `{}`: no options read.
 */
export interface ContentOptionsByAction {
  click: ClickOptions;
  type: TypeOptions;
  scroll: ScrollOptions;
  getPageInfo: {};
  getElements: GetElementsOptions;
  highlight: HighlightOptions;
  waitForElement: WaitOptions;
  waitForChange: WaitForChangeOptions;
  waitForNetworkIdle: NetworkIdleOptions;
  observeElement: ObserveOptions;
  stopObserving: StopObservingOptions;
  scrollAndCapture: ScrollCaptureOptions;
  clickAndWait: ClickAndWaitOptions;
  captureFullPage: {};
  inspectElement: {};
  getValue: FindElementOptions;
  setValue: SetValueOptions;
  hover: FindElementOptions;
  selectOption: SelectOptionOptions;
  pressKey: PressKeyOptions;
  getText: TextOptions;
  solveCaptcha: CaptchaOptions;
  cancelHumanWait: {};
  startLogging: LoggingOptions;
  stopLogging: {};
  flushLogs: {};
  clearLogs: ClearLogsOptions;
}

/** Action name of a background → content message. */
export type ContentAction = keyof ContentOptionsByAction;

/**
 * A background → content message as the background builds it: the action
 * and the command's data, not checked against the action's options.
 */
export interface ContentRequest {
  action: ContentAction;
  [key: string]: unknown;
}

/**
 * A background → content message as handleMessage reads it, narrowed by
 * `action`. The options are what the sender put there: content.ts takes a
 * runtime message as this type without checking it, and the handlers read
 * the options defensively.
 */
export type ContentMessage = {
  [A in ContentAction]: { action: A } & ContentOptionsByAction[A];
}[ContentAction];

export interface ConsoleLogEntry {
  level: string;
  timestamp: string;
  message: string;
  url: string;
}

export interface NetworkLogEntry {
  type: string;
  method: string;
  url: string;
  requestHeaders?: Record<string, string>;
  requestBody?: string | null;
  startTime: string;
  pageUrl: string;
  status?: number;
  statusText?: string;
  duration?: number;
  responseHeaders?: Record<string, string>;
  responseBody?: string;
  error?: string;
}

export interface CaptchaWidget {
  type: string;
  solved: boolean | null;
}

export interface ObserverRecord {
  observer: MutationObserver;
  changes: MutationChange[];
  target: string;
}

export interface MutationChange {
  type: string;
  timestamp: number;
  target: string;
  addedNodes: string[];
  removedNodes: string[];
  attributeName: string | null;
  oldValue: string | null;
}
