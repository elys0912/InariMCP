// DOM helpers: element location, locators, selectors / XPath, element info,
// the masked-value rule and the password field guard.

import {
  isMaskedField as isMaskedFieldInfo,
  MASKED_VALUE,
  maskedText,
  type MaskFieldInfo,
} from "@inari-mcp/shared/field-mask";
import { clipText } from "../text-clip";
import { LIMITS } from "./constants";
import type { FindElementOptions, ElementInfo, ElementLocation, ElementPosition } from "./types";

/**
 * An element's `value` as a truncated string. `value` is a string on form
 * fields and a number on e.g. <li> / <progress>; anything else (none, or an
 * object) is null.
 */
export function truncatedValue(value: unknown, max: number): string | null {
  if (typeof value === "string") return clipText(value, max);
  if (typeof value === "number" || typeof value === "boolean") return clipText(String(value), max);
  return null;
}

// Element kinds by localName, not instanceof (elements of another realm,
// e.g. an iframe, fail instanceof) nor tagName (lower case in XHTML
// documents, so an upper-case comparison misses them there).
export function isTextInput(el: Element): el is HTMLInputElement | HTMLTextAreaElement {
  return el.localName === "input" || el.localName === "textarea";
}

export function isInputElement(el: Element): el is HTMLInputElement {
  return el.localName === "input";
}

export function isButtonElement(el: Element): el is HTMLButtonElement {
  return el.localName === "button";
}

export function isSelectElement(el: Element): el is HTMLSelectElement {
  return el.localName === "select";
}

/** autocomplete tokens that mark a password field. */
const PASSWORD_AUTOCOMPLETE_TOKENS: readonly string[] = ["current-password", "new-password"];

/**
 * An input of type password, or one whose autocomplete has a password
 * token. autocomplete is a space-separated token list compared without
 * regard to case (HTML), so `section-login current-password` and
 * `Current-Password webauthn` count as well.
 */
export function isPasswordField(element: Element): boolean {
  if (!isInputElement(element)) return false;
  if (element.type === "password") return true;
  const tokens = (element.getAttribute("autocomplete") ?? "").toLowerCase().split(/\s+/);
  return tokens.some((token) => PASSWORD_AUTOCOMPLETE_TOKENS.includes(token));
}

/** What the masked-value rule reads from the element (an <option>: with its <select>). */
function maskFieldInfo(element: Element): MaskFieldInfo {
  const info: MaskFieldInfo = {
    localName: element.localName,
    type: isInputElement(element) ? element.type : "",
    autocomplete: element.getAttribute("autocomplete"),
  };
  if (element.localName !== "option") return info;

  const select = element.closest("select");
  return { ...info, select: select === null ? null : maskFieldInfo(select) };
}

/**
 * Whether the element's value is masked in what the tools return (password,
 * hidden, one-time code and payment card fields, and the options of such a
 * select: shared/src/field-mask.ts).
 */
export function isMaskedField(element: Element): boolean {
  return isMaskedFieldInfo(maskFieldInfo(element));
}

/** An element's value as the tools return it: MASKED_VALUE for a masked field, else truncated. */
export function shownValue(element: Element, value: unknown, max: number): string | null {
  return isMaskedField(element) ? MASKED_VALUE : truncatedValue(value, max);
}

/**
 * An element's text as the tools return it, truncated; null when it has
 * none. MASKED_VALUE for a masked field that has text: the label of an
 * option of a masked select, or the initial text of a masked textarea.
 */
export function shownText(element: Element, max: number): string | null {
  const text = clipText(element.textContent?.trim() ?? "", max);
  return text === "" ? null : maskedText(text, isMaskedField(element));
}

export function assertNotPasswordField(
  element: Element,
  options: { allowPassword?: boolean },
): void {
  if (isPasswordField(element) && options.allowPassword !== true) {
    throw new Error(
      "Refused: target is a password field. Use the browser’s own " +
        "password manager (autofill) for credentials, or set " +
        '"allow_password_typing": true in the safety config ' +
        "if you really want automated password entry.",
    );
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isVisible(element: Element): boolean {
  const style = window.getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return (
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    style.opacity !== "0" &&
    rect.width > 0 &&
    rect.height > 0
  );
}

/**
 * Safely quote a string for use in an XPath expression.
 * Handles strings containing single quotes, double quotes, or both
 * by choosing the appropriate quoting or using concat().
 */
export function escapeXPathString(str: string): string {
  if (!str.includes("'")) {
    return `'${str}'`;
  }
  if (!str.includes('"')) {
    return `"${str}"`;
  }
  // Contains both ' and " — build a concat() expression
  const parts: string[] = [];
  let current = "";
  for (const ch of str) {
    if (ch === "'") {
      if (current) parts.push(`'${current}'`);
      parts.push(`"'"`)
      current = "";
    } else {
      current += ch;
    }
  }
  if (current) parts.push(`'${current}'`);
  return `concat(${parts.join(", ")})`;
}

/**
 * XPath of the innermost elements under <body> whose whole text (all
 * descendant text nodes, whitespace collapsed) contains `text` -- unlike
 * contains(text(), ...), which only looks at the first text node, so
 * "<button><b>Sign</b> in</button>" is found by "Sign in". Contents of
 * script / style / noscript / template never match. Case-sensitive.
 * Null when `text` is only whitespace.
 */
export function textLocatorXPath(text: string): string | null {
  const needle = text.replace(/\s+/g, " ").trim();
  if (needle === "") return null;
  const literal = escapeXPathString(needle);
  const skip = "self::script or self::style or self::noscript or self::template";
  const has = `contains(normalize-space(.), ${literal})`;
  return `//body//*[not(${skip})][${has}][not(*[not(${skip})][${has}])]`;
}

/** Disabled itself, or inside a disabled control / aria-disabled element. */
export function isDisabled(element: Element): boolean {
  try {
    return element.closest(':disabled, [aria-disabled="true"]') !== null;
  } catch {
    return false;
  }
}

/**
 * Element by its text (textLocatorXPath). Of the matches, the first that
 * is visible and enabled wins; else the first visible (disabled) one; else
 * the first. The top document only: text inside iframes or shadow roots
 * is not searched.
 */
function findByText(text: string): Element | null {
  const xpath = textLocatorXPath(text);
  if (xpath === null) return null;
  const matches = document.evaluate(
    xpath,
    document,
    null,
    XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
    null,
  );
  let firstVisible: Element | null = null;
  let first: Element | null = null;
  for (let i = 0; i < Math.min(matches.snapshotLength, LIMITS.TEXT_MATCHES); i++) {
    // XPathResult types its nodes as Node; the text locator selects elements only.
    const el = matches.snapshotItem(i) as Element;
    first ??= el;
    if (!isVisible(el)) continue;
    if (!isDisabled(el)) return el;
    firstVisible ??= el;
  }
  return firstVisible ?? first;
}

/** The locator fields of `options` only (for messages: never typed text or values). */
export function locatorOf(options: FindElementOptions): FindElementOptions {
  const keys = [
    "selector", "xpath", "text", "x", "y", "id", "name", "ariaLabel", "placeholder", "role",
  ] as const;
  const locator: Record<string, unknown> = {};
  for (const key of keys) {
    if (options[key] !== undefined && options[key] !== "") locator[key] = options[key];
  }
  return locator;
}

/**
 * For tools whose `text` argument is data, not a locator (fox_type: the
 * text to type, fox_select_option: the option text): the locator without
 * `text`, so e.g. a placeholder-only fox_type is not searched by the text
 * it is about to type.
 */
export function locatorWithoutText(options: FindElementOptions): FindElementOptions {
  const locator = locatorOf(options);
  delete locator.text;
  return locator;
}

export function hasLocator(locator: FindElementOptions): boolean {
  return Object.keys(locatorOf(locator)).length > 0;
}

/** Tag, id and name of an element (for messages: no text or value). */
export function elementIdentity(element: Element): { tag: string; id?: string; name?: string } {
  const name = element.getAttribute("name");
  return {
    tag: element.tagName.toLowerCase(),
    ...(element.id ? { id: element.id } : {}),
    ...(name ? { name } : {}),
  };
}

export function notFoundError(locator: FindElementOptions): Error {
  return new Error(`Element not found: ${JSON.stringify(locatorOf(locator))}`);
}

export function findElement(options: FindElementOptions): Element | null {
  if (options.selector) {
    return document.querySelector(options.selector);
  }
  if (options.xpath) {
    const result = document.evaluate(
      options.xpath,
      document,
      null,
      XPathResult.FIRST_ORDERED_NODE_TYPE,
      null,
    );
    // XPathResult types its node as Node; a locator XPath is meant to select an element.
    return result.singleNodeValue as Element | null;
  }
  if (options.text) {
    return findByText(options.text);
  }
  if (options.x !== undefined && options.y !== undefined) {
    return document.elementFromPoint(options.x, options.y);
  }
  if (options.id) {
    return document.getElementById(options.id);
  }
  if (options.name) {
    return document.querySelector(`[name=${CSS.escape(options.name)}]`);
  }
  if (options.ariaLabel) {
    return document.querySelector(
      `[aria-label=${CSS.escape(options.ariaLabel)}]`,
    );
  }
  if (options.placeholder) {
    return document.querySelector(
      `[placeholder=${CSS.escape(options.placeholder)}]`,
    );
  }
  if (options.role) {
    return document.querySelector(`[role=${CSS.escape(options.role)}]`);
  }
  return null;
}

export function generateSelector(element: Element): string {
  if (element.id) return `#${CSS.escape(element.id)}`;

  const path: string[] = [];
  let current: Element | null = element;

  while (current && current !== document.body) {
    let selector = current.tagName.toLowerCase();

    if (current.id) {
      selector = `#${CSS.escape(current.id)}`;
      path.unshift(selector);
      break;
    }

    if (current.className && typeof current.className === "string") {
      const classes = current.className
        .trim()
        .split(/\s+/)
        .filter((c) => c && !/^[0-9]/.test(c));
      if (classes.length > 0) {
        selector +=
          "." + classes.slice(0, LIMITS.SELECTOR_CLASSES).map((c) => CSS.escape(c)).join(".");
      }
    }

    const siblings = current.parentElement?.children;
    if (siblings) {
      const tagName = current.tagName;
      const sameTagSiblings = Array.from(siblings).filter(
        (s) => s.tagName === tagName,
      );
      if (sameTagSiblings.length > 1) {
        const index = sameTagSiblings.indexOf(current) + 1;
        selector += `:nth-of-type(${index})`;
      }
    }

    path.unshift(selector);
    current = current.parentElement;
  }

  return path.join(" > ");
}

/** The element's box in viewport coordinates, with its center. */
function elementPosition(element: Element): ElementPosition {
  const rect = element.getBoundingClientRect();
  return {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
    centerX: rect.left + rect.width / 2,
    centerY: rect.top + rect.height / 2,
  };
}

/**
 * What a read (fox_find by selector) and an acting command, both checked
 * for the site, return about an element: its value and text masked by the
 * masked-value rule.
 */
export function getElementInfo(element: Element): ElementInfo {
  // Property reads only: on an element without them they are undefined (→ null below).
  const htmlEl = element as HTMLInputElement;

  return {
    tag: element.tagName.toLowerCase(),
    id: element.id || null,
    classes: Array.from(element.classList),
    name: htmlEl.name || null,
    type: htmlEl.type || null,
    text: shownText(element, LIMITS.ELEMENT_TEXT),
    value: shownValue(element, htmlEl.value, LIMITS.ELEMENT_TEXT),
    href: (element as HTMLAnchorElement).href || null,
    src: (element as HTMLImageElement).src || null,
    placeholder: htmlEl.placeholder || null,
    ariaLabel: element.getAttribute("aria-label"),
    role: element.getAttribute("role"),
    disabled: "disabled" in htmlEl ? htmlEl.disabled : false,
    checked: htmlEl.checked ?? false,
    visible: isVisible(element),
    position: elementPosition(element),
    selector: generateSelector(element),
  };
}

/**
 * Where an element is, and nothing of its content (no text, value, href or
 * src): what the commands that are not reads return (waits, hover,
 * highlight, scroll). They run without the confirm_read_sites check, so
 * they must not read the page through the element they found.
 */
export function getElementLocation(element: Element): ElementLocation {
  return {
    tag: element.tagName.toLowerCase(),
    selector: generateSelector(element),
    position: elementPosition(element),
  };
}
