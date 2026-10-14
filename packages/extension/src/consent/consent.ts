/**
 * InariMCP - Consent page script
 *
 * The explicit opt-in the add-on asks for right after install: what it does,
 * what it sends and where, and what happens without consent. The answer goes
 * to the background (background/control-state.ts holds it; the messages are
 * in user-control.ts), which connects to the Native Host only once it is
 * "granted" (background/native-connection.ts setConnectionAllowed).
 */

import { localizePage, t } from '../i18n';
import { CONTROL_MESSAGE, privacyPolicyUrl, requestControl, type ConsentState } from '../user-control';

/** Message key of the line under the text, per consent state. */
const STATE_KEYS: Record<ConsentState, string | null> = {
  undecided: null,
  granted: 'consentStateGranted',
  denied: 'consentStateDenied',
};

/** The line under the text. */
function setStateText(text: string): void {
  const el = document.getElementById('consent-state');
  if (el) el.textContent = text;
}

function showState(consent: ConsentState): void {
  const key = STATE_KEYS[consent];
  setStateText(key === null ? '' : t(key));
}

async function answer(granted: boolean): Promise<void> {
  const control = await requestControl({ type: CONTROL_MESSAGE.SET_CONSENT, granted });
  if (control === null) {
    setStateText(t('consentStateFailed'));
    return;
  }

  showState(control.consent);
}

async function init(): Promise<void> {
  localizePage();
  const link = document.getElementById('privacy-link') as HTMLAnchorElement | null;
  if (link) link.href = privacyPolicyUrl(browser.i18n.getUILanguage());
  document.getElementById('btn-allow')?.addEventListener('click', () => { void answer(true); });
  document.getElementById('btn-deny')?.addEventListener('click', () => { void answer(false); });

  // Opened again later: show what was chosen before.
  const control = await requestControl({ type: CONTROL_MESSAGE.GET });
  if (control !== null) showState(control.consent);
}

document.addEventListener('DOMContentLoaded', () => { void init(); });
