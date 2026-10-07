/**
 * Contract: the Extension's response envelope (background/wire.ts toWireResponse)
 * puts `requestId` first.
 *
 * Why it matters: when a response frame exceeds the Native Host's incoming
 * limit, native-host/src/protocol.ts only peeks the first 4 KiB of the frame
 * to recover `"requestId":"…"` and fail that request at once instead of
 * letting it time out. That works only if requestId is serialized before the
 * (possibly huge) data. The recovery from such a frame is checked in
 * packages/native-host/tests/protocol.test.ts (readMessage); this file checks
 * that every response starts with requestId.
 */

import { beforeAll, describe, expect, it } from 'vitest';

type WireResponse = Record<string, unknown>;
type ToWireResponse = (requestId: number | string, result: Record<string, unknown>) => WireResponse;

let toWireResponse: ToWireResponse;

beforeAll(async () => {
  // The test feeds plain records (not CommandResult): typed by its own alias.
  toWireResponse = (await import('../../packages/extension/src/background/wire.ts')).toWireResponse as unknown as ToWireResponse;
});

describe('toWireResponse (extension background/wire.ts)', () => {
  it.each([
    ['success with data', { success: true, url: 'https://example.test/', title: 't' }],
    ['failure', { success: false, error: 'boom' }],
    ['safety refusal', { safetyDecision: 'out_of_scope', success: false, error: 'no' }],
    ['result that lists data keys first', { imageData: 'x', title: 't', success: true }],
  ])('puts requestId first: %s', (_label, result) => {
    const response = toWireResponse('req-1', result);
    expect(Object.keys(response)[0]).toBe('requestId');
    expect(JSON.stringify(response).startsWith('{"requestId":"req-1",')).toBe(true);
  });

  it('keeps success / error / safetyDecision top-level and moves the rest into data', () => {
    expect(
      toWireResponse('1', {
        success: false,
        error: 'e',
        safetyDecision: 'confirmation_required',
        url: 'https://example.test/',
      }),
    ).toEqual({
      requestId: '1',
      success: false,
      error: 'e',
      safetyDecision: 'confirmation_required',
      data: { url: 'https://example.test/' },
    });
  });

  it('omits data when nothing is left', () => {
    expect(toWireResponse('1', { success: true })).toEqual({ requestId: '1', success: true });
  });
});
