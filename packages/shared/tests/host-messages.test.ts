import { describe, expect, it } from 'vitest';
import { parseHostMessage } from '@inari-mcp/shared';

describe('parseHostMessage (4.C5)', () => {
  it('accepts the host-local messages and rejects a screenshot without image data', () => {
    expect(parseHostMessage({ action: 'ping', requestId: 1 })).toMatchObject({ ok: true, message: { action: 'ping', requestId: 1 } });
    expect(parseHostMessage({ action: 'saveScreenshot', data: { imageData: 'data:image/png;base64,AA' }, filename: 7 }))
      .toMatchObject({ ok: true, message: { filename: undefined } });
    expect(parseHostMessage({ action: 'screenshotTaken', data: 42 })).toMatchObject({ ok: false, action: 'screenshotTaken' });
    expect(parseHostMessage({ requestId: '1', success: true })).toMatchObject({ ok: false, action: undefined });
    for (const action of ['constructor', '__proto__', 'toString']) {
      expect(parseHostMessage({ action })).toMatchObject({ ok: false, action: undefined });
    }
  });
  // host.ts replies through processMessage: packages/native-host/tests/host.test.ts
});
