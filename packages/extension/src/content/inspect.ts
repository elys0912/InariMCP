// Observation and display: page info, element lists, highlight, scroll
// snapshots, full-page dimensions and text.

import { maskedText } from "@inari-mcp/shared/field-mask";
import { clipText } from "../text-clip";
import { DEFAULTS, HIGHLIGHT_STYLE, INTERACTIVE_SELECTORS, LIMITS, TIMEOUTS } from "./constants";
import {
  isInputElement,
  isMaskedField,
  isVisible,
  generateSelector,
  getElementInfo,
  getElementLocation,
  findElement,
  sleep,
  shownText,
  shownValue,
} from "./dom";
import type {
  ElementInfo,
  HighlightOptions,
  ScrollCaptureOptions,
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
        text: shownText(el, LIMITS.PAGE_INFO_TEXT),
        href: (el as HTMLAnchorElement).href || null,
        value: shownValue(el, htmlEl.value, LIMITS.PAGE_INFO_TEXT),
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
            value: shownValue(el, inp.value, LIMITS.FORM_FIELD_VALUE),
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

/** The overlay's glow grows and shrinks until the overlay is removed. */
function pulseGlow(overlay: HTMLElement): void {
  const S = HIGHLIGHT_STYLE;
  const glow = (blur: number, color: string) => ({ boxShadow: `0 0 ${blur}px ${color}` });
  overlay.animate(
    [glow(S.GLOW_BLUR, S.GLOW), glow(S.GLOW_PEAK_BLUR, S.GLOW_PEAK), glow(S.GLOW_BLUR, S.GLOW)],
    { duration: S.PULSE_MS, easing: "ease-in-out", iterations: Infinity },
  );
}

/**
 * fox_interact highlight. UI only and no read (no confirm_read_sites
 * check): it returns where the element is, not its content.
 */
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
      box-shadow: 0 0 ${HIGHLIGHT_STYLE.GLOW_BLUR}px ${HIGHLIGHT_STYLE.GLOW};
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
  pulseGlow(highlightOverlay);

  if (options.duration !== 0) {
    highlightTimer = setTimeout(removeHighlight, options.duration || TIMEOUTS.HIGHLIGHT);
  }

  return { highlighted: true, element: getElementLocation(element) };
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
        text: shownText(el, LIMITS.SNAPSHOT_TEXT),
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

/**
 * The delay and the step count of scroll_and_capture: the requested ones
 * (else the defaults), cut to LIMITS.SCROLL_CAPTURE_MAX_DELAY and
 * LIMITS.SCROLL_CAPTURE_MAX_SCROLLS, and to the steps whose delays, with the
 * first one before the first step, fit in TIMEOUTS.SCROLL_CAPTURE_BUDGET,
 * whatever the command asks for. 500 ms (the default): 49 steps.
 */
export function scrollCaptureLimits(options: ScrollCaptureOptions): { delay: number; maxScrolls: number } {
  const delay = Math.min(options.delay || TIMEOUTS.SCROLL_STEP, LIMITS.SCROLL_CAPTURE_MAX_DELAY);
  const requestedScrolls = options.maxScrolls || DEFAULTS.SCROLL_CAPTURE_SCROLLS;
  const maxScrolls = Math.min(
    requestedScrolls,
    LIMITS.SCROLL_CAPTURE_MAX_SCROLLS,
    Math.floor(TIMEOUTS.SCROLL_CAPTURE_BUDGET / delay) - 1,
  );

  return { delay, maxScrolls };
}

/**
 * Scroll the page step by step from the top and list the interactive
 * elements visible at each position (no images). Each step waits in sleep(),
 * so the pause switch stops it at the next step (abort.ts).
 */
export async function scrollAndCapture(
  options: ScrollCaptureOptions,
): Promise<Record<string, unknown>> {
  const scrollStep =
    options.scrollStep || window.innerHeight * DEFAULTS.SCROLL_CAPTURE_STEP_RATIO;
  const { delay, maxScrolls } = scrollCaptureLimits(options);

  const snapshots: Record<string, unknown>[] = [];
  const originalScroll = window.scrollY;
  let scrollCount = 0;

  try {
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
  } finally {
    // Also when the pause stops it (sleep throws): the page goes back.
    if (options.restore !== false) {
      window.scrollTo({
        top: originalScroll,
        behavior: "instant",
      });
    }
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

/**
 * Whether the page shows a field whose value is masked (dom.ts
 * isMaskedField), asked by find_text before it searches the tab
 * (background/tabs.ts findText): Firefox's find may match the text in a
 * form field too, and its match count would then tell a masked value one
 * guess at a time. A hidden input is left out: it is not shown, so find
 * cannot match it.
 */
export function hasMaskedFields(): Record<string, unknown> {
  const fields = Array.from(document.querySelectorAll("input, textarea, select"));
  const shownMasked = fields.some(
    (field) => isMaskedField(field) && !(isInputElement(field) && field.type.toLowerCase() === "hidden"),
  );

  return { hasMaskedFields: shownMasked };
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
  const rawText = (element as HTMLElement).innerText || element.textContent || "";
  // A masked field read as itself (an option of a masked select, a masked textarea).
  const text = maskedText(rawText, isMaskedField(element));

  return {
    text: clipText(text, maxLength),
    truncated: text.length > maxLength,
    totalLength: text.length,
    url: window.location.href,
    title: document.title,
  };
}
