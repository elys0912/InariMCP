/**
 * Contract: the Extension's response envelope (background.ts toWireResponse)
 * puts `requestId` first.
 *
 * Why it matters: when a response frame exceeds the Native Host's incoming
 * limit, native-host/src/protocol.ts only peeks the first 4 KiB of the frame
 * to recover `"requestId":"…"` and fail that request at once instead of
 * letting it time out. That works only if requestId is serialized before the
 * (possibly huge) data.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ENV_DEFAULTS } from '@kitsune-mcp/shared';
import { readMessage } from '../../packages/native-host/src/protocol.js';
import { fakeStdin, frame, type FakeStdin } from '../../packages/native-host/tests/helpers/stdio.js';
import { loadExtensionFunction } from './helpers/extension-source.js';

type WireResponse = Record<string, unknown>;
type ToWireResponse = (requestId: number | string, result: Record<string, unknown>) => WireResponse;

let toWireResponse: ToWireResponse;

beforeAll(async () => {
  toWireResponse = await loadExtensionFunction<ToWireResponse>('background.ts', 'toWireResponse');
});

describe('toWireResponse (extension background.ts)', () => {
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

describe('toWireResponse ⇔ Native Host oversized-frame recovery', () => {
  let stdin: FakeStdin;
  beforeEach(() => { stdin = fakeStdin(); });
  afterEach(() => { stdin.restore(); });

  it('the host recovers requestId from a response over the incoming limit', async () => {
    const response = toWireResponse('big-7', {
      success: true,
      imageData: 'x'.repeat(ENV_DEFAULTS.NATIVE_MSG_MAX_INCOMING_SIZE),
    });
    stdin.stream.write(frame(response));
    const result = await readMessage();
    expect(result).toMatchObject({ kind: 'skipped', requestId: 'big-7' });
  }, 60_000);
});
