// Input: click, type, scroll, set / select values, hover, key presses.

import { TIMEOUTS } from "./constants";
import {
  findElement,
  notFoundError,
  isDisabled,
  locatorOf,
  sleep,
  getElementInfo,
  isTextInput,
  locatorWithoutText,
  hasLocator,
  assertNotPasswordField,
  elementIdentity,
} from "./dom";
import type {
  ClickOptions,
  TypeOptions,
  ScrollOptions,
  SetValueOptions,
  FindElementOptions,
  PressKeyOptions,
  SelectOptionOptions,
} from "./types";

export async function performClick(
  options: ClickOptions,
): Promise<Record<string, unknown>> {
  const element = findElement(options);
  if (!element) throw notFoundError(options);
  // A real click on a disabled control does nothing; say so instead of
  // reporting a click that had no effect.
  if (isDisabled(element)) {
    throw new Error(`Element is disabled: ${JSON.stringify(locatorOf(options))}`);
  }

  element.scrollIntoView({ behavior: "smooth", block: "center" });
  await sleep(100);

  const rect = element.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;

  if (options.rightClick) {
    element.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: x,
        clientY: y,
      }),
    );
  } else if (options.doubleClick) {
    element.dispatchEvent(
      new MouseEvent("dblclick", {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: x,
        clientY: y,
      }),
    );
  } else {
    element.dispatchEvent(
      new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: x,
        clientY: y,
      }),
    );
    await sleep(50);
    element.dispatchEvent(
      new MouseEvent("mouseup", {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: x,
        clientY: y,
      }),
    );
    // One click event only. A dispatched click also runs the element's
    // activation behavior (links, checkboxes, submit buttons), so calling
    // element.click() as well would fire every click handler twice.
    element.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: x,
        clientY: y,
      }),
    );
  }

  return {
    clicked: true,
    element: getElementInfo(element),
    position: { x, y },
  };
}

/**
 * Delay between typed characters: the requested one (0 allowed; default
 * 50 ms), reduced so that the delays of all `length` characters add up to
 * at most `budgetMs` -- a long text must finish well inside the command
 * timeout (30 s), where 600 characters at 50 ms used to take over 30 s.
 */
export function typingDelay(length: number, requested: unknown, budgetMs: number): number {
  const base =
    typeof requested === "number" && Number.isFinite(requested) && requested >= 0
      ? requested
      : 50;
  if (length <= 0) return base;
  return Math.min(base, Math.floor(budgetMs / length));
}

function isEditable(el: Element): boolean {
  return isTextInput(el) || (el as HTMLElement).isContentEditable === true;
}

const IMPLICIT_SUBMIT_BLOCKING_TYPES: ReadonlySet<string> = new Set([
  "text", "search", "email", "url", "tel", "password", "number",
  "date", "month", "week", "time", "datetime-local",
]);

/**
 * Submit `form` the way pressing Enter in one of its fields does (HTML
 * "implicit submission"), since synthetic key events have no default
 * action: through the default (first) submit button, or without one when
 * the form has a single text-like field. requestSubmit() fires the submit
 * event and runs constraint validation like a real submission.
 */
function implicitSubmit(form: HTMLFormElement): "submitted" | "invalid" | "blocked" {
  const controls = Array.from(form.elements);
  const submitter = controls.find((el) =>
    (el.tagName === "BUTTON" && (el as HTMLButtonElement).type === "submit") ||
    (el.tagName === "INPUT" && ["submit", "image"].includes((el as HTMLInputElement).type)),
  ) as HTMLButtonElement | HTMLInputElement | undefined;
  if (submitter?.disabled) return "blocked";
  if (!submitter) {
    const fields = controls.filter((el) =>
      el.tagName === "INPUT" && IMPLICIT_SUBMIT_BLOCKING_TYPES.has((el as HTMLInputElement).type),
    );
    if (fields.length > 1) return "blocked";
  }
  const skipValidation = form.noValidate || submitter?.formNoValidate === true;
  const valid = skipValidation || form.checkValidity();
  if (typeof form.requestSubmit === "function") {
    form.requestSubmit(submitter);
  } else if (valid) {
    form.submit();
  }
  return valid ? "submitted" : "invalid";
}

/**
 * Enter key on `target` (keydown / keypress / keyup), then implicit form
 * submission for a text field of a form -- unless a keydown handler
 * cancelled the key (as a page does to stop the submission) or `submit`
 * is false. Textareas and editable regions are never submitted.
 * Returns "submitted" | "invalid" | "blocked" | "prevented" | "none".
 */
function pressEnterOn(target: Element, submit: boolean): string {
  const init: KeyboardEventInit = {
    key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true,
  };
  const proceed = target.dispatchEvent(new KeyboardEvent("keydown", init));
  if (proceed) target.dispatchEvent(new KeyboardEvent("keypress", init));
  target.dispatchEvent(new KeyboardEvent("keyup", init));
  if (!proceed) return "prevented";
  const form = target.tagName === "INPUT" ? (target as HTMLInputElement).form : null;
  if (!submit || !form) return "none";
  return implicitSubmit(form);
}

export async function performType(
  options: TypeOptions,
): Promise<Record<string, unknown>> {
  // `text` is what to type, never a locator (see locatorWithoutText).
  const locator = locatorWithoutText(options);
  const located = hasLocator(locator);
  let element: Element | null = located ? findElement(locator) : null;

  // No locator (or focusFirst: false and nothing found): the focused field.
  if (!element && (!located || options.focusFirst === false)) {
    const active = document.activeElement;
    if (active && active !== document.body && isEditable(active)) element = active;
  }

  if (!element) {
    throw located
      ? notFoundError(locator)
      : new Error(
        "No element to type into: pass selector, placeholder, name or id, or focus a field first",
      );
  }
  if (isDisabled(element)) {
    // Without a locator the target is the focused element: name it by its
    // tag / id / name, since an empty locator would say nothing.
    throw new Error(
      located
        ? `Element is disabled: ${JSON.stringify(locator)}`
        : `Focused element is disabled: ${JSON.stringify(elementIdentity(element))}`,
    );
  }

  assertNotPasswordField(element, options);

  (element as HTMLElement).focus();
  element.scrollIntoView({ behavior: "smooth", block: "center" });
  await sleep(100);

  const text = options.text || "";
  const htmlEl = element as HTMLInputElement;

  if (options.clear) {
    if (isTextInput(element)) {
      htmlEl.value = "";
    } else if ((element as HTMLElement).isContentEditable) {
      element.textContent = "";
    }
    element.dispatchEvent(new Event("input", { bubbles: true }));
  }

  const delay = typingDelay(text.length, options.delay, TIMEOUTS.TYPING_BUDGET);
  if (options.instant) {
    if (isTextInput(element)) {
      htmlEl.value = options.clear ? text : htmlEl.value + text;
    } else if ((element as HTMLElement).isContentEditable) {
      element.textContent = options.clear
        ? text
        : (element.textContent || "") + text;
    }
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  } else {
    for (const char of text) {
      const keyInit: KeyboardEventInit = { key: char, bubbles: true, cancelable: true };
      element.dispatchEvent(new KeyboardEvent("keydown", keyInit));
      element.dispatchEvent(new KeyboardEvent("keypress", keyInit));

      if (isTextInput(element)) {
        htmlEl.value += char;
      } else if ((element as HTMLElement).isContentEditable) {
        document.execCommand("insertText", false, char);
      }

      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new KeyboardEvent("keyup", keyInit));

      if (delay > 0) await sleep(delay);
    }
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  const enter = options.pressEnter
    ? pressEnterOn(element, options.submitForm !== false)
    : undefined;

  // The typed text is not echoed back (it may be sensitive): its length only.
  return {
    typed: true,
    element: getElementInfo(element),
    length: text.length,
    ...(options.instant ? {} : { delay }),
    ...(enter !== undefined ? { enter } : {}),
  };
}

export async function performScroll(
  options: ScrollOptions,
): Promise<Record<string, unknown>> {
  // Scroll this element when one is given and found, else the window.
  let element: Element | null = null;

  if (options.selector || options.xpath || options.id) {
    element = findElement(options);
  }

  if (options.toElement) {
    const targetElement = findElement({ selector: options.toElement });
    if (targetElement) {
      targetElement.scrollIntoView({
        behavior: options.smooth !== false ? "smooth" : "auto",
        block: options.block || "center",
      });
      await sleep(500);
      return { scrolled: true, element: getElementInfo(targetElement) };
    }
  }

  if (options.direction) {
    const amount = options.amount || 300;
    let scrollX = 0;
    let scrollY = 0;

    switch (options.direction) {
      case "up":
        scrollY = -amount;
        break;
      case "down":
        scrollY = amount;
        break;
      case "left":
        scrollX = -amount;
        break;
      case "right":
        scrollX = amount;
        break;
      case "top":
        if (element) (element as HTMLElement).scrollTop = 0;
        else window.scrollTo({ top: 0, behavior: "smooth" });
        return { scrolled: true, position: { x: 0, y: 0 } };
      case "bottom":
        if (element)
          (element as HTMLElement).scrollTop = (
            element as HTMLElement
          ).scrollHeight;
        else
          window.scrollTo({
            top: document.body.scrollHeight,
            behavior: "smooth",
          });
        return { scrolled: true, position: "bottom" };
      default: {
        // Reached only by a message that bypassed the server schema.
        const unknown: never = options.direction;
        throw new Error(
          `Unknown scroll direction: ${JSON.stringify(unknown)} ` +
            "(expected up, down, left, right, top or bottom)",
        );
      }
    }

    if (element) {
      element.scrollBy({ left: scrollX, top: scrollY, behavior: "smooth" });
    } else {
      window.scrollBy({ left: scrollX, top: scrollY, behavior: "smooth" });
    }
  } else if (options.x !== undefined || options.y !== undefined) {
    const scrollOpts: ScrollToOptions = {
      left: options.x || 0,
      top: options.y || 0,
      behavior: options.smooth !== false ? "smooth" : "auto",
    };

    if (element) {
      element.scrollTo(scrollOpts);
    } else {
      window.scrollTo(scrollOpts);
    }
  }

  await sleep(300);

  return {
    scrolled: true,
    position: {
      x: element ? (element as HTMLElement).scrollLeft : window.scrollX,
      y: element ? (element as HTMLElement).scrollTop : window.scrollY,
    },
  };
}

export function setValue(
  options: SetValueOptions,
): Record<string, unknown> {
  const element = findElement(options);
  if (!element) throw notFoundError(options);

  assertNotPasswordField(element, options);

  if (isTextInput(element)) {
    element.value = options.value;
  } else if (element.tagName === "SELECT") {
    (element as HTMLSelectElement).value = options.value;
  } else if ((element as HTMLElement).isContentEditable) {
    element.textContent = options.value;
  }

  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));

  return { set: true, element: getElementInfo(element) };
}

export async function hoverElement(
  options: FindElementOptions,
): Promise<Record<string, unknown>> {
  const element = findElement(options);
  if (!element) throw notFoundError(options);

  element.scrollIntoView({ behavior: "smooth", block: "center" });
  await sleep(100);

  const rect = element.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;

  element.dispatchEvent(
    new MouseEvent("mouseenter", {
      bubbles: true,
      clientX: x,
      clientY: y,
    }),
  );
  element.dispatchEvent(
    new MouseEvent("mouseover", {
      bubbles: true,
      clientX: x,
      clientY: y,
    }),
  );

  return { hovered: true, element: getElementInfo(element) };
}

export async function pressKey(
  options: PressKeyOptions,
): Promise<Record<string, unknown>> {
  // Same locator resolution as fox_click (`key` is not a locator); without
  // one, the focused element receives the key.
  const locator = locatorOf(options);
  let target: Element =
    document.activeElement || document.body;
  if (hasLocator(locator)) {
    const element = findElement(locator);
    if (!element) throw notFoundError(locator);
    (element as HTMLElement).focus();
    target = element;
  }

  const eventInit: KeyboardEventInit = {
    key: options.key,
    bubbles: true,
    cancelable: true,
    ctrlKey: !!options.ctrl,
    shiftKey: !!options.shift,
    altKey: !!options.alt,
    metaKey: !!options.meta,
  };

  // Synthetic key events have no default action (isTrusted is false):
  // plain Enter gets the implicit form submission emulated, nothing else.
  if (options.key === "Enter" && !options.ctrl && !options.shift && !options.alt && !options.meta) {
    const enter = pressEnterOn(target, true);
    return { pressed: options.key, enter, element: getElementInfo(target) };
  }

  target.dispatchEvent(new KeyboardEvent("keydown", eventInit));
  target.dispatchEvent(new KeyboardEvent("keypress", eventInit));
  target.dispatchEvent(new KeyboardEvent("keyup", eventInit));

  return { pressed: options.key, element: getElementInfo(target) };
}

export function selectOption(
  options: SelectOptionOptions,
): Record<string, unknown> {
  const element = findElement(locatorWithoutText(options));
  if (!element || element.tagName !== "SELECT") {
    throw new Error("Select element not found");
  }

  const sel = element as HTMLSelectElement;
  const all = Array.from(sel.options);
  let option: HTMLOptionElement | undefined;
  if (options.value !== undefined) {
    option = all.find((o) => o.value === options.value);
  } else if (options.index !== undefined) {
    option = all[options.index];
  } else if (options.text !== undefined) {
    option = all.find((o) => o.text === options.text) ??
      all.find((o) => o.text.trim() === options.text!.trim());
  } else {
    throw new Error("Pass value, text or index of the option to select");
  }
  if (!option) {
    throw new Error("No such option in the select element (by the given value / text / index)");
  }
  option.selected = true;

  sel.dispatchEvent(new Event("change", { bubbles: true }));

  return {
    selected: true,
    value: sel.value,
    text: sel.options[sel.selectedIndex]?.text,
  };
}
