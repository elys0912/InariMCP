/**
 * The approval floor of the headless backend: the check the Extension makes
 * of every command (extension/src/background/url-policy.ts checkApproval),
 * made right before an action runs, against the page it runs on now.
 *
 *   - an acting command runs only when it carries a human approval
 *     (BrowserCommand `approvedHost`) for the site of that page, or of the
 *     URL it opens;
 *   - a read of a page that matches the attached confirm_read_sites rules
 *     (`confirmReadUrlRules`) runs only with an approval for its site.
 *
 * The guard asks before a command is sent, for the page it last saw; this
 * floor catches a page that has moved to another site since (a redirect, a
 * script). It does not depend on the guard: with `enabled: false` in
 * safety.json the guard asks nothing, and every acting command is still
 * refused here until a human approves it.
 *
 * A refusal has the shape of the Extension's (safetyDecision
 * "confirmation_required", the page's `url`), so tools/handlers.ts opens
 * the approval request for that site the same way on both backends.
 */

import { approvalSiteOf, BrowserActionSchema, type BrowserAction, type BrowserCommand } from '@inari-mcp/shared';
import { NEW_TAB_URL } from '../safety/approval.js';
import { compileUrlPatterns, type UrlPattern } from '../safety/url-pattern.js';

/** What the floor checks before an action (the approval column of the Extension's action table). */
export type FloorCheck = 'act' | 'actOnUrl' | 'read' | 'none';

/**
 * The check of each action the headless backend runs, where it is not
 * 'act': an action left out gets the strictest check, as on the Extension
 * (UNKNOWN_ACTION). Actions the backend does not support are refused before
 * the floor. The keys are BrowserAction (shared/src/action-names.ts), so an
 * action removed there fails the type check here; tests/contract/
 * headless-approval-floor.test.ts compares the checks with the Extension's
 * action table. hover is 'act': the page's own hover handlers run.
 */
const FLOOR_CHECKS: Readonly<Partial<Record<BrowserAction, Exclude<FloorCheck, 'act'>>>> = {
  navigate: 'actOnUrl',
  create_tab: 'actOnUrl',

  screenshot: 'read',
  snapshot: 'read',
  get_page_info: 'read',
  get_elements: 'read',
  get_text: 'read',
  find_text: 'read',

  scroll: 'none',
  highlight: 'none',
  focus_tab: 'none',
  get_tabs: 'none',
  wait_for_element: 'none',
  wait_for_network_idle: 'none',
  wait_for_navigation: 'none',
  wait_for_url: 'none',
  request_approval: 'none',
  solve_captcha: 'none',
  list_containers: 'none',
  // Answered "not supported in headless mode": it opens nothing.
  open_in_container: 'none',
};

/** The floor check of `action` ('act' for a name that is no BrowserAction). */
export function floorCheckOf(action: string): FloorCheck {
  const known = BrowserActionSchema.safeParse(action);
  if (!known.success) return 'act';
  return FLOOR_CHECKS[known.data] ?? 'act';
}

/** What a command carries for the floor. */
export interface CommandApproval {
  /** The site a human approved for this call (the wire field keeps its name, BrowserCommand `approvedHost`). */
  approvedSite: string | undefined;
  /**
   * The confirm_read_sites rules attached to the command, compiled again
   * from their sources with the guard's own matcher.
   */
  readSites: UrlPattern[];
  /** Attached rules that could not be compiled: the command is refused (fail closed). */
  unusableRules: number;
}

/** The floor's view of a command from the MCP Server. */
export function commandApprovalOf(command: BrowserCommand): CommandApproval {
  const sources = (command.confirmReadUrlRules ?? []).map((rule) => rule.source);
  const { patterns } = compileUrlPatterns(sources, 'confirmRead');
  return { approvedSite: command.approvedHost, readSites: patterns, unusableRules: sources.length - patterns.length };
}

type Refusal = Record<string, unknown>;

/** The URL an opening action opens: `url`, else a blank tab. */
function urlToOpen(args: Record<string, unknown>): string {
  const url = args['url'];
  return typeof url === 'string' && url !== '' ? url : NEW_TAB_URL;
}

/** Whether `url` is on the site a human approved. */
function isApprovedSite(url: string | null, approvedSite: string | undefined): boolean {
  const site = approvalSiteOf(url);
  return site !== null && site === approvedSite;
}

/** An acting action on `url`: runs only with an approval for its site. */
function checkApprovedUrl(url: string | null, approvedSite: string | undefined): Refusal | null {
  if (isApprovedSite(url, approvedSite)) return null;
  return {
    success: false,
    safetyDecision: 'confirmation_required',
    error: 'Human approval required: an acting command runs only on the site a human approved',
    ...(url !== null ? { url } : {}),
  };
}

/** The refusal of a read on a confirm_read_sites page (`url` null: no page to check). */
function readSiteRefusal(url: string | null, matchedPattern: string | null): Refusal {
  return {
    success: false,
    safetyDecision: 'confirmation_required',
    error: 'Human approval required: the target tab is on a site of confirm_read_sites',
    ...(url !== null ? { url } : {}),
    ...(matchedPattern !== null ? { matchedPattern } : {}),
  };
}

/** A read of `url`: refused when it matches confirm_read_sites, unless approved for its site. */
function checkReadSite(url: string | null, approval: CommandApproval): Refusal | null {
  if (approval.readSites.length === 0) return null;
  // No page to compare with the rules: refused rather than read unchecked.
  if (url === null) return readSiteRefusal(null, null);

  const matched = approval.readSites.find((pattern) => pattern.test(url));
  if (matched === undefined || isApprovedSite(url, approval.approvedSite)) return null;
  return readSiteRefusal(url, matched.source);
}

/**
 * The floor's refusal of `action`, or null when it may run. `pageUrl`: the
 * URL of the page it runs on now (page.url()); null when there is none.
 */
export function floorRefusal(
  action: string,
  args: Record<string, unknown>,
  pageUrl: string | null,
  approval: CommandApproval,
): Refusal | null {
  if (approval.unusableRules > 0) {
    return {
      success: false,
      safetyDecision: 'config_error',
      error: `Refused: ${approval.unusableRules} confirm_read_sites rule(s) of the command could not be used`,
    };
  }
  const check = floorCheckOf(action);
  switch (check) {
    case 'act':
      return checkApprovedUrl(pageUrl, approval.approvedSite);
    case 'actOnUrl':
      return checkApprovedUrl(urlToOpen(args), approval.approvedSite);
    case 'read':
      return checkReadSite(pageUrl, approval);
    case 'none':
      return null;
    default: {
      const unhandled: never = check;
      throw new Error(`Unknown floor check: ${String(unhandled)}`);
    }
  }
}
