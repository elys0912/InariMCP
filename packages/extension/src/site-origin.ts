// The origin an acting command was approved on: the scheme, host and port of
// a URL. The background takes it from the target tab's URL when it checks the
// human approval (background/dispatch.ts); the content script takes it from
// its page's location just before it acts (content/handler.ts). A mismatch
// means the tab went to another page in between. Pure; bundled into both.

/**
 * `scheme://host[:port]` of `url` (the host lower-case, the port only when it
 * is not the scheme's default), or null when `url` is not an absolute URL.
 * Unlike URL#origin it is never "null": `file:///a` gives `file://`,
 * `about:blank` gives `about://`.
 */
export function approvalOriginOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}
