/**
 * tools/handlers.ts: what the tests of the result format, the safety
 * metadata and the guard do not cover (R3 G-21 (b), §4 mimeTypeFor).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserResponse } from '@inari-mcp/shared';
import { createToolHandler } from '../src/tools/handlers.js';
import { getConnectionManager } from '../src/connection/manager.js';

/** Answer every sendCommand() with `response`, without any browser. */
function stubBrowser(response: Partial<BrowserResponse>): void {
  vi.spyOn(getConnectionManager(), 'sendCommand').mockImplementation(
    async (command) => ({ requestId: command.requestId, success: true, ...response }) as BrowserResponse,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

// InariMCP (AMO): the earlier tool names of KitsuneMCP are no tools here.
describe('a call by an earlier tool name', () => {
  it('is refused as an unknown tool, and nothing is sent', async () => {
    const send = vi.spyOn(getConnectionManager(), 'sendCommand');
    await expect(createToolHandler('fox_get_text')({})).rejects.toThrow('fox_get_text: unknown tool');
    expect(send).not.toHaveBeenCalled();
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
