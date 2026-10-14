// The site a human approval is bound to: the one rule of the MCP Server
// (mcp-server safety/approval.ts, which binds the approval) and the Extension
// (approval.ts isApprovedSite, which checks it against the real tab).
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
