/**
 * InariMCP - Consent page script
 *
 * The explicit opt-in the add-on asks for right after install: what it does,
 * what it sends and where, and what happens without consent. The answer goes
 * to the background (user-control.ts), which connects to the Native Host
 * only once it is "granted".
 */

import { localizePage, t } from '../i18n';
import { CONTROL_MESSAGE, PRIVACY_POLICY_URL, parseControlView, type ConsentState } from '../user-control';

/** Message key of the line under the text, per consent state. */
const STATE_KEYS: Record<ConsentState, string | null> = {
  undecided: null,
  granted: 'consentStateGranted',
  denied: 'consentStateDenied',
};

function showState(consent: ConsentState): void {
  const el = document.getElementById('consent-state');
  if (!el) return;

  const key = STATE_KEYS[consent];
  el.textContent = key === null ? '' : t(key);
}

async function answer(granted: boolean): Promise<void> {
  const reply = await browser.runtime
    .sendMessage({ type: CONTROL_MESSAGE.SET_CONSENT, granted })
    .catch(() => null);
  const control = parseControlView(reply);
  if (control === null) {
    const el = document.getElementById('consent-state');
    if (el) el.textContent = t('consentStateFailed');
    return;
  }

  showState(control.consent);
}

async function init(): Promise<void> {
  localizePage();
  const link = document.getElementById('privacy-link') as HTMLAnchorElement | null;
  if (link) link.href = PRIVACY_POLICY_URL;
  document.getElementById('btn-allow')?.addEventListener('click', () => { void answer(true); });
  document.getElementById('btn-deny')?.addEventListener('click', () => { void answer(false); });

  // Opened again later: show what was chosen before.
  const control = parseControlView(
    await browser.runtime.sendMessage({ type: CONTROL_MESSAGE.GET }).catch(() => null),
  );
  if (control !== null) showState(control.consent);
}

document.addEventListener('DOMContentLoaded', () => { void init(); });
