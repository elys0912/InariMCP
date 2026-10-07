// The setup state the popup shows, from the background's answer to its
// `status` request (pure; imported by popup.ts, tested from tests/contract).

import { errorMessage } from '../error-message';
import type { SetupState } from '../types/setup';

/**
 * The state in a `status` reply. A reply without one is "connecting" (the
 * popup polls again); a failed reply is a host error with its text.
 */
export function setupStateOfReply(reply: unknown): SetupState {
  if (typeof reply !== 'object' || reply === null) return { kind: 'connecting' };
  const r = reply as { success?: unknown; setup?: unknown; error?: unknown };
  if (isSetupState(r.setup)) return r.setup;
  if (r.success === false) {
    return {
      kind: 'hostError',
      error: typeof r.error === 'string' && r.error !== '' ? r.error : 'The status request failed',
    };
  }
  return { kind: 'connecting' };
}

/**
 * A setup state as the background sends it: an object with a string `kind`.
 * Only the kind's type is checked, not its value -- the reply comes from the
 * background of the same build (background/setup-badge.ts getSetupState).
 */
function isSetupState(value: unknown): value is SetupState {
  return typeof value === 'object' && value !== null && typeof (value as { kind?: unknown }).kind === 'string';
}

/**
 * The background did not answer at all (sendMessage rejected): shown as an
 * error with the reason, not as "connecting", which would never end.
 */
export function setupStateOfFailure(error: unknown): SetupState {
  const reason = errorMessage(error);
  return { kind: 'hostError', error: `The extension background did not answer: ${reason}` };
}
