import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ENV_DEFAULTS } from '@inari-mcp/shared';
import { readMessage, sendMessage } from '../src/protocol.js';
import {
  captureStdout,
  fakeStdin,
  frame,
  lengthPrefix,
  type CapturedStdout,
  type FakeStdin,
} from './helpers/stdio.js';

const MAX_OUTGOING = ENV_DEFAULTS.NATIVE_MSG_MAX_SIZE; // host → extension, 1 MiB
const MAX_INCOMING = ENV_DEFAULTS.NATIVE_MSG_MAX_INCOMING_SIZE; // extension → host, 64 MiB

/** `{"p":"xxx…"}` whose UTF-8 encoding is exactly `bytes` long. */
function messageOfSize(bytes: number): { p: string } {
  return { p: 'x'.repeat(bytes - '{"p":""}'.length) };
}

describe('readMessage (extension → host)', () => {
  let stdin: FakeStdin;
  beforeEach(() => { stdin = fakeStdin(); });
  afterEach(() => { stdin.restore(); });

  it('decodes a length-prefixed (uint32 LE) JSON object', async () => {
    stdin.stream.write(frame({ requestId: '1', success: true }));
    await expect(readMessage()).resolves.toEqual({
      kind: 'message',
      message: { requestId: '1', success: true },
    });
  });

  it('reads consecutive frames, also when split across chunks', async () => {
    const both = Buffer.concat([frame({ n: 1 }), frame({ n: 2 })]);
    stdin.stream.write(both.subarray(0, 3));
    const first = readMessage();
    stdin.stream.write(both.subarray(3));
    await expect(first).resolves.toEqual({ kind: 'message', message: { n: 1 } });
    await expect(readMessage()).resolves.toEqual({ kind: 'message', message: { n: 2 } });
  });

  it('decodes the payload as UTF-8 (length counts bytes, not characters)', async () => {
    stdin.stream.write(frame({ t: 'キツネ' }));
    await expect(readMessage()).resolves.toEqual({ kind: 'message', message: { t: 'キツネ' } });
  });

  it('reports eof when stdin closes', async () => {
    stdin.stream.end();
    await expect(readMessage()).resolves.toEqual({ kind: 'eof' });
  });

  it('reports eof on a truncated length prefix', async () => {
    stdin.stream.end(Buffer.from([1, 0]));
    await expect(readMessage()).resolves.toEqual({ kind: 'eof' });
  });

  it('reports eof on a truncated body', async () => {
    stdin.stream.end(Buffer.concat([lengthPrefix(10), Buffer.from('{"a"')]));
    await expect(readMessage()).resolves.toEqual({ kind: 'eof' });
  });

  it('skips an empty frame and stays in sync', async () => {
    stdin.stream.write(Buffer.concat([lengthPrefix(0), frame({ ok: 1 })]));
    await expect(readMessage()).resolves.toEqual({ kind: 'skipped', reason: 'empty frame' });
    await expect(readMessage()).resolves.toEqual({ kind: 'message', message: { ok: 1 } });
  });

  it('skips invalid JSON, recovering a string requestId from the head', async () => {
    stdin.stream.write(Buffer.concat([frame('{"requestId":"42","x":'), frame({ ok: 1 })]));
    const skipped = await readMessage();
    expect(skipped).toMatchObject({ kind: 'skipped', requestId: '42' });
    await expect(readMessage()).resolves.toEqual({ kind: 'message', message: { ok: 1 } });
  });

  it.each([['[1,2]'], ['"text"'], ['null']])('skips a non-object payload %s', async (json) => {
    stdin.stream.write(frame(json));
    await expect(readMessage()).resolves.toEqual({
      kind: 'skipped',
      reason: 'incoming message is not a JSON object',
    });
  });

  it('accepts a frame of exactly the incoming limit (64 MiB)', async () => {
    stdin.stream.write(frame(messageOfSize(MAX_INCOMING)));
    const result = await readMessage();
    expect(result.kind).toBe('message');
  }, 60_000);

  it('skips a frame over the incoming limit, drains it, keeps the requestId, stays in sync', async () => {
    const size = MAX_INCOMING + 1;
    const head = Buffer.from('{"requestId":"big-1","data":"', 'utf-8');
    const body = Buffer.alloc(size, 0x78);
    head.copy(body, 0);
    stdin.stream.write(Buffer.concat([lengthPrefix(size), body, frame({ after: true })]));

    const skipped = await readMessage();
    expect(skipped).toMatchObject({ kind: 'skipped', requestId: 'big-1' });
    if (skipped.kind === 'skipped') expect(skipped.reason).toMatch(/too large/);
    await expect(readMessage()).resolves.toEqual({ kind: 'message', message: { after: true } });
  }, 60_000);

  it('reports eof when an oversized frame ends before it is drained', async () => {
    stdin.stream.end(Buffer.concat([lengthPrefix(MAX_INCOMING + 1), Buffer.alloc(8_192, 0x78)]));
    await expect(readMessage()).resolves.toEqual({ kind: 'eof' });
  });
});

describe('sendMessage (host → extension)', () => {
  let stdout: CapturedStdout;
  beforeEach(() => { stdout = captureStdout(); });
  afterEach(() => { stdout.restore(); });

  it('writes a 4-byte LE length prefix followed by the UTF-8 JSON payload', () => {
    const msg = { requestId: '1', t: 'キツネ' };
    expect(sendMessage(msg)).toBe(true);
    const out = Buffer.concat(stdout.chunks);
    const payload = Buffer.from(JSON.stringify(msg), 'utf-8');
    expect(out.readUInt32LE(0)).toBe(payload.length);
    expect(out.subarray(4)).toEqual(payload);
  });

  it('accepts a payload of exactly 1 MiB', () => {
    expect(sendMessage(messageOfSize(MAX_OUTGOING))).toBe(true);
    const out = Buffer.concat(stdout.chunks);
    expect(out.readUInt32LE(0)).toBe(MAX_OUTGOING);
    expect(out.length).toBe(4 + MAX_OUTGOING);
  });

  it('refuses a payload over 1 MiB and writes nothing', () => {
    expect(sendMessage(messageOfSize(MAX_OUTGOING + 1))).toBe(false);
    expect(stdout.chunks).toHaveLength(0);
  });
});
