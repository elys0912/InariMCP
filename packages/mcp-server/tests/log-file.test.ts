import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { installStderrTimestamps, stampLines } from '../src/utils/log-file.js';

describe('daemon.log timestamps', () => {
  it('stamps every line once, also when a line is written in pieces', () => {
    let state = stampLines('a\nb\n', true, 'T ');
    expect(state).toEqual({ text: 'T a\nT b\n', atLineStart: true });
    state = stampLines('par', state.atLineStart, 'T ');
    state = stampLines('t\nnext', state.atLineStart, 'U ');
    expect(state).toEqual({ text: 't\nU next', atLineStart: false });
  });

  it('wraps a stream: strings and buffers arrive stamped', () => {
    const written: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _enc, done) { written.push(chunk.toString()); done(); },
    }) as unknown as NodeJS.WriteStream;
    installStderrTimestamps(sink, () => '2026-01-01T00:00:00.000Z [1] ');
    sink.write('[KitsuneMCP:daemon] up\n');
    sink.write(Buffer.from('two\nlines\n'));
    expect(written.join('')).toBe(
      '2026-01-01T00:00:00.000Z [1] [KitsuneMCP:daemon] up\n' +
      '2026-01-01T00:00:00.000Z [1] two\n2026-01-01T00:00:00.000Z [1] lines\n',
    );
  });

  // TODO(test): write callbacks / non-utf8 string encodings are passed through; CRLF input
});
