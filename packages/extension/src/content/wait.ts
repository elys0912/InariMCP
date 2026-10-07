// Waits and observers: element, DOM change, network idle, mutation
// observers, click and wait.

import { DELAYS, LIMITS, TIMEOUTS } from "./constants";
import { findElement, isVisible, getElementInfo, sleep, generateSelector } from "./dom";
import { performClick } from "./input";
import { ensurePageHooks } from "./log-store";
import { activeRequestCount, interceptionStatus } from "./page-hooks";
import type {
  ChangeType,
  WaitOptions,
  ObserverRecord,
  WaitForChangeOptions,
  NetworkIdleOptions,
  ObserveOptions,
  MutationChange,
  ClickAndWaitOptions,
} from "./types";

export async function waitForElement(
  options: WaitOptions,
): Promise<Record<string, unknown>> {
  const timeout = options.timeout || TIMEOUTS.WAIT_ELEMENT;
  const interval = options.interval || DELAYS.POLL;
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    const element = findElement(options);
    if (element) {
      if (!options.visible || isVisible(element)) {
        return { found: true, element: getElementInfo(element) };
      }
    }
    await sleep(interval);
  }

  throw new Error(`Element not found within ${timeout}ms`);
}

const activeObservers = new Map<string, ObserverRecord>();

/** Generated observer ids: a counter makes them unique within the page. */
let observerSeq = 0;

const CHANGE_TYPES: readonly ChangeType[] = ["childList", "attributes", "text"];

export async function waitForChange(
  options: WaitForChangeOptions,
): Promise<Record<string, unknown>> {
  const timeout = options.timeout || TIMEOUTS.DEFAULT;
  // A selector that matches nothing fails like observeElement, instead of
  // silently watching the whole body.
  const target = options.selector
    ? document.querySelector(options.selector)
    : document.body;
  if (!target) {
    throw new Error(`Element not found: ${options.selector}`);
  }
  if (options.changeType !== undefined && !CHANGE_TYPES.includes(options.changeType)) {
    throw new Error(
      `Unknown changeType: ${JSON.stringify(options.changeType)} ` +
        "(expected childList, attributes or text)",
    );
  }

  return new Promise((resolve) => {
    let resolved = false;
    const changes: Record<string, unknown>[] = [];
    const startTime = Date.now();

    const observer = new MutationObserver((mutations) => {
      if (resolved) return;

      for (const mutation of mutations) {
        const change: Record<string, unknown> = {
          type: mutation.type,
          // A text node target has no tagName: `?.` leaves it undefined.
          target: (mutation.target as Element).tagName?.toLowerCase(),
          addedNodes: mutation.addedNodes.length,
          removedNodes: mutation.removedNodes.length,
        };

        if (options.changeType) {
          if (
            options.changeType === "childList" &&
            mutation.type !== "childList"
          )
            continue;
          if (
            options.changeType === "attributes" &&
            mutation.type !== "attributes"
          )
            continue;
          if (
            options.changeType === "text" &&
            mutation.type !== "characterData"
          )
            continue;
        }

        changes.push(change);

        if (options.waitForAll !== true) {
          resolved = true;
          observer.disconnect();
          resolve({
            changed: true,
            changes,
            waitedMs: Date.now() - startTime,
          });
          return;
        }
      }
    });

    observer.observe(target, {
      childList: true,
      subtree: options.subtree !== false,
      attributes: options.attributes !== false,
      // changeType "text" waits for characterData records: observe them.
      characterData: options.characterData === true || options.changeType === "text",
      attributeOldValue: options.attributeOldValue === true,
    });

    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        observer.disconnect();
        if (changes.length > 0) {
          resolve({ changed: true, changes, waitedMs: timeout });
        } else {
          resolve({
            changed: false,
            changes: [],
            waitedMs: timeout,
            timedOut: true,
          });
        }
      }
    }, timeout);
  });
}

export async function waitForNetworkIdle(
  options: NetworkIdleOptions,
): Promise<Record<string, unknown>> {
  // Counting needs the page hooks. Requests already in flight before they
  // were installed are not seen.
  ensurePageHooks();
  const timeout = options.timeout || TIMEOUTS.NETWORK_IDLE;
  const idleTime = options.idleTime || DELAYS.NETWORK_IDLE_TIME;
  const startTime = Date.now();
  let lastActivitySnapshot = activeRequestCount();
  let lastChangeTime = Date.now();

  while (Date.now() - startTime < timeout) {
    if (activeRequestCount() !== lastActivitySnapshot) {
      lastActivitySnapshot = activeRequestCount();
      lastChangeTime = Date.now();
    }
    const idleDuration = Date.now() - lastChangeTime;
    if (activeRequestCount() === 0 && idleDuration >= idleTime) {
      return {
        idle: true,
        waitedMs: Date.now() - startTime,
        pendingRequests: 0,
        interception: { fetch: interceptionStatus().fetch, xhr: interceptionStatus().xhr },
      };
    }
    await sleep(DELAYS.POLL);
  }

  // A timeout is a failure (success: false overrides the background's
  // success: true), with the details kept for the caller.
  return {
    success: false,
    error:
      `Network did not become idle within ${timeout}ms ` +
      `(${activeRequestCount()} request(s) still in flight)`,
    idle: false,
    timedOut: true,
    waitedMs: timeout,
    pendingRequests: activeRequestCount(),
    interception: { fetch: interceptionStatus().fetch, xhr: interceptionStatus().xhr },
  };
}

/**
 * Selector of a mutation's target. A characterData change targets a text
 * node, which has no selector of its own: its parent element stands for it
 * ("text" when it has none, e.g. directly under a shadow root).
 */
function mutationTargetSelector(node: Node): string {
  const element = isElementNode(node) ? node : node.parentElement;
  return element ? generateSelector(element) : "text";
}

function isElementNode(node: Node): node is Element {
  return node.nodeType === Node.ELEMENT_NODE;
}

export function observeElement(
  options: ObserveOptions,
): Record<string, unknown> {
  const target = document.querySelector(options.selector);
  if (!target) {
    throw new Error(`Element not found: ${options.selector}`);
  }

  // Date.now() alone repeats within a millisecond, and a repeated id
  // silently replaces the earlier observer: the page-wide counter keeps
  // generated ids unique (the map of observers is per page too).
  const observerId = options.observerId || `obs_${Date.now()}_${++observerSeq}`;

  activeObservers.get(observerId)?.observer.disconnect();

  const changes: MutationChange[] = [];

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      changes.push({
        type: mutation.type,
        timestamp: Date.now(),
        target: mutationTargetSelector(mutation.target),
        // Added / removed text nodes have no tagName: reported as "text".
        addedNodes: Array.from(mutation.addedNodes)
          .map((n) => (n as Element).tagName?.toLowerCase() || "text")
          .filter(Boolean),
        removedNodes: Array.from(mutation.removedNodes)
          .map((n) => (n as Element).tagName?.toLowerCase() || "text")
          .filter(Boolean),
        attributeName: mutation.attributeName,
        oldValue: mutation.oldValue,
      });

      if (changes.length > LIMITS.OBSERVER_CHANGES) changes.shift();
    }
  });

  const attributes = options.observeAttributes !== false;
  observer.observe(target, {
    childList: options.observeChildList !== false,
    subtree: options.observeSubtree !== false,
    attributes,
    characterData: true,
    attributeOldValue: attributes,
  });

  activeObservers.set(observerId, {
    observer,
    changes,
    target: options.selector,
  });

  return { observing: true, observerId, target: options.selector };
}

export function stopObserving(options: {
  observerId: string;
}): Record<string, unknown> {
  const observerId = options.observerId;

  const record = activeObservers.get(observerId);
  if (!record) {
    throw new Error(
      `No observer '${observerId}' on this page (observers end when the page ` +
      "reloads or navigates)",
    );
  }

  record.observer.disconnect();
  activeObservers.delete(observerId);

  return {
    stopped: true,
    observerId,
    target: record.target,
    changes: record.changes,
    totalChanges: record.changes.length,
  };
}

export async function clickAndWait(
  options: ClickAndWaitOptions,
): Promise<Record<string, unknown>> {
  const waitTimeout = options.waitTimeout || TIMEOUTS.CLICK_AND_WAIT;
  const waitForSel = options.waitForSelector;
  const shouldWaitForChange = options.waitForChange !== false;

  let changes: Record<string, unknown>[] = [];
  let observer: MutationObserver | null = null;

  if (shouldWaitForChange) {
    observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        changes.push({
          type: mutation.type,
          // A text node target has no tagName: `?.` leaves it undefined.
          target: (mutation.target as Element).tagName?.toLowerCase(),
          addedNodes: mutation.addedNodes.length,
          removedNodes: mutation.removedNodes.length,
        });
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
    });
  }

  const clickResult = await performClick(options);
  const startTime = Date.now();

  if (waitForSel) {
    while (Date.now() - startTime < waitTimeout) {
      const el = document.querySelector(waitForSel);
      if (el && isVisible(el)) {
        if (observer) observer.disconnect();
        return {
          ...clickResult,
          waited: true,
          waitedMs: Date.now() - startTime,
          foundElement: getElementInfo(el),
          changes: changes.slice(0, LIMITS.CLICK_WAIT_CHANGES),
        };
      }
      await sleep(DELAYS.POLL);
    }
  } else if (shouldWaitForChange) {
    let lastChangeCount = 0;
    let stableTime = 0;

    while (Date.now() - startTime < waitTimeout) {
      if (changes.length > lastChangeCount) {
        lastChangeCount = changes.length;
        stableTime = 0;
      } else {
        stableTime += DELAYS.POLL;
        if (stableTime >= DELAYS.CLICK_SETTLE) break;
      }
      await sleep(DELAYS.POLL);
    }
  }

  if (observer) observer.disconnect();

  return {
    ...clickResult,
    waited: true,
    waitedMs: Date.now() - startTime,
    changes: changes.slice(0, LIMITS.CLICK_WAIT_CHANGES),
    totalChanges: changes.length,
  };
}
