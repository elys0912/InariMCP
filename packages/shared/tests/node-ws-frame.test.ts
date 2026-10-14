import { describe, expect, it } from 'vitest';
import { frameText } from '@inari-mcp/shared/node';

describe('frameText', () => {
  it('reads a Buffer as UTF-8', () => {
    expect(frameText(Buffer.from('{"a":"é"}'))).toBe('{"a":"é"}');
  });

  it('reads an ArrayBuffer as its bytes, not "[object ArrayBuffer]"', () => {
    const bytes = new TextEncoder().encode('{"a":1}');
    const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    expect(frameText(arrayBuffer)).toBe('{"a":1}');
  });

  it('joins Buffer fragments without separators, even inside a multi-byte character', () => {
    const whole = Buffer.from('{"a":"é"}');
    const cut = whole.indexOf(0xa9);
    expect(frameText([whole.subarray(0, cut), whole.subarray(cut)])).toBe('{"a":"é"}');
  });
});
