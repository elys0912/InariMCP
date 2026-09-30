/**
 * Test doubles for the Native Host's stdin / stdout.
 *
 * protocol.ts reads `process.stdin` and writes `process.stdout` directly, so
 * the tests swap `process.stdin` for a PassThrough and spy on
 * `process.stdout.write`.
 */

import { PassThrough } from 'node:stream';
import { vi } from 'vitest';

export interface FakeStdin {
  stream: PassThrough;
  restore(): void;
}

/** Replace process.stdin with a PassThrough until restore() is called. */
export function fakeStdin(): FakeStdin {
  const original = Object.getOwnPropertyDescriptor(process, 'stdin');
  const stream = new PassThrough();
  Object.defineProperty(process, 'stdin', { value: stream, configurable: true, writable: true });
  return {
    stream,
    restore(): void {
      if (original) Object.defineProperty(process, 'stdin', original);
      stream.destroy();
    },
  };
}

/** A Native Messaging length prefix (4-byte little-endian uint32). */
export function lengthPrefix(length: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(length, 0);
  return buf;
}

/** One complete frame: length prefix + payload (objects are JSON-encoded). */
export function frame(payload: Buffer | string | object): Buffer {
  const body = Buffer.isBuffer(payload)
    ? payload
    : Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf-8');
  return Buffer.concat([lengthPrefix(body.length), body]);
}

export interface CapturedStdout {
  chunks: Buffer[];
  restore(): void;
}

/** Capture everything written to process.stdout (nothing reaches the terminal). */
export function captureStdout(): CapturedStdout {
  const chunks: Buffer[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    chunks.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(String(chunk), 'utf-8'));
    return true;
  }) as typeof process.stdout.write);
  return { chunks, restore: () => spy.mockRestore() };
}
