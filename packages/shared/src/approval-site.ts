// The site a human approval is bound to: the one rule of the MCP Server
// (mcp-server safety/approval.ts, which binds the approval), the Extension
// (background/url-policy.ts, which checks it against the real tab) and the
// headless backend's floor (mcp-server headless/approval-floor.ts, which
// checks it against the page an action runs on).
//
// Zod-free and import-free on purpose: the Extension bundles this module
// (scripts/build-extension.mjs SHARED_ENTRIES).

/** A hostname as both sides compare it: lower case, without a trailing dot (`Example.COM.` → `example.com`). */
export function bareHost(host: string): string {
  return host.toLowerCase().replace(/\.$/, '');
}

/**
 * The site an approval is bound to: the bare hostname of an absolute URL, or
 * its scheme when it has no hostname, so that a local test page or a new
 * blank tab can be approved too. Null when `url` is not an absolute URL.
 *
 *   https://Pay.Example.TEST:8443/x  → pay.example.test
 *   file:///tmp/page.html            → file:
 *   about:blank                      → about:
 *   (target tab), '', null           → null
 */
export function approvalSiteOf(url: string | null | undefined): string | null {
  if (typeof url !== 'string' || url === '') return null;
  try {
    const parsed = new URL(url);
    const site = bareHost(parsed.hostname);
    return site === '' ? parsed.protocol : site;
  } catch {
    return null;
  }
}

/** The page a new tab opened without a URL shows (the Extension and the headless backend open the same). */
export const NEW_TAB_URL = 'about:blank';

/** The URL an opening command opens: its `url` argument, else a blank tab (NEW_TAB_URL). */
export function urlToOpen(url: unknown): string {
  return typeof url === 'string' && url !== '' ? url : NEW_TAB_URL;
}

/**
 * Whether an approved call may run on this URL (the target tab's, or the URL
 * a new tab opens): its site (approvalSiteOf, the rule the MCP Server binds
 * the approval with) equals the site the human approved (the command's
 * `approvedHost`), compared as bare hostnames, so `example.com.` is the
 * approved `example.com`.
 */
export function isApprovedSite(url: string | null | undefined, approvedSite: unknown): boolean {
  if (typeof approvedSite !== 'string' || approvedSite === '') return false;
  const site = approvalSiteOf(url);
  return site !== null && site === bareHost(approvedSite);
}

/** The refusal text of an acting command without an approval for the site it acts on. */
export const ACT_APPROVAL_REQUIRED_MESSAGE =
  'Human approval required: an acting command runs only on the site a human approved';

/** The refusal text of a read of a confirm_read_sites page without an approval for its site. */
export const READ_APPROVAL_REQUIRED_MESSAGE =
  'Human approval required: the target tab is on a site of confirm_read_sites';
