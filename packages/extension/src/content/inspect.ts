// Observation and display: page info, element lists, highlight, scroll
// snapshots, full-page dimensions, inspect element, values and text.

import { clipText } from "../text-clip";
import { DEFAULTS, HIGHLIGHT_STYLE, INTERACTIVE_SELECTORS, LIMITS, TIMEOUTS } from "./constants";
import {
  isPasswordField,
  isVisible,
  generateSelector,
  getElementInfo,
  findElement,
  sleep,
  generateXPath,
  notFoundError,
  isTextInput,
  isSelectElement,
  truncatedValue,
} from "./dom";
import type {
  ElementInfo,
  HighlightOptions,
  ScrollCaptureOptions,
  FindElementOptions,
  TextOptions,
} from "./types";

let highlightOverlay: HTMLDivElement | null = null;
/** Auto-removal timer of highlightOverlay (cleared with it). */
let highlightTimer: ReturnType<typeof setTimeout> | null = null;

export function getPageInfo(): Record<string, unknown> {
  const interactiveElements: Record<string, unknown>[] = [];

  const candidates = document.querySelectorAll(INTERACTIVE_SELECTORS.join(", "));
  for (let index = 0; index < candidates.length && index < LIMITS.PAGE_INFO_ELEMENTS; index++) {
    const el = candidates.item(index);
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      // Property reads only: on an element without them they are undefined (→ null below).
      const htmlEl = el as HTMLInputElement;
      interactiveElements.push({
        tag: el.tagName.toLowerCase(),
        type: htmlEl.type || null,
        id: el.id || null,
        name: htmlEl.name || null,
        text: clipText(el.textContent?.trim() ?? "", LIMITS.PAGE_INFO_TEXT) || null,
        href: (el as HTMLAnchorElement).href || null,
        value: isPasswordField(el) ? "[MASKED]" : truncatedValue(htmlEl.value, LIMITS.PAGE_INFO_TEXT),
        placeholder: htmlEl.placeholder || null,
        ariaLabel: el.getAttribute("aria-label"),
        position: {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
          width: rect.width,
          height: rect.height,
        },
        visible: isVisible(el),
        selector: generateSelector(el),
      });
    }
  }

  return {
    url: window.location.href,
    title: document.title,
    documentHeight: document.documentElement.scrollHeight,
    documentWidth: document.documentElement.scrollWidth,
    viewportHeight: window.innerHeight,
    viewportWidth: window.innerWidth,
    scrollPosition: { x: window.scrollX, y: window.scrollY },
    interactiveElements,
    forms: Array.from(document.forms).map((form) => ({
      id: form.id,
      name: form.name,
      action: form.action,
      method: form.method,
      fields: Array.from(form.elements)
        .slice(0, LIMITS.FORM_FIELDS)
        .map((el) => {
          // A form control of any kind: property reads only, undefined where absent.
          const inp = el as HTMLInputElement;
          return {
            tag: el.tagName.toLowerCase(),
            type: inp.type,
            name: inp.name,
            id: el.id,
            placeholder: inp.placeholder,
            required: inp.required,
            value: isPasswordField(el) ? "[MASKED]" : truncatedValue(inp.value, LIMITS.FORM_FIELD_VALUE),
          };
        }),
    })),
    headings: Array.from(document.querySelectorAll("h1, h2, h3"))
      .slice(0, LIMITS.HEADINGS)
      .map((h) => ({
        level: parseInt(h.tagName[1]),
        text: clipText(h.textContent?.trim() ?? "", LIMITS.HEADING_TEXT),
      })),
  };
}

export function getElements(options: {
  selector?: string;
  limit?: number;
}): Record<string, unknown> {
  const elements: ElementInfo[] = [];
  const selector = options.selector || "*";
  const limit = options.limit || DEFAULTS.ELEMENTS_LIMIT;

  // One evaluation of the selector, read up to `limit` (the NodeList is static).
  const matches = document.querySelectorAll(selector);
  for (let index = 0; index < matches.length && index < limit; index++) {
    elements.push(getElementInfo(matches.item(index)));
  }

  return {
    elements,
    count: matches.length,
  };
}

function removeHighlight(): void {
  // The timer belongs to the overlay being removed; left running, it would
  // remove the next highlight early.
  if (highlightTimer !== null) {
    clearTimeout(highlightTimer);
    highlightTimer = null;
  }
  if (highlightOverlay) {
    highlightOverlay.remove();
    highlightOverlay = null;
  }
}

export function highlightElement(
  options: HighlightOptions,
): Record<string, unknown> {
  removeHighlight();

  const element = findElement(options);
  if (!element) {
    throw new Error("Element not found");
  }

  const rect = element.getBoundingClientRect();

  highlightOverlay = document.createElement("div");
  highlightOverlay.className = "kitsune-highlight-overlay";
  highlightOverlay.style.cssText = `
      position: fixed;
      left: ${rect.left}px;
      top: ${rect.top}px;
      width: ${rect.width}px;
      height: ${rect.height}px;
      border: 3px solid ${HIGHLIGHT_STYLE.COLOR};
      background: ${HIGHLIGHT_STYLE.FILL};
      pointer-events: none;
      z-index: ${HIGHLIGHT_STYLE.Z_INDEX};
      box-shadow: 0 0 10px ${HIGHLIGHT_STYLE.GLOW};
      transition: all 0.3s ease;
    `;

  const label = document.createElement("div");
  label.style.cssText = `
      position: absolute;
      top: -25px;
      left: 0;
      background: ${HIGHLIGHT_STYLE.COLOR};
      color: white;
      padding: 2px 8px;
      font-size: 12px;
      font-family: monospace;
      border-radius: 3px;
      white-space: nowrap;
    `;
  label.textContent = options.label || generateSelector(element);
  highlightOverlay.appendChild(label);

  document.body.appendChild(highlightOverlay);

  if (options.duration !== 0) {
    highlightTimer = setTimeout(removeHighlight, options.duration || TIMEOUTS.HIGHLIGHT);
  }

  return { highlighted: true, element: getElementInfo(element) };
}

function getVisibleInteractiveElements(): Record<string, unknown>[] {
  // The first LIMITS.SNAPSHOT_ELEMENTS visible ones, in document order: stop once there are that many.
  const elements: Record<string, unknown>[] = [];
  const candidates = document.querySelectorAll(INTERACTIVE_SELECTORS.join(", "));
  for (let index = 0; index < candidates.length && elements.length < LIMITS.SNAPSHOT_ELEMENTS; index++) {
    const el = candidates.item(index);
    const rect = el.getBoundingClientRect();
    if (
      rect.top < window.innerHeight &&
      rect.bottom > 0 &&
      rect.left < window.innerWidth &&
      rect.right > 0 &&
      rect.width > 0 &&
      rect.height > 0 &&
      isVisible(el)
    ) {
      elements.push({
        tag: el.tagName.toLowerCase(),
        text: clipText(el.textContent?.trim() ?? "", LIMITS.SNAPSHOT_TEXT) || null,
        selector: generateSelector(el),
        position: {
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
        },
      });
    }
  }

  return elements;
}

export async function scrollAndCapture(
  options: ScrollCaptureOptions,
): Promise<Record<string, unknown>> {
  const scrollStep =
    options.scrollStep || window.innerHeight * DEFAULTS.SCROLL_CAPTURE_STEP_RATIO;
  const delay = options.delay || TIMEOUTS.SCROLL_STEP;
  const maxScrolls = options.maxScrolls || DEFAULTS.SCROLL_CAPTURE_MAX_SCROLLS;

  const snapshots: Record<string, unknown>[] = [];
  const originalScroll = window.scrollY;
  let scrollCount = 0;

  window.scrollTo({ top: 0, behavior: "instant" });
  await sleep(delay);

  while (scrollCount < maxScrolls) {
    snapshots.push({
      scrollY: window.scrollY,
      viewportHeight: window.innerHeight,
      documentHeight: document.documentElement.scrollHeight,
      visibleElements: getVisibleInteractiveElements(),
      timestamp: Date.now(),
    });

    if (
      window.scrollY + window.innerHeight >=
      document.documentElement.scrollHeight - LIMITS.SCROLL_END_SLACK
    ) {
      break;
    }

    window.scrollBy({ top: scrollStep, behavior: "smooth" });
    await sleep(delay);
    scrollCount++;
  }

  if (options.restore !== false) {
    window.scrollTo({
      top: originalScroll,
      behavior: "instant",
    });
  }

  return {
    completed: true,
    snapshots,
    totalScrolls: scrollCount,
    documentHeight: document.documentElement.scrollHeight,
    message:
      "Element positions only, no images: scroll with fox_interact (action scroll) and take " +
      "fox_screenshot (scope viewport) at each position for images",
  };
}

export function captureFullPage(): Record<string, unknown> {
  return {
    scrollHeight: document.documentElement.scrollHeight,
    scrollWidth: document.documentElement.scrollWidth,
    viewportHeight: window.innerHeight,
    viewportWidth: window.innerWidth,
  };
}

/** Target of the last contextmenu event in this frame (see rememberContextTarget). */
let lastContextTarget: Element | null = null;

/**
 * contextmenu listener (registered by content.ts): remember the element the
 * menu was opened on. Firefox's contextMenus OnClickData has no pageX /
 * pageY, so the "inspect element" entry uses this element instead of a
 * point. event.target is retargeted to the shadow host, which a selector
 * can reach.
 */
export function rememberContextTarget(event: { target: EventTarget | null }): void {
  // Checked by nodeType below (a page element is not `instanceof Element` in this sandbox).
  const target = event.target as Element | null;
  lastContextTarget = target && target.nodeType === 1 ? target : null;
}

/** The remembered element while it is still in the document. */
export function contextTarget(): Element | null {
  return lastContextTarget && lastContextTarget.isConnected ? lastContextTarget : null;
}

export function inspectElement(): Record<string, unknown> {
  const element = contextTarget();
  if (!element) {
    return { found: false };
  }

  highlightElement({
    selector: generateSelector(element),
    duration: TIMEOUTS.INSPECT_HIGHLIGHT,
  });

  return {
    found: true,
    element: getElementInfo(element),
    selector: generateSelector(element),
    xpath: generateXPath(element),
  };
}

export function getValue(
  options: FindElementOptions,
): Record<string, unknown> {
  const element = findElement(options);
  if (!element) throw notFoundError(options);

  let value: string | null;

  if (isPasswordField(element)) {
    value = "[MASKED]";
  } else if (isTextInput(element)) {
    value = element.value;
  } else if (isSelectElement(element)) {
    value = element.options[element.selectedIndex]?.value ?? null;
  } else {
    value = element.textContent;
  }

  return { value, element: getElementInfo(element) };
}

export function getText(
  options: TextOptions,
): Record<string, unknown> {
  let element: Element = document.body;
  if (options.selector) {
    const found = findElement(options);
    if (!found) throw new Error("Element not found");
    element = found;
  }

  const maxLength = options.maxLength || DEFAULTS.TEXT_MAX_LENGTH;
  const text =
    (element as HTMLElement).innerText || element.textContent || "";

  return {
    text: clipText(text, maxLength),
    truncated: text.length > maxLength,
    totalLength: text.length,
    url: window.location.href,
    title: document.title,
  };
}
