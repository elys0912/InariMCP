// KitsuneMCP UI strings
//
// Looks up _locales/<lang>/messages.json in Firefox's UI language (English
// by default). Only text people read in the browser is localized; errors
// returned to the MCP client stay in English.
//
// Loading: classic script, loaded before background.js (manifest.json) and
// popup.js (popup.html). The content script has its own copy of this helper,
// because it is also injected on its own (early logging injection).

/** Localized message, or the key itself when it is missing. */
function t(key: string, substitutions?: string | string[]): string {
  return browser.i18n.getMessage(key, substitutions) || key;
}
