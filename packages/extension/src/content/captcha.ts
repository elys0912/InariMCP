// Captcha detection and the wait for the human to solve it.

import { t } from "../i18n";
import { CAPTCHA_BANNER_ID, TIMEOUTS } from "./constants";
import { BANNER_SUPERSEDED, closeOverlayBanner, createOverlayBanner } from "./overlay";
import type { CaptchaWidget, CaptchaOptions } from "./types";

function detectCaptcha(): { present: boolean; widgets: CaptchaWidget[] } {
  const widgets: CaptchaWidget[] = [];

  function hasResponseToken(name: string): boolean {
    const el = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      `textarea[name="${CSS.escape(name)}"], input[name="${CSS.escape(name)}"]`,
    );
    return !!(el && el.value && el.value.length > 0);
  }

  if (
    document.querySelector(
      '.g-recaptcha, iframe[src*="recaptcha"], #g-recaptcha-response',
    )
  ) {
    widgets.push({
      type: "recaptcha",
      solved:
        hasResponseToken("g-recaptcha-response") ||
        !!document.querySelector(".recaptcha-checkbox-checked"),
    });
  }
  if (
    document.querySelector(
      '.h-captcha, iframe[src*="hcaptcha"], textarea[name="h-captcha-response"]',
    )
  ) {
    widgets.push({
      type: "hcaptcha",
      solved: hasResponseToken("h-captcha-response"),
    });
  }
  if (
    document.querySelector(
      '.cf-turnstile, iframe[src*="challenges.cloudflare.com"], input[name="cf-turnstile-response"]',
    )
  ) {
    widgets.push({
      type: "turnstile",
      solved: hasResponseToken("cf-turnstile-response"),
    });
  }
  if (
    widgets.length === 0 &&
    document.querySelector(
      'img[src*="captcha" i], input[name*="captcha" i], [id*="captcha" i], [class*="captcha" i]',
    )
  ) {
    widgets.push({ type: "generic", solved: null });
  }

  return { present: widgets.length > 0, widgets };
}

export async function solveCaptcha(
  options: CaptchaOptions = {},
): Promise<Record<string, unknown>> {
  const detection = detectCaptcha();
  if (options.detectOnly) {
    return { success: true, ...detection };
  }
  if (!detection.present) {
    return {
      success: true,
      present: false,
      message: "No captcha detected on the page.",
    };
  }
  if (detection.widgets.every((w) => w.solved === true)) {
    return {
      success: true,
      present: true,
      solved: true,
      message: "Captcha already solved.",
      widgets: detection.widgets,
    };
  }

  const timeoutMs = options.timeout || TIMEOUTS.CAPTCHA;
  const start = Date.now();
  const types = detection.widgets.map((w) => w.type).join(", ");

  // Start the banner (resolves on button click or timeout)
  const bannerPromise = createOverlayBanner({
    id: CAPTCHA_BANNER_ID,
    title: t("bannerCaptchaTitle", types),
    detail: t("bannerCaptchaDetail"),
    buttons: [
      { label: t("bannerDone"), value: "done", color: "#ffd166", textColor: "#0f3460" },
      { label: t("bannerCancel"), value: "cancel", color: "transparent", textColor: "#fff" },
    ],
    timeoutMs,
    borderColor: "#ffd166",
    background: "#0f3460",
  });

  // Poll for token resolution concurrently
  const pollPromise = new Promise<string>((resolve) => {
    const poll = setInterval(() => {
      const now = detectCaptcha();
      const tokened = now.widgets.filter((w) => w.solved !== null);
      if (tokened.length && tokened.every((w) => w.solved === true)) {
        clearInterval(poll);
        resolve("token");
      }
    }, 1000);
    // Clean up poll when banner resolves first
    bannerPromise.then(() => clearInterval(poll));
  });

  const result = await Promise.race([bannerPromise, pollPromise]);
  // Poll won the race: close the banner through its finish(), so that it is
  // no longer registered (a later cancelHumanWait must not report a banner
  // that is gone). No-op when the banner settled the race itself.
  if (result === "token") closeOverlayBanner(CAPTCHA_BANNER_ID, "token");

  const base = { success: true, present: true, elapsedMs: Date.now() - start };

  if (result === "token") {
    return { ...base, solved: true, resolvedBy: "token", widgets: detectCaptcha().widgets };
  } else if (result === "done") {
    return { ...base, solved: true, resolvedBy: "human", widgets: detectCaptcha().widgets };
  } else if (result === "cancel") {
    return { ...base, solved: false, cancelled: true };
  } else if (result === BANNER_SUPERSEDED) {
    return {
      ...base,
      solved: false,
      superseded: true,
      message: "Another captcha wait started in this tab and replaced this one.",
    };
  } else {
    // timeout
    return { ...base, solved: false, timedOut: true, widgets: detectCaptcha().widgets };
  }
}
