// Overlay banner on the page (used by the captcha wait), and its
// cancellation by cancel_human_wait.

import { CAPTCHA_BANNER_ID } from "./constants";

/**
 * Value a banner resolves with when a newer banner with the same id
 * replaces it.
 */
export const BANNER_SUPERSEDED = "superseded";

/** finish() of each banner on screen, by banner id. */
const activeBanners = new Map<string, (value: string) => void>();

/**
 * Close the banner `id` (if one is open), resolving its promise with
 * `value`. Returns whether a banner was closed. Closing goes through the
 * banner's finish(), so its entry, timer and DOM go together.
 */
export function closeOverlayBanner(id: string, value: string): boolean {
  const finish = activeBanners.get(id);
  if (!finish) return false;
  finish(value);
  return true;
}

/**
 * The server stopped waiting (cancel_human_wait): close the captcha banner
 * as if it had timed out, so a late click cannot look like an answer.
 * (Approval requests are never shown in the page: the background keeps
 * them for the toolbar popup.)
 */
export function cancelHumanWait(): Record<string, unknown> {
  const cancelled = closeOverlayBanner(CAPTCHA_BANNER_ID, "timeout");
  return { success: true, cancelled };
}

export function createOverlayBanner(config: {
  id: string;
  title: string;
  detail?: string;
  buttons: Array<{ label: string; value: string; color: string; textColor?: string }>;
  timeoutMs: number;
  borderColor: string;
  background: string;
}): Promise<string> {
  return new Promise((resolve) => {
    // A banner with this id is still open: settle its promise first (it
    // would otherwise wait for its own timeout, out of reach of
    // cancelHumanWait), then drop any stray element with the id.
    closeOverlayBanner(config.id, BANNER_SUPERSEDED);
    const existing = document.getElementById(config.id);
    if (existing) existing.remove();

    const banner = document.createElement("div");
    banner.id = config.id;
    banner.style.cssText = [
      "position:fixed",
      "top:0",
      "left:0",
      "right:0",
      "z-index:2147483647",
      `background:${config.background}`,
      "color:#fff",
      "padding:14px 20px",
      "font:14px/1.5 system-ui,sans-serif",
      "display:flex",
      "align-items:center",
      "gap:16px",
      "box-shadow:0 2px 12px rgba(0,0,0,.4)",
      `border-bottom:3px solid ${config.borderColor}`,
    ].join(";");

    const textWrap = document.createElement("div");
    textWrap.style.cssText = "flex:1;min-width:0";
    const titleEl = document.createElement("div");
    titleEl.style.cssText = "font-weight:600";
    titleEl.textContent = config.title;
    textWrap.appendChild(titleEl);
    if (config.detail) {
      const detailEl = document.createElement("div");
      detailEl.style.cssText =
        "font-size:12px;opacity:.8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
      detailEl.textContent = config.detail;
      textWrap.appendChild(detailEl);
    }

    banner.appendChild(textWrap);

    let settled = false;
    function finish(value: string): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (activeBanners.get(config.id) === finish) activeBanners.delete(config.id);
      banner.remove();
      resolve(value);
    }
    activeBanners.set(config.id, finish);

    for (const btn of config.buttons) {
      const b = document.createElement("button");
      b.textContent = btn.label;
      const tc = btn.textColor || "#fff";
      b.style.cssText =
        "padding:8px 18px;border:none;border-radius:6px;cursor:pointer;" +
        `font:600 13px system-ui,sans-serif;color:${tc};background:${btn.color}`;
      b.addEventListener("click", () => finish(btn.value));
      banner.appendChild(b);
    }

    (document.body || document.documentElement).appendChild(banner);
    const timer = setTimeout(() => finish("timeout"), config.timeoutMs);
  });
}
