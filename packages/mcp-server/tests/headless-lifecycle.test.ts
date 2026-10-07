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

  it.each(['headless/backend.ts', 'headless/actions.ts'])('%s only imports playwright types statically', (rel) => {
    const staticImports = src(rel).match(/^import .* from 'playwright';$/gm) ?? [];
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

  it('uses the Firefox of Playwright when FOX_EXECUTABLE is blank', async () => {
    vi.stubEnv('FOX_EXECUTABLE', '  ');
    vi.stubEnv('CLAUDE_BROWSER_EXECUTABLE', '');
    fakeBrowser();
    await new HeadlessBrowser().start();
    expect(launch.mock.calls[0]?.[0]).not.toHaveProperty('executablePath');
  });

  it('uses the legacy CLAUDE_BROWSER_EXECUTABLE when FOX_EXECUTABLE is blank, trimmed (H-16, H-22)', async () => {
    vi.stubEnv('FOX_EXECUTABLE', '  ');
    vi.stubEnv('CLAUDE_BROWSER_EXECUTABLE', ' /opt/legacy/firefox ');
    fakeBrowser();
    await new HeadlessBrowser().start();
    expect(launch.mock.calls[0]?.[0]).toMatchObject({ executablePath: '/opt/legacy/firefox' });
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
