// Waits: element, network idle.

import { DELAYS, TIMEOUTS } from "./constants";
import { findElement, isVisible, getElementInfo, sleep } from "./dom";
import { activeRequestCount, beginNetworkCount, interceptionStatus } from "./page-hooks";
import type { WaitOptions, NetworkIdleOptions } from "./types";

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
