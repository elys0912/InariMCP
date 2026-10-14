// InariMCP UI strings
//
// Looks up _locales/<lang>/messages.json in Firefox's UI language (English
// by default). Only text people read in the browser is localized; errors
// returned to the MCP client stay in English.
//
// Imported by the background modules, popup.ts, consent.ts and the content
// script (content/captcha.ts). Keep it without top-level side effects:
// content.js runs its imports on every injection, before its __fox_injected
// guard.

/** Localized message, or the key itself when it is missing. */
export function t(key: string, substitutions?: string | string[]): string {
  return browser.i18n.getMessage(key, substitutions) || key;
}

/** Extension pages: fill every [data-i18n] element with its localized message. */
export function localizePage(): void {
  document.documentElement.lang = browser.i18n.getUILanguage();
  document.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => {
    const key = el.dataset.i18n;
    if (key) el.textContent = t(key);
  });
}
