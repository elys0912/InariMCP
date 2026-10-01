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

  function capture(): { sink: NodeJS.WriteStream; written: string[] } {
    const written: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _enc, done) { written.push(chunk.toString()); done(); },
    }) as unknown as NodeJS.WriteStream;
    installStderrTimestamps(sink, () => 'T ');
    return { sink, written };
  }

  it('passes the write callback through, with or without an encoding', async () => {
    const { sink, written } = capture();
    await new Promise<void>((resolve) => sink.write('a\n', () => resolve()));
    await new Promise<void>((resolve) => sink.write('b\n', 'utf8', () => resolve()));
    expect(written.join('')).toBe('T a\nT b\n');
  });

  it('keeps a string written with a text encoding (latin1, utf16le, ascii) as the text it is', () => {
    const { sink, written } = capture();
    const cafe = 'caf' + String.fromCharCode(0xe9) + '\n';
    sink.write(cafe, 'latin1');
    sink.write(cafe, 'utf16le');
    sink.write('plain\n', 'ascii');
    expect(written.join('')).toBe(`T ${cafe}T ${cafe}T plain\n`);
    expect(written.join('')).not.toContain('�');
  });

  it('decodes a string written as hex / base64 bytes before stamping it', () => {
    const { sink, written } = capture();
    sink.write(Buffer.from('hi\n').toString('hex'), 'hex');
    sink.write(Buffer.from('caf' + String.fromCharCode(0xe9) + '\n', 'utf-8').toString('base64'), 'base64');
    expect(written.join('')).toBe('T hi\nT caf' + String.fromCharCode(0xe9) + '\n');
  });

  it('stamps CRLF lines once and keeps the CR; a lone CR is no line break', () => {
    const { sink, written } = capture();
    sink.write('one\r\ntwo\r\n');
    sink.write('progress\rdone\n');
    expect(written.join('')).toBe('T one\r\nT two\r\nT progress\rdone\n');
  });
});
