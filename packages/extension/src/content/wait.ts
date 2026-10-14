// Waits: element, DOM change, network idle, click and wait.

import { abortedError, whenAborted } from "./abort";
import { DELAYS, LIMITS, TIMEOUTS } from "./constants";
import { findElement, isVisible, getElementInfo, sleep } from "./dom";
import { performClick } from "./input";
import { activeRequestCount, beginNetworkCount, interceptionStatus } from "./page-hooks";
import type {
  ChangeType,
  WaitOptions,
  WaitForChangeOptions,
  NetworkIdleOptions,
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

const CHANGE_TYPES: readonly ChangeType[] = ["childList", "attributes", "text"];

/** The MutationRecord type of each changeType ("text" is characterData). */
const MUTATION_TYPE_OF: Record<ChangeType, MutationRecordType> = {
  childList: "childList",
  attributes: "attributes",
  text: "characterData",
};

/** What a wait reports of one DOM change. */
function changeRecord(mutation: MutationRecord): Record<string, unknown> {
  return {
    type: mutation.type,
    // A text node target has no tagName: `?.` leaves it undefined.
    target: (mutation.target as Element).tagName?.toLowerCase(),
    addedNodes: mutation.addedNodes.length,
    removedNodes: mutation.removedNodes.length,
  };
}

/** Whether `mutation` is of the changeType waited for (any, without one). */
function isWatchedChange(mutation: MutationRecord, changeType: ChangeType | undefined): boolean {
  return changeType === undefined || mutation.type === MUTATION_TYPE_OF[changeType];
}

/**
 * The element waitForChange watches. A selector that matches nothing fails,
 * instead of silently watching the whole body; so does an unknown changeType.
 */
function changeTarget(options: WaitForChangeOptions): Element {
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

  return target;
}

function changeObserverOptions(options: WaitForChangeOptions): MutationObserverInit {
  return {
    childList: true,
    subtree: options.subtree !== false,
    attributes: options.attributes !== false,
    // changeType "text" waits for characterData records: observe them.
    characterData: options.characterData === true || options.changeType === "text",
    attributeOldValue: options.attributeOldValue === true,
  };
}

/** The result of a waitForChange that ran to its timeout. */
function changesAtTimeout(changes: Record<string, unknown>[], timeout: number): Record<string, unknown> {
  return changes.length > 0
    ? { changed: true, changes, waitedMs: timeout }
    : { changed: false, changes: [], waitedMs: timeout, timedOut: true };
}

/**
 * Wait for a DOM change: the first one of the changeType (any without one),
 * or with waitForAll every one until the timeout. The pause switch ends it
 * with abortedError() (abort.ts).
 */
export async function waitForChange(
  options: WaitForChangeOptions,
): Promise<Record<string, unknown>> {
  const timeout = options.timeout || TIMEOUTS.DEFAULT;
  const target = changeTarget(options);

  return new Promise((resolve, reject) => {
    const changes: Record<string, unknown>[] = [];
    const startTime = Date.now();
    let settled = false;
    const settle = (end: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      observer.disconnect();
      stopListening();
      end();
    };

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (!isWatchedChange(mutation, options.changeType)) continue;
        changes.push(changeRecord(mutation));
        if (options.waitForAll !== true) {
          settle(() => resolve({ changed: true, changes, waitedMs: Date.now() - startTime }));
          return;
        }
      }
    });
    observer.observe(target, changeObserverOptions(options));
    const timer = setTimeout(() => settle(() => resolve(changesAtTimeout(changes, timeout))), timeout);
    const stopListening = whenAborted(() => settle(() => reject(abortedError())));
  });
}

export async function waitForNetworkIdle(
  options: NetworkIdleOptions,
): Promise<Record<string, unknown>> {
  // The counting hooks are in for this wait only (page-hooks.ts). Requests
  // already in flight when it starts are not seen.
  const endCount = beginNetworkCount();
  try {
    return await waitUntilIdle(options);
  } finally {
    endCount();
  }
}

async function waitUntilIdle(options: NetworkIdleOptions): Promise<Record<string, unknown>> {
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
        interception: interceptionStatus(),
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
    interception: interceptionStatus(),
  };
}

/** Record every DOM change under the body into `changes` (clickAndWait). */
function recordBodyChanges(changes: Record<string, unknown>[]): MutationObserver {
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) changes.push(changeRecord(mutation));
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
  });

  return observer;
}

/** The first visible element of `selector` before `deadline` (epoch ms), else null. */
async function pollVisible(selector: string, deadline: number): Promise<Element | null> {
  while (Date.now() < deadline) {
    const el = document.querySelector(selector);
    if (el && isVisible(el)) return el;
    await sleep(DELAYS.POLL);
  }

  return null;
}

/** Wait until `changes` stops growing for DELAYS.CLICK_SETTLE, or `deadline` (epoch ms). */
async function waitUntilSettled(changes: readonly unknown[], deadline: number): Promise<void> {
  let lastChangeCount = 0;
  let stableTime = 0;

  while (Date.now() < deadline) {
    if (changes.length > lastChangeCount) {
      lastChangeCount = changes.length;
      stableTime = 0;
    } else {
      stableTime += DELAYS.POLL;
      if (stableTime >= DELAYS.CLICK_SETTLE) return;
    }
    await sleep(DELAYS.POLL);
  }
}

/**
 * Click, then wait for waitForSelector to show, else for the DOM changes to
 * settle (waitForChange: false waits for neither). The observer goes in a
 * finally: the pause switch can end the wait with an error (abort.ts).
 */
export async function clickAndWait(
  options: ClickAndWaitOptions,
): Promise<Record<string, unknown>> {
  const waitTimeout = options.waitTimeout || TIMEOUTS.CLICK_AND_WAIT;
  const changes: Record<string, unknown>[] = [];
  const observer = options.waitForChange !== false ? recordBodyChanges(changes) : null;

  try {
    const clickResult = await performClick(options);
    const startTime = Date.now();
    const deadline = startTime + waitTimeout;
    if (options.waitForSelector) {
      const found = await pollVisible(options.waitForSelector, deadline);
      if (found) {
        return {
          ...clickResult,
          waited: true,
          waitedMs: Date.now() - startTime,
          foundElement: getElementInfo(found),
          changes: changes.slice(0, LIMITS.CLICK_WAIT_CHANGES),
        };
      }
    } else if (observer) {
      await waitUntilSettled(changes, deadline);
    }

    return {
      ...clickResult,
      waited: true,
      waitedMs: Date.now() - startTime,
      changes: changes.slice(0, LIMITS.CLICK_WAIT_CHANGES),
      totalChanges: changes.length,
    };
  } finally {
    observer?.disconnect();
  }
}
