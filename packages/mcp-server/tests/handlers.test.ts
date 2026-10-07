/**
 * tools/handlers.ts: what the tests of the result format, the safety
 * metadata and the guard do not cover (R3 G-21 (b), §4 mimeTypeFor).
 *
 * The deprecation notice is reported once per name and process
 * (module state): no other test in this file calls fox_get_text.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { BrowserResponse } from '@kitsune-mcp/shared';
import { createToolHandler } from '../src/tools/handlers.js';
import { getConnectionManager } from '../src/connection/manager.js';

/** Answer every sendCommand() with `response`, without any browser. */
function stubBrowser(response: Partial<BrowserResponse>): void {
  vi.spyOn(getConnectionManager(), 'sendCommand').mockImplementation(
    async (command) => ({ requestId: command.requestId, success: true, ...response }) as BrowserResponse,
  );
}

const texts = (r: CallToolResult): string[] => r.content.map((c) => (c.type === 'text' ? c.text : ''));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a call by a deprecated name', () => {
  it('gets the note at the end of its result and on stderr, once per name', async () => {
    stubBrowser({ success: true, data: { text: 'hello' } });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const note = "fox_get_text is deprecated; use fox_read with mode='text'.";

    const first = await createToolHandler('fox_get_text')({});
    expect(texts(first).at(-1)).toBe(`Note: ${note}`);

    const second = await createToolHandler('fox_get_text')({});
    expect(texts(second).some((t) => t.startsWith('Note: '))).toBe(false);

    const lines = stderr.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('deprecated'));
    expect(lines).toEqual([`[KitsuneMCP] ${note}\n`]);
  });

  it('a current name gets no note', async () => {
    stubBrowser({ success: true, data: { text: 'hello' } });
    const result = await createToolHandler('fox_read')({ mode: 'text' });
    expect(texts(result).some((t) => t.startsWith('Note: '))).toBe(false);
  });
});

describe('screenshot resource_link mimeType', () => {
  it.each([
    ['/shots/a.webp', 'image/webp'],
    ['/shots/A.WEBP', 'image/webp'],
    ['/shots/B.JPG', 'image/jpeg'],
    ['/shots/c.jpeg', 'image/jpeg'],
    ['/shots/d.PNG', 'image/png'],
  ])('%s is %s', async (imagePath, mimeType) => {
    stubBrowser({ success: true, data: { imagePath } });
    const result = await createToolHandler('fox_screenshot')({ scope: 'viewport' });
    expect(result.content[1]).toMatchObject({ type: 'resource_link', mimeType });
  });
});
