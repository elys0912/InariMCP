/**
 * Headless backend actions against a real headless Firefox (Playwright).
 * Skipped as a whole when Firefox cannot be launched.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HeadlessBrowser } from '../src/headless/backend.js';

type Result = Record<string, unknown>;

const browser = new HeadlessBrowser();
let available = false;

const PAGE = (body: string): string =>
  `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html><body style="margin:0">${body}</body></html>`)}`;

async function load(body: string): Promise<void> {
  const r = await browser.execute('navigate', undefined, { url: PAGE(body) });
  expect(r['success']).toBe(true);
}

beforeAll(async () => {
  try {
    await browser.start();
    available = true;
  } catch {
    available = false;
  }
}, 60_000);

afterAll(async () => {
  if (available) await browser.stop();
}, 30_000);

function real(name: string, fn: () => Promise<void>, timeout = 30_000): void {
  it(name, async (ctx) => {
    if (!available) ctx.skip();
    await fn();
  }, timeout);
}

describe('snapshot', () => {
  real('returns the accessibility tree as text, never base64', async () => {
    await load('<h1>Shop</h1><a href="/x">Home</a><button>Buy</button><p>Hello</p>');
    const r = await browser.execute('snapshot', undefined, {});
    expect(r['success']).toBe(true);
    expect(r['format']).toBe('aria-yaml');
    expect(r).not.toHaveProperty('base64');
    const text = r['snapshot'] as string;
    expect(text).toContain('heading "Shop"');
    expect(text).toContain('button "Buy"');
    expect(r['truncated']).toBe(false);
  });

  real('filters by role and text, and fails for an unknown selector', async () => {
    await load('<h1>Shop</h1><a href="/x">Home</a><button>Buy</button>');
    const flat = await browser.execute('snapshot', undefined, { roles: ['button'] });
    expect(flat['snapshot']).toBe('- button "Buy"');
    const missing = await browser.execute('snapshot', undefined, { selector: '#nope' });
    expect(missing['success']).toBe(false);
  });

  real('warns when the selector matches several elements', async () => {
    await load('<button>A</button><button>B</button>');
    const r = await browser.execute('snapshot', undefined, { selector: 'button' });
    expect(r['success']).toBe(true);
    expect(String((r['warnings'] as string[])[0])).toContain('matched 2');
  });
});

describe('scroll', () => {
  const TALL = '<div style="height:3000px">tall</div><div id="t" style="height:10px">target</div><div style="height:3000px"></div>';

  real('moves the window by direction and amount (default: down 300)', async () => {
    await load(TALL);
    const down = await browser.execute('scroll', undefined, { direction: 'down', amount: 300 });
    expect(down).toMatchObject({ success: true, scrolled: true, target: 'window', position: { y: 300 } });
    const dflt = await browser.execute('scroll', undefined, {});
    expect(dflt['position']).toMatchObject({ y: 600 });
    const up = await browser.execute('scroll', undefined, { direction: 'up', amount: -100 });
    expect(up['position']).toMatchObject({ y: 500 });
    const top = await browser.execute('scroll', undefined, { direction: 'top' });
    expect(top['position']).toMatchObject({ y: 0 });
  });

  real('bottom reaches the end and a further down reports scrolled:false', async () => {
    await load(TALL);
    await browser.execute('scroll', undefined, { direction: 'bottom' });
    const again = await browser.execute('scroll', undefined, { direction: 'down', amount: 300 });
    expect(again['success']).toBe(true);
    expect(again['scrolled']).toBe(false);
  });

  real('scrolls only the element given by selector', async () => {
    await load('<div id="box" style="height:100px;overflow:auto"><div style="height:1000px">x</div></div><div style="height:3000px"></div>');
    const r = await browser.execute('scroll', undefined, { selector: '#box', direction: 'down', amount: 200 });
    expect(r).toMatchObject({ success: true, target: 'element', position: { y: 200 } });
    const win = await browser.execute('get_page_info', undefined, {});
    expect(win['success']).toBe(true);
    const windowY = await browser.execute('execute_script', undefined, { script: 'window.scrollY' });
    expect(windowY['result']).toBe(0);
  });

  real('toElement brings the element into view and wins over direction', async () => {
    await load(TALL);
    const r = await browser.execute('scroll', undefined, { toElement: '#t', direction: 'top' });
    expect(r['success']).toBe(true);
    expect((r['element'] as { tag: string }).tag).toBe('div');
    expect((r['position'] as { y: number }).y).toBeGreaterThan(2000);
  });

  real('an unknown selector or toElement fails', async () => {
    await load(TALL);
    expect((await browser.execute('scroll', undefined, { selector: '#none', direction: 'down' }))['success']).toBe(false);
    expect((await browser.execute('scroll', undefined, { toElement: '#none' }))['success']).toBe(false);
  });
});

describe('select_option', () => {
  const SELECT = '<select id="s"><option value="a">Alpha</option><option value="b">Beta</option></select>';

  real('selects by value, text and index and reports what was chosen', async () => {
    await load(SELECT);
    expect(await browser.execute('select_option', undefined, { selector: '#s', value: 'b' }))
      .toMatchObject({ success: true, selected: true, value: 'b', text: 'Beta' });
    expect(await browser.execute('select_option', undefined, { selector: '#s', text: 'Alpha' }))
      .toMatchObject({ success: true, value: 'a' });
    expect(await browser.execute('select_option', undefined, { selector: '#s', index: 1 }))
      .toMatchObject({ success: true, value: 'b' });
  });

  real('fails when nothing matches, listing the options', async () => {
    await load(SELECT);
    const r = await browser.execute('select_option', undefined, { selector: '#s', value: 'zzz' });
    expect(r['success']).toBe(false);
    expect(String(r['error'])).toContain('No option matches');
    expect(r['availableOptions']).toEqual([{ value: 'a', text: 'Alpha' }, { value: 'b', text: 'Beta' }]);
    const index = await browser.execute('select_option', undefined, { selector: '#s', index: 9 });
    expect(index['success']).toBe(false);
  });

  real('fails for a non-select element', async () => {
    await load('<div id="d">x</div>');
    const r = await browser.execute('select_option', undefined, { selector: '#d', value: 'a' });
    expect(r['success']).toBe(false);
  });
});

describe('dialogs', () => {
  const ALERT = '<button id="b" onclick="alert(\'hello\'); document.title = \'after\'">go</button>';

  real('an armed handler accepts the next dialog and the action is not blocked', async () => {
    await load(ALERT);
    const armed = await browser.execute('handle_dialog', undefined, { action: 'accept', timeout: 200 });
    expect(armed).toMatchObject({ success: true, handled: false, armed: 'accept' });
    const click = await browser.execute('click', undefined, { selector: '#b' });
    expect(click['success']).toBe(true);
    expect(click['dialogs']).toEqual([{ type: 'alert', message: 'hello', handled: 'accept', auto: false }]);
    expect(click['warnings']).toBeUndefined();
  });

  real('a handler waiting while the click runs does not block it (no lock held)', async () => {
    await load(ALERT);
    const waiting = browser.execute('handle_dialog', undefined, { action: 'accept', timeout: 10_000 });
    const click = await browser.execute('click', undefined, { selector: '#b' });
    expect(click['success']).toBe(true);
    expect(await waiting).toMatchObject({ success: true, type: 'alert', message: 'hello', handled: 'accept' });
  });

  real('other actions run while a handler is waiting', async () => {
    await load('<p>x</p>');
    const waiting = browser.execute('handle_dialog', undefined, { timeout: 1_500 });
    const started = Date.now();
    const info = await browser.execute('get_page_info', undefined, {});
    expect(info['success']).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(await waiting).toMatchObject({ success: true, handled: false });
  });

  real('an unexpected dialog is dismissed after a grace period and reported', async () => {
    // fresh tab: earlier tests may have left an armed handler on the first one
    expect((await browser.execute('create_tab', undefined, {}))['success']).toBe(true);
    await load(ALERT);
    const click = await browser.execute('click', undefined, { selector: '#b' });
    expect(click['success']).toBe(true);
    expect((click['dialogs'] as Array<{ auto: boolean }>)[0]?.auto).toBe(true);
    expect(String((click['warnings'] as string[])[0])).toContain('dismissed automatically');
  }, 40_000);
});

describe('warnings and timeouts', () => {
  real('reports ignored parameters on success', async () => {
    await load('<button id="b">x</button>');
    const r = await browser.execute('click', undefined, { selector: '#b', doubleClick: true });
    expect(r['success']).toBe(true);
    expect(String((r['warnings'] as string[])[0])).toContain('doubleClick');
  });

  real('appends warnings to the error of a failed result', async () => {
    await load('<button id="b">x</button>');
    const r = await browser.execute('click', undefined, { xpath: '//button', rightClick: true });
    expect(r['success']).toBe(false);
    expect(String(r['error'])).toContain('(warnings:');
    expect(String(r['error'])).toContain('rightClick');
  });

  real('timeoutMs and timeout both shorten a wait', async () => {
    await load('<p>x</p>');
    for (const key of ['timeoutMs', 'timeout']) {
      const started = Date.now();
      const r = await browser.execute('wait_for_element', undefined, { selector: '#never', [key]: 300 });
      expect(r['success']).toBe(false);
      expect(Date.now() - started).toBeLessThan(5_000);
    }
  });
});
