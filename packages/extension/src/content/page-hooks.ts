// In-flight request counting for waitForNetworkIdle: hooks in the page's
// own JS world, present only while a wait runs.
//
// Firefox runs content scripts in a sandbox that sees the page through Xray
// wrappers: `XMLHttpRequest` and `fetch` in this script are the sandbox's
// own, and replacing them never affects the page's scripts. The hooks are
// therefore defined on the page's objects (window.wrappedJSObject) with
// exportFunction(). No <script> element is inserted, so the page's CSP does
// not apply and no code string is ever evaluated in the page.
//
// The hooks can be called by the page directly, with any arguments. They
// only count: nothing about a request (URL, headers, body, response) is
// read or kept, and every call is forwarded to the page's ORIGINAL function
// (never this sandbox's fetch / XHR, which carry extension privileges). A
// page can therefore skew the in-flight counter of its own tab, and nothing
// more.
//
// beginNetworkCount() installs the hooks when the first wait of the document
// starts; the function it returns removes them when the last running wait
// ends, putting the page's own fetch and XMLHttpRequest.prototype.send back
// (unless the page replaced them meanwhile: its replacement then stays, and
// the hook inside it only forwards). Requests already in flight when the
// hooks went in are not seen.

import { once } from "../once";

/** In-flight page requests (fetch + XHR) seen by the hooks. A count only. */
let activeRequests = 0;

/** Waits running now; the hooks are in while it is above zero. */
let runningWaits = 0;

/** Puts the page's own functions back (set while the hooks are in). */
let uninstallHooks: (() => void) | null = null;

const interception = { fetch: false, xhr: false };

/** In-flight page requests (fetch + XHR) seen by the hooks. */
export function activeRequestCount(): number {
  return activeRequests;
}

/** Which hooks are in (a copy). */
export function interceptionStatus(): { fetch: boolean; xhr: boolean } {
  return { ...interception };
}

/** Count one in-flight request; the returned function settles it (once). */
function beginRequest(): () => void {
  activeRequests++;
  return once(() => {
    activeRequests = Math.max(0, activeRequests - 1);
  });
}

/** Hook the page's fetch; returns what puts it back, or null when not hooked. */
function hookFetch(pageWin: Window & typeof globalThis): (() => void) | null {
  // Reflect.get reads the functions as values, unbound: they are only ever
  // called through Reflect.apply with the page's own `this`.
  const originalFetch: unknown = Reflect.get(pageWin, "fetch");
  const pagePromiseThen: unknown = Reflect.get(pageWin.Promise.prototype, "then");
  if (typeof originalFetch !== "function" || typeof pagePromiseThen !== "function") {
    return null;
  }

  const fetchHook = function (input: unknown, init: unknown): unknown {
    // The page's own fetch, run with the page's principal.
    if (runningWaits === 0) return Reflect.apply(originalFetch, pageWin, [input, init]);

    const settle = beginRequest();
    let pagePromise: unknown;
    try {
      pagePromise = Reflect.apply(originalFetch, pageWin, [input, init]);
    } catch (error) {
      settle();
      throw error;
    }

    // Observe completion with the page's Promise#then. The callback must be
    // exported (the page cannot call sandbox functions otherwise), must not
    // throw and must return undefined, so the derived promise always
    // resolves (no unhandled rejection shows up in the page).
    const onSettled = exportFunction(function (): void {
      settle();
    }, window);
    try {
      Reflect.apply(pagePromiseThen, pagePromise, [onSettled, onSettled]);
    } catch {
      settle();
    }
    return pagePromise;
  };

  exportFunction(fetchHook, pageWin, { defineAs: "fetch" });
  // Read back the same way it is read when putting the original back, so
  // the identity check below compares like with like.
  const installed: unknown = Reflect.get(pageWin, "fetch");
  return () => {
    if (Reflect.get(pageWin, "fetch") === installed) pageWin.fetch = originalFetch as typeof fetch;
  };
}

/** Hook XMLHttpRequest.prototype.send; returns what puts it back, or null. */
function hookXhrSend(pageWin: Window & typeof globalThis): (() => void) | null {
  const proto = pageWin.XMLHttpRequest.prototype;
  const originalSend: unknown = Reflect.get(proto, "send");
  if (typeof originalSend !== "function") return null;

  const sendHook = function (this: unknown, ...args: unknown[]): unknown {
    let settle: (() => void) | null = null;
    if (runningWaits > 0 && typeof this === "object" && this !== null) {
      // The page's XHR (another realm, not `instanceof XMLHttpRequest` here).
      const xhr = this as XMLHttpRequest;
      try {
        settle = beginRequest();
        xhr.addEventListener("loadend", settle);
      } catch {
        if (settle) settle();
        settle = null;
      }
    }

    try {
      return Reflect.apply(originalSend, this, args);
    } catch (error) {
      // send() threw synchronously (e.g. not opened) -- no loadend follows
      if (settle) settle();
      throw error;
    }
  };

  exportFunction(sendHook, proto, { defineAs: "send" });
  const installed: unknown = Reflect.get(proto, "send");
  return () => {
    if (Reflect.get(proto, "send") === installed) proto.send = originalSend as XMLHttpRequest["send"];
  };
}

/** Install the hooks (Firefox only); returns what removes them. */
function installHooks(): () => void {
  const pageWin = window.wrappedJSObject;
  if (!pageWin || typeof exportFunction !== "function") {
    // Not Firefox: no Xray waivers -- nothing is counted.
    return () => {};
  }
  const removers: Array<() => void> = [];
  const hooks = [
    { name: "fetch", hook: hookFetch },
    { name: "xhr", hook: hookXhrSend },
  ] as const;
  for (const { name, hook } of hooks) {
    try {
      const remove = hook(pageWin);
      interception[name] = remove !== null;
      if (remove) removers.push(remove);
    } catch {
      interception[name] = false;
    }
  }
  return () => {
    for (const remove of removers) {
      try {
        remove();
      } catch {
        // the page made the property read-only: the hook stays and only forwards
      }
    }
    interception.fetch = false;
    interception.xhr = false;
  };
}

/**
 * Start counting for one wait. The returned function ends it (call it
 * once, in a finally); the hooks go when no wait runs any more.
 */
export function beginNetworkCount(): () => void {
  if (runningWaits === 0) uninstallHooks = installHooks();
  runningWaits++;
  return once(() => {
    runningWaits--;
    if (runningWaits === 0 && uninstallHooks) {
      uninstallHooks();
      uninstallHooks = null;
    }
  });
}
