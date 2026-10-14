// InariMCP Background Script
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
//   L0 types / constants / wire / control-state
//   L1 tab-target / tab-wait / native-connection
//   L2 setup-badge / url-policy / container-scope
//   L3 approvals / screenshot / tabs / navigation / reload / page-actions
//   L4 human-wait / action-table / dispatch
//   L5 listeners / context-menu
// native-connection reaches the dispatcher, the approvals and the badge only
// through the hooks set here.
//
// Nothing connects to the Native Host until the user allowed it on the
// consent page (user-control.ts): the saved choice is read first.

import { cancelAllApprovals } from "./background/approvals";
import { registerContextMenus } from "./background/context-menu";
import { loadControlState, setControlHook, type ControlChange } from "./background/control-state";
import { handleCommand } from "./background/dispatch";
import { registerListeners } from "./background/listeners";
import { setConnectionHooks, setConnectionAllowed, recheckHost } from "./background/native-connection";
import { refreshBadge, refreshSetupState, SETUP_REFRESH_MS } from "./background/setup-badge";
import type { ControlView } from "./user-control";

/**
 * Apply the consent and the pause switch: connect only with consent (and
 * disconnect when it is withdrawn); pausing withdraws the open approval
 * requests, since every new command is refused from then on.
 */
function applyControl(view: ControlView, change: ControlChange): void {
  if (change === "consent") {
    const allowed = view.consent === "granted";
    setConnectionAllowed(allowed);
    if (allowed) recheckHost();
  } else if (view.paused) {
    cancelAllApprovals();
  }
  refreshBadge();
}

// The hooks first: connecting (below) is what can make them fire.
// Listeners and context menus are registered synchronously at load time.
setConnectionHooks({
  onCommand: (message) => { void handleCommand(message, "host"); },
  onConfirmed: () => { void refreshSetupState(); },
  onDisconnected: () => {
    cancelAllApprovals();
    void refreshSetupState();
  },
});
setControlHook(applyControl);
registerListeners();
registerContextMenus();
refreshBadge();
void loadControlState().then((view) => { applyControl(view, "consent"); });
// Session count changes without any event reaching the Extension.
setInterval(() => { void refreshSetupState(); }, SETUP_REFRESH_MS);
console.log("[InariMCP] Background script initialized");
