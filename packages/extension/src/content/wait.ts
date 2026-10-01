// Waits and observers: element, DOM change, network idle, mutation
// observers, click and wait.

import { TIMEOUTS } from "./constants";
import { findElement, isVisible, getElementInfo, sleep, generateSelector } from "./dom";
import { performClick } from "./input";
import { ensurePageHooks } from "./log-store";
import { activeRequestCount, interceptionStatus } from "./page-hooks";
import type {
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
  const interval = options.interval || 100;
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

export async function waitForChange(
  options: WaitForChangeOptions,
): Promise<Record<string, unknown>> {
  const timeout = options.timeout || TIMEOUTS.DEFAULT;
  const targetSelector = options.selector || "body";
  const target =
    document.querySelector(targetSelector) || document.body;

  return new Promise((resolve) => {
    let resolved = false;
    const changes: Record<string, unknown>[] = [];
    const startTime = Date.now();

    const observer = new MutationObserver((mutations) => {
      if (resolved) return;

      for (const mutation of mutations) {
        const change: Record<string, unknown> = {
          type: mutation.type,
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
      characterData: options.characterData === true,
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
  const idleTime = options.idleTime || 500;
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
    await sleep(100);
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

export function observeElement(
  options: ObserveOptions,
): Record<string, unknown> {
  const target = document.querySelector(options.selector);
  if (!target) {
    throw new Error(`Element not found: ${options.selector}`);
  }

  const observerId = options.observerId || `obs_${Date.now()}`;

  if (activeObservers.has(observerId)) {
    activeObservers.get(observerId)!.observer.disconnect();
  }

  const changes: MutationChange[] = [];

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      changes.push({
        type: mutation.type,
        timestamp: Date.now(),
        target: generateSelector(mutation.target as Element),
        addedNodes: Array.from(mutation.addedNodes)
          .map((n) => (n as Element).tagName?.toLowerCase() || "text")
          .filter(Boolean),
        removedNodes: Array.from(mutation.removedNodes)
          .map((n) => (n as Element).tagName?.toLowerCase() || "text")
          .filter(Boolean),
        attributeName: mutation.attributeName,
        oldValue: mutation.oldValue,
      });

      if (changes.length > 100) changes.shift();
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

  if (!activeObservers.has(observerId)) {
    throw new Error(
      `No observer '${observerId}' on this page (observers end when the page ` +
      "reloads or navigates)",
    );
  }

  const record = activeObservers.get(observerId)!;
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
  const waitTimeout = options.waitTimeout || 5000;
  const waitForSel = options.waitForSelector;
  const shouldWaitForChange = options.waitForChange !== false;

  let changes: Record<string, unknown>[] = [];
  let observer: MutationObserver | null = null;

  if (shouldWaitForChange) {
    observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        changes.push({
          type: mutation.type,
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
          changes: changes.slice(0, 20),
        };
      }
      await sleep(100);
    }
  } else if (shouldWaitForChange) {
    let lastChangeCount = 0;
    let stableTime = 0;

    while (Date.now() - startTime < waitTimeout) {
      if (changes.length > lastChangeCount) {
        lastChangeCount = changes.length;
        stableTime = 0;
      } else {
        stableTime += 100;
        if (stableTime >= 500) break;
      }
      await sleep(100);
    }
  }

  if (observer) observer.disconnect();

  return {
    ...clickResult,
    waited: true,
    waitedMs: Date.now() - startTime,
    changes: changes.slice(0, 20),
    totalChanges: changes.length,
  };
}
