// KitsuneMCP Content Script
// Runs in web pages to handle DOM interactions, clicks, typing, and element inspection
//
// Based on ClaudeCodeBrowser by Andre Watson (nanogenomic), Ligandal Inc.
// MIT License — Copyright (c) 2025
//
// Bundled with its imports into dist/content.js (scripts/build-extension.mjs),
// which is both the manifest content script and the file the background
// injects early on logging tabs. Imported modules run before the
// __fox_injected guard below (on every injection), so they must have no
// top-level side effects.

import { handleMessage } from "./content/handler";
import { rememberContextTarget } from "./content/inspect";
import { resumeLoggingFromBackground, sendLogBatch } from "./content/log-store";
import { recordScriptStart } from "./content/page-hooks";
import type { ContentMessage } from "./content/types";

(function () {
  "use strict";

  // Prevent multiple injections
  if (window.__fox_injected) return;
  window.__fox_injected = true;
  recordScriptStart();

  // ---------------------------------------------------------------------------
  // Message handler
  // ---------------------------------------------------------------------------

  browser.runtime.onMessage.addListener(
    (
      message: unknown,
      _sender: browser.runtime.MessageSender,
      sendResponse: (response: unknown) => void,
    ): boolean => {
      handleMessage(message as ContentMessage)
        .then(sendResponse)
        .catch((error: unknown) =>
          sendResponse({
            success: false,
            error: (error as Error).message,
          }),
        );
      return true;
    },
  );

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------

  resumeLoggingFromBackground();
  // The element the context menu was opened on ("inspect element").
  document.addEventListener("contextmenu", rememberContextTarget, true);
  if (window === window.top) {
    // Send what is pending before the document goes away (best effort).
    window.addEventListener("pagehide", sendLogBatch);
  }
  console.log("[KitsuneMCP] Content script loaded");
})();
