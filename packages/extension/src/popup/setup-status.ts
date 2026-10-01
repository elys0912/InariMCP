// The setup state the popup shows, from the background's answer to its
// `status` request (pure; imported by popup.ts, tested from tests/contract).

import type { SetupState } from '../types/setup';

/**
 * The state in a `status` reply. A reply without one is "connecting" (the
 * popup polls again); a failed reply is a host error with its text.
 */
export function setupStateOfReply(reply: unknown): SetupState {
  if (typeof reply !== 'object' || reply === null) return { kind: 'connecting' };
  const r = reply as { success?: unknown; setup?: unknown; error?: unknown };
  if (typeof r.setup === 'object' && r.setup !== null && typeof (r.setup as { kind?: unknown }).kind === 'string') {
    return r.setup as SetupState;
  }
  if (r.success === false) {
    return {
      kind: 'hostError',
      error: typeof r.error === 'string' && r.error !== '' ? r.error : 'The status request failed',
    };
  }
  return { kind: 'connecting' };
}

/**
 * The background did not answer at all (sendMessage rejected): shown as an
 * error with the reason, not as "connecting", which would never end.
 */
export function setupStateOfFailure(error: unknown): SetupState {
  const reason = error instanceof Error ? error.message : String(error);
  return { kind: 'hostError', error: `The extension background did not answer: ${reason}` };
}
