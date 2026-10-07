// KitsuneMCP Background Script
// Handles native messaging, tab management, and coordination with content scripts
//
// Based on ClaudeCodeBrowser by Andre Watson (nanogenomic), Ligandal Inc.
// MIT License — Copyright (c) 2025
//
// Bundled with its imports into dist/background.js (scripts/build-extension.mjs).
//
// Entry: the modules under background/ have no top-level side effects; this
// file wires them together and starts the background at load time.
// Layers (a module imports only from lower ones):
//   L0 types / constants / wire / log-records
//   L1 tab-target / tab-wait / native-connection
//   L2 setup-badge / url-policy / container-scope
//   L3 approvals / screenshot / tabs / navigation / reload / page-actions / logging
//   L4 human-wait / action-table / dispatch
//   L5 listeners / context-menu
// native-connection reaches the dispatcher, the approvals and the badge only
// through the hooks set here.

import { cancelAllApprovals } from "./background/approvals";
import { registerContextMenus } from "./background/context-menu";
import { handleCommand } from "./background/dispatch";
import { registerListeners } from "./background/listeners";
import { setConnectionHooks, connectNativeHost } from "./background/native-connection";
import { refreshSetupState, BADGE_COLOR, SETUP_REFRESH_MS } from "./background/setup-badge";

// The hooks first: connectNativeHost (below) is what can make them fire.
// Listeners and context menus are registered synchronously at load time.
setConnectionHooks({
  onCommand: (message) => { void handleCommand(message, "host"); },
  onConfirmed: () => { void refreshSetupState(); },
  onDisconnected: () => {
    cancelAllApprovals();
    void refreshSetupState();
  },
});
registerListeners();
registerContextMenus();
browser.browserAction.setBadgeBackgroundColor({ color: BADGE_COLOR }).catch(() => {});
connectNativeHost();
// Session count changes without any event reaching the Extension.
setInterval(() => { void refreshSetupState(); }, SETUP_REFRESH_MS);
console.log("[KitsuneMCP] Background script initialized");
