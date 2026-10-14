import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const launch = vi.hoisted(() => vi.fn());
vi.mock('playwright', () => ({ firefox: { launch } }));

import type { BrowserCommand } from '@inari-mcp/shared';
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

  // execute() has no approval floor: the daemon must go through runCommand().
  it('no source file calls execute() of the headless backend', () => {
    const srcDir = fileURLToPath(new URL('../src/', import.meta.url));
    const callers = readdirSync(srcDir, { recursive: true, encoding: 'utf-8' })
      .filter((rel) => rel.endsWith('.ts'))
      .filter((rel) => /\.execute\(/.test(readFileSync(path.join(srcDir, rel), 'utf-8')));
    expect(callers).toEqual([]);
  });

  it('daemon/main.ts does not import the headless backend statically', () => {
    expect(src('daemon/main.ts')).not.toMatch(/^import .*headless\/backend/m);
  });
});

/**
 * Actions answered without touching the page, on a started browser whose
 * playwright is the fake above (no Firefox needed).
 */
describe('actions without page work', () => {
  beforeEach(() => { launch.mockReset(); });

  async function started(): Promise<HeadlessBrowser> {
    fakeBrowser();
    const browser = new HeadlessBrowser();
    await browser.start();
    return browser;
  }

  it('request_approval says no human is present', async () => {
    const r = await (await started()).execute('request_approval', undefined, {});
    expect(r).toMatchObject({ success: false, approved: false });
    expect(String(r['error'])).toContain('No human is present');
  });

  it('container actions are not supported', async () => {
    const browser = await started();
    for (const action of ['list_containers', 'open_in_container']) {
      const r = await browser.execute(action, undefined, {});
      expect(r['success'], action).toBe(false);
      expect(String(r['error']), action).toContain('Container actions are not supported');
    }
  });

  it('an unsupported action and an unknown action name are refused by name', async () => {
    const browser = await started();
    for (const action of ['hard_refresh', 'no_such_action']) {
      const r = await browser.execute(action, undefined, {});
      expect(r).toMatchObject({ success: false, error: `Unsupported headless action: ${action}` });
    }
  });
});

/**
 * The approval floor of runCommand(), on a started browser whose one tab is
 * a fake page (no Firefox needed).
 */
describe('runCommand: the approval floor', () => {
  beforeEach(() => { launch.mockReset(); });

  const SHOP = 'https://shop.example.test/cart';

  /** A started browser whose one tab is on `url`; `reload` records refreshes. */
  async function startedOn(url: string): Promise<{ browser: HeadlessBrowser; reload: ReturnType<typeof vi.fn> }> {
    const reload = vi.fn(async () => null);
    const page = { on: vi.fn(), url: () => url, reload };
    launch.mockResolvedValue({
      newContext: async () => ({ newPage: async () => page }),
      close: vi.fn(async () => undefined),
    });
    const browser = new HeadlessBrowser();
    await browser.start();
    return { browser, reload };
  }

  function command(action: BrowserCommand['action'], extra: Partial<BrowserCommand> = {}): BrowserCommand {
    return { action, data: {}, requestId: 'r1', ...extra };
  }

  it('refuses an acting command without an approval, naming the page, and does not run it', async () => {
    const { browser, reload } = await startedOn(SHOP);
    const response = await browser.runCommand(command('refresh'));
    expect(response).toMatchObject({
      requestId: 'r1', success: false, safetyDecision: 'confirmation_required', data: { url: SHOP },
    });
    expect(reload).not.toHaveBeenCalled();
  });

  it('runs an acting command approved for the site of the page', async () => {
    const { browser, reload } = await startedOn(SHOP);
    const response = await browser.runCommand(command('refresh', { approvedHost: 'shop.example.test' }));
    expect(response).toMatchObject({ requestId: 'r1', success: true });
    expect(response).not.toHaveProperty('safetyDecision');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('refuses an acting command approved for another site than the page is on now', async () => {
    const { browser, reload } = await startedOn(SHOP);
    const response = await browser.runCommand(command('refresh', { approvedHost: 'other.example.test' }));
    expect(response).toMatchObject({ success: false, safetyDecision: 'confirmation_required', data: { url: SHOP } });
    expect(reload).not.toHaveBeenCalled();
  });

  it('refuses a read of a confirm_read_sites page without an approval', async () => {
    const { browser } = await startedOn(SHOP);
    const rule = {
      kind: 'host', source: 'shop.example.test', scheme: null, hosts: 'tree',
      host: 'shop.example.test', port: null, path: null, pathMatch: 'loose',
    } as const;
    const response = await browser.runCommand(
      command('get_text', { data: { maxLength: 100 }, confirmReadUrlRules: [rule] }),
    );
    expect(response).toMatchObject({
      success: false, safetyDecision: 'confirmation_required', data: { url: SHOP, matchedPattern: 'shop.example.test' },
    });
  });

  it('execute() runs an action without the floor (the tests drive the actions with it)', async () => {
    const { browser, reload } = await startedOn(SHOP);
    expect(await browser.execute('refresh', undefined, {})).toMatchObject({ success: true });
    expect(reload).toHaveBeenCalledTimes(1);
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

  it('uses the Firefox of Playwright when FOX_EXECUTABLE is blank; the old CLAUDE_BROWSER_EXECUTABLE is not read', async () => {
    vi.stubEnv('FOX_EXECUTABLE', '  ');
    vi.stubEnv('CLAUDE_BROWSER_EXECUTABLE', '/opt/old/firefox');
    fakeBrowser();
    await new HeadlessBrowser().start();
    expect(launch.mock.calls[0]?.[0]).not.toHaveProperty('executablePath');
  });

  it('uses FOX_EXECUTABLE trimmed (H-16, H-22)', async () => {
    vi.stubEnv('FOX_EXECUTABLE', ' /opt/ff/firefox ');
    fakeBrowser();
    await new HeadlessBrowser().start();
    expect(launch.mock.calls[0]?.[0]).toMatchObject({ executablePath: '/opt/ff/firefox' });
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
    expect(String(result['error'])).toContain('not started');
  });

  it('names the missing optional dependency when playwright cannot be loaded', async () => {
    vi.resetModules();
    vi.doMock('playwright', () => { throw new Error('Cannot find package playwright'); });
    try {
      const { HeadlessBrowser: Fresh } = await import('../src/headless/backend.js');
      await expect(new Fresh().start()).rejects.toThrow('optional dependency playwright');
    } finally {
      // Back to the fake of this file (not unmocked: the real one would launch Firefox).
      vi.doMock('playwright', () => ({ firefox: { launch } }));
      vi.resetModules();
    }
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
