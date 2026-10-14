// InariMCP Content Script
// Runs in web pages to handle DOM interactions, clicks, typing, and element inspection
//
// Based on ClaudeCodeBrowser by Andre Watson (nanogenomic), Ligandal Inc.
// MIT License — Copyright (c) 2025
//
// Bundled with its imports into dist/content.js (scripts/build-extension.mjs),
// the manifest content script. Imported modules run before the
// __fox_injected guard below, so they must have no top-level side effects.

import { errorMessage } from "./error-message";
import { runContentCommand } from "./content/handler";
import type { ContentMessage } from "./content/types";

(function () {
  "use strict";

  // Prevent multiple injections
  if (window.__fox_injected) return;
  window.__fox_injected = true;

  // ---------------------------------------------------------------------------
  // Message handler
  // ---------------------------------------------------------------------------

  browser.runtime.onMessage.addListener(
    (
      message: unknown,
      _sender: browser.runtime.MessageSender,
      sendResponse: (response: unknown) => void,
    ): boolean => {
      runContentCommand(message as ContentMessage)
        .then(sendResponse)
        .catch((error: unknown) =>
          sendResponse({
            success: false,
            error: errorMessage(error),
          }),
        );
      return true;
    },
  );

  console.log("[InariMCP] Content script loaded");
})();
