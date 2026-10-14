// Text of a WebSocket frame as the `ws` package hands it over (its RawData),
// for the daemon's ws-bridge, the Native Host's ws-client and their tests.

/**
 * The frame as UTF-8 text. `ws` gives a Buffer (binaryType "nodebuffer", the
 * default), an ArrayBuffer ("arraybuffer") or Buffer fragments ("fragments");
 * String() on the last two would give "[object ArrayBuffer]" or a
 * comma-joined list.
 */
export function frameText(raw: Buffer | ArrayBuffer | Buffer[]): string {
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf-8');
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf-8');
  return raw.toString('utf-8');
}
