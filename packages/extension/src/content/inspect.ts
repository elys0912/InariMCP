// Observation and display: page info, element lists, highlight, scroll
// snapshots, full-page dimensions, inspect element, values and text.

import { INTERACTIVE_SELECTORS, TIMEOUTS } from "./constants";
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

  document.querySelectorAll(INTERACTIVE_SELECTORS.join(", ")).forEach((el, index) => {
    if (index < 100) {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        const htmlEl = el as HTMLInputElement;
        interactiveElements.push({
          tag: el.tagName.toLowerCase(),
          type: htmlEl.type || null,
          id: el.id || null,
          name: htmlEl.name || null,
          text: el.textContent?.trim().substring(0, 100) || null,
          href: (el as HTMLAnchorElement).href || null,
          value: isPasswordField(el)
            ? "[MASKED]"
            : (htmlEl.value?.substring(0, 100) ?? null),
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
  });

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
        .slice(0, 20)
        .map((el) => {
          const inp = el as HTMLInputElement;
          return {
            tag: el.tagName.toLowerCase(),
            type: inp.type,
            name: inp.name,
            id: el.id,
            placeholder: inp.placeholder,
            required: inp.required,
            value:
              inp.type === "password"
                ? "[MASKED]"
                : (inp.value?.substring(0, 50) ?? null),
          };
        }),
    })),
    headings: Array.from(document.querySelectorAll("h1, h2, h3"))
      .slice(0, 20)
      .map((h) => ({
        level: parseInt(h.tagName[1]),
        text: h.textContent?.trim().substring(0, 100),
      })),
  };
}

export function getElements(options: {
  selector?: string;
  limit?: number;
}): Record<string, unknown> {
  const elements: ElementInfo[] = [];
  const selector = options.selector || "*";
  const limit = options.limit || 50;

  document.querySelectorAll(selector).forEach((el, index) => {
    if (index < limit) {
      elements.push(getElementInfo(el));
    }
  });

  return {
    elements,
    count: document.querySelectorAll(selector).length,
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
      border: 3px solid #7c3aed;
      background: rgba(124, 58, 237, 0.1);
      pointer-events: none;
      z-index: 999999;
      box-shadow: 0 0 10px rgba(124, 58, 237, 0.5);
      transition: all 0.3s ease;
    `;

  const label = document.createElement("div");
  label.style.cssText = `
      position: absolute;
      top: -25px;
      left: 0;
      background: #7c3aed;
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
    highlightTimer = setTimeout(removeHighlight, options.duration || 3000);
  }

  return { highlighted: true, element: getElementInfo(element) };
}

function getVisibleInteractiveElements(): Record<string, unknown>[] {
  const elements: Record<string, unknown>[] = [];
  document.querySelectorAll(INTERACTIVE_SELECTORS.join(", ")).forEach((el) => {
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
        text: el.textContent?.trim().substring(0, 50) || null,
        selector: generateSelector(el),
        position: {
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
        },
      });
    }
  });

  return elements.slice(0, 50);
}

export async function scrollAndCapture(
  options: ScrollCaptureOptions,
): Promise<Record<string, unknown>> {
  const scrollStep =
    options.scrollStep || window.innerHeight * 0.8;
  const delay = options.delay || TIMEOUTS.SCROLL_STEP;
  const maxScrolls = options.maxScrolls || 20;

  const snapshots: Record<string, unknown>[] = [];
  const originalScroll = window.scrollY;
  let scrollCount = 0;

  window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
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
      document.documentElement.scrollHeight - 10
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
      behavior: "instant" as ScrollBehavior,
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
    duration: 5000,
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
    value = (element as HTMLInputElement).value;
  } else if (element.tagName === "SELECT") {
    const sel = element as HTMLSelectElement;
    value = sel.options[sel.selectedIndex]?.value ?? null;
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

  const maxLength = options.maxLength || 20000;
  const text =
    (element as HTMLElement).innerText || element.textContent || "";

  return {
    text: text.slice(0, maxLength),
    truncated: text.length > maxLength,
    totalLength: text.length,
    url: window.location.href,
    title: document.title,
  };
}
