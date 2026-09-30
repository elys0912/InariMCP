import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const launch = vi.hoisted(() => vi.fn());
vi.mock('playwright', () => ({ firefox: { launch } }));

import { HeadlessBrowser } from '../src/headless/backend.js';

function fakeBrowser(): { close: ReturnType<typeof vi.fn> } {
  const page = { on: vi.fn(), url: () => 'about:blank' };
  const close = vi.fn(async () => undefined);
  launch.mockResolvedValue({
    newContext: async () => ({ newPage: async () => page }),
    close,
  });
  return { close };
}

describe('playwright stays optional at load time', () => {
  const src = (rel: string): string =>
    readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), 'utf-8');

  it('backend.ts only imports playwright types statically', () => {
    const staticImports = src('headless/backend.ts').match(/^import .* from 'playwright';$/gm) ?? [];
    expect(staticImports.every((l) => l.startsWith('import type'))).toBe(true);
  });

  it('daemon/main.ts does not import the headless backend statically', () => {
    expect(src('daemon/main.ts')).not.toMatch(/^import .*headless\/backend/m);
  });
});

describe('HeadlessBrowser lifecycle', () => {
  beforeEach(() => { launch.mockReset(); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('passes FOX_HEADLESS_STARTUP_TIMEOUT to firefox.launch', async () => {
    vi.stubEnv('FOX_HEADLESS_STARTUP_TIMEOUT', '4321');
    fakeBrowser();
    await new HeadlessBrowser().start();
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ headless: true, timeout: 4321 }));
  });

  it('is ready after start() and not ready after stop()', async () => {
    const { close } = fakeBrowser();
    const browser = new HeadlessBrowser();
    expect(browser.isReady()).toBe(false);
    await browser.start();
    expect(browser.isReady()).toBe(true);
    await browser.stop();
    expect(close).toHaveBeenCalledTimes(1);
    expect(browser.isReady()).toBe(false);
  });

  it('is not ready after stop() even when close() throws', async () => {
    const { close } = fakeBrowser();
    close.mockRejectedValue(new Error('boom'));
    const browser = new HeadlessBrowser();
    await browser.start();
    await expect(browser.stop()).rejects.toThrow('boom');
    expect(browser.isReady()).toBe(false);
  });

  it('answers actions with an error after stop()', async () => {
    fakeBrowser();
    const browser = new HeadlessBrowser();
    await browser.start();
    await browser.stop();
    const result = await browser.execute('get_page_info', undefined, {});
    expect(result['success']).toBe(false);
  });

  it('calling stop() twice is harmless', async () => {
    const { close } = fakeBrowser();
    const browser = new HeadlessBrowser();
    await browser.start();
    await browser.stop();
    await browser.stop();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
