// KitsuneMCP setup state (type only)
//
// Computed by background/setup-badge.ts (getSetupState) and sent to the popup in the
// `getStatus` reply. Kept in its own file so that the popup does not depend
// on the background modules, not even for types.

/**
 * What the user has to do next, as far as the Extension can tell:
 *   hostMissing  Native Host not registered with Firefox (installer not run)
 *   hostError    Native Host registered but failed (e.g. stale node path)
 *   hostOutdated Native Host from an older checkout (no session count): tools
 *                work, but the checkout needs git pull + npm run build
 *   daemonDown   Native Host runs, but the MCP daemon does not answer
 *   noSession    all set on the Firefox side, no Claude Code session connected
 *   ready        at least one Claude Code session connected
 */
export type SetupState =
  | { kind: "connecting" }
  | { kind: "hostMissing"; error: string }
  | { kind: "hostError"; error: string }
  | { kind: "hostOutdated"; serverUrl?: string }
  | { kind: "daemonDown"; serverUrl?: string }
  | { kind: "noSession"; serverUrl?: string; registerCommand?: string }
  | { kind: "ready"; serverUrl?: string; relays: number };
