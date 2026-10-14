/**
 * Headless backend actions against a real headless Firefox (Playwright).
 * Skipped as a whole when Firefox cannot be launched, except on CI or with
 * INARI_REQUIRE_FIREFOX (npm run test:firefox), where that fails the run
 * (tests/contract/helpers/real-firefox.ts).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright';
import { HeadlessBrowser } from '../src/headless/backend.js';
import { PASSWORD_REFUSAL } from '../src/safety/password-guard.js';
import { skipOrFailWithoutFirefox } from '../../../tests/contract/helpers/real-firefox.js';

type Result = Record<string, unknown>;

// Arguments are passed as the tool schemas deliver them (defaults filled in).
const NEW_BLANK_TAB = { url: 'about:blank' };

const browser = new HeadlessBrowser();
let available = false;

const PAGE = (body: string): string =>
  `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html><body style="margin:0">${body}</body></html>`)}`;

async function load(body: string): Promise<void> {
  const r = await browser.execute('navigate', undefined, { url: PAGE(body), newTab: false });
  expect(r['success']).toBe(true);
}

beforeAll(async () => {
  try {
    await browser.start();
    available = true;
  } catch (err) {
    skipOrFailWithoutFirefox(err);
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

/**
 * Runs `js` in the page of the active tab, to set up or read page state in
 * these tests. The backend itself runs no caller-supplied script (InariMCP
 * has no execute_script), so this reaches into HeadlessBrowser's tab map.
 */
async function inPage(js: string): Promise<unknown> {
  const internals = browser as unknown as { _tabs: Map<number, Page>; _activeTabId: number | null };
  const id = internals._activeTabId;
  const page = id === null ? undefined : internals._tabs.get(id);
  if (page === undefined) throw new Error('no active headless tab');
  return page.evaluate(js);
}

/** `v`, asserted to be defined (in place of the non-null assertion `!`). */
function defined<T>(v: T | undefined): T {
  expect(v).toBeDefined();
  if (v === undefined) throw new Error('expected a value');
  return v;
}

describe('snapshot', () => {
  real('returns the accessibility tree as text, never base64', async () => {
    await load('<h1>Shop</h1><a href="/x">Home</a><button>Buy</button><p>Hello</p>');
    const r = await browser.execute('snapshot', undefined, { includeText: true });
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
    const flat = await browser.execute('snapshot', undefined, { roles: ['button'], includeText: true });
    expect(flat['snapshot']).toBe('- button "Buy"');
    const missing = await browser.execute('snapshot', undefined, { selector: '#nope', includeText: true });
    expect(missing['success']).toBe(false);
  });

  real('warns when the selector matches several elements', async () => {
    await load('<button>A</button><button>B</button>');
    const r = await browser.execute('snapshot', undefined, { selector: 'button', includeText: true });
    expect(r['success']).toBe(true);
    expect(String((r['warnings'] as string[])[0])).toContain('matched 2');
  });
});

describe('scroll', () => {
  const TALL = '<div style="height:3000px">tall</div><div id="t" style="height:10px">target</div><div style="height:3000px"></div>';

  real('moves the window by direction and amount; no direction moves nothing (H-26)', async () => {
    await load(TALL);
    const down = await browser.execute('scroll', undefined, { direction: 'down', amount: 300 });
    expect(down).toMatchObject({ success: true, scrolled: true, target: 'window', position: { y: 300 } });
    // As on the Extension: nothing moves, and the answer is scrolled: true.
    const none = await browser.execute('scroll', undefined, { amount: 300 });
    expect(none).toMatchObject({ success: true, scrolled: true, position: { y: 300 } });
    expect(none).not.toHaveProperty('direction');
    const up = await browser.execute('scroll', undefined, { direction: 'up', amount: -100 });
    expect(up['position']).toMatchObject({ y: 200 });
    const top = await browser.execute('scroll', undefined, { direction: 'top', amount: 300 });
    expect(top['position']).toMatchObject({ y: 0 });
  });

  real('an unknown direction fails and does not scroll', async () => {
    await load(TALL);
    const r = await browser.execute('scroll', undefined, { direction: 'sideways', amount: 300 });
    expect(r['success']).toBe(false);
    expect(String(r['error'])).toContain('direction');
    expect(await inPage('window.scrollY')).toBe(0);
  });

  real('bottom reaches the end and a further down reports scrolled:false', async () => {
    await load(TALL);
    await browser.execute('scroll', undefined, { direction: 'bottom', amount: 300 });
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
    expect(await inPage('window.scrollY')).toBe(0);
  });

  real('toElement brings the element into view and wins over direction', async () => {
    await load(TALL);
    const r = await browser.execute('scroll', undefined, { toElement: '#t', direction: 'top', amount: 300 });
    expect(r['success']).toBe(true);
    expect((r['element'] as { tag: string }).tag).toBe('div');
    expect((r['position'] as { y: number }).y).toBeGreaterThan(2000);
  });

  real('an unknown selector scrolls the window, an unknown toElement falls through to direction (as on the Extension)', async () => {
    await load(TALL);
    const sel = await browser.execute('scroll', undefined, { selector: '#none', direction: 'down', amount: 300 });
    expect(sel).toMatchObject({ success: true, target: 'window', position: { y: 300 } });
    expect(String((sel['warnings'] as string[])[0])).toContain('#none');
    const to = await browser.execute('scroll', undefined, { toElement: '#none', direction: 'down', amount: 100 });
    expect(to).toMatchObject({ success: true, position: { y: 400 } });
    expect(String((to['warnings'] as string[])[0])).toContain('toElement');
    const only = await browser.execute('scroll', undefined, { toElement: '#none', amount: 100 });
    expect(only).toMatchObject({ success: true, scrolled: true, position: { y: 400 } });
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

  real('text falls back to the trimmed option text, as on the Extension', async () => {
    await load('<select id="s"><option value="a"> Alpha </option><option value="b">Beta</option></select>');
    expect(await browser.execute('select_option', undefined, { selector: '#s', text: 'Alpha' }))
      .toMatchObject({ success: true, value: 'a' });
  });

  real('fails for a non-select element', async () => {
    await load('<div id="d">x</div>');
    const r = await browser.execute('select_option', undefined, { selector: '#d', value: 'a' });
    expect(r['success']).toBe(false);
  });
});

describe('type and set_value (H-2, H-6)', () => {
  /** The value of an input, select or textarea, else the text of the element. */
  async function valueOf(selector: string): Promise<unknown> {
    return inPage(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); return 'value' in e ? e.value : e.textContent; })()`);
  }

  real('type with selector appends unless clear, and clear gives no warning', async () => {
    await load('<input id="t" value="ab"><div id="e" contenteditable="true">xy</div>');
    const appended = await browser.execute('type', undefined, { selector: '#t', text: 'cd', clear: false });
    expect(appended['success']).toBe(true);
    expect(await valueOf('#t')).toBe('abcd');
    const cleared = await browser.execute('type', undefined, { selector: '#t', text: 'z', clear: true });
    expect(cleared['success']).toBe(true);
    expect(cleared['warnings']).toBeUndefined();
    expect(await valueOf('#t')).toBe('z');
    expect((await browser.execute('type', undefined, { selector: '#e', text: 'z', clear: false }))['success']).toBe(true);
    expect(await valueOf('#e')).toBe('xyz');
  });

  real('type without selector warns that clear is not applied', async () => {
    await load('<input id="t" value="ab">');
    await inPage('document.getElementById("t").focus()');
    const r = await browser.execute('type', undefined, { text: 'c', clear: true });
    expect(r['success']).toBe(true);
    expect(String((r['warnings'] as string[])[0])).toContain('clear');
  });

  real('set_value fills an input and sets a <select> with input and change events', async () => {
    await load('<input id="t" value="old"><select id="s"><option value="a">A</option><option value="b">B</option></select>' +
      '<script>window.events = []; for (const t of ["input", "change"]) document.getElementById("s").addEventListener(t, () => events.push(t));</script>');
    expect((await browser.execute('set_value', undefined, { selector: '#t', value: 'new' }))['success']).toBe(true);
    expect(await valueOf('#t')).toBe('new');
    expect((await browser.execute('set_value', undefined, { selector: '#s', value: 'b' }))['success']).toBe(true);
    expect(await valueOf('#s')).toBe('b');
    expect(await inPage('window.events')).toEqual(['input', 'change']);
  });
});

describe('reading the page (H-3, H-7, H-8, H-15)', () => {
  real('get_text returns totalLength and title as the Extension does', async () => {
    await load('<title>T</title><p>hello world</p>');
    const r = await browser.execute('get_text', undefined, { maxLength: 5 });
    expect(r).toMatchObject({ success: true, text: 'hello', truncated: true, title: 'T' });
    expect(r['totalLength']).toBeGreaterThan(5);
    expect(r).not.toHaveProperty('total_length');
  });

  real('find_text counts occurrences, honours caseSensitive / entireWord, and refuses an empty query', async () => {
    await load('<p>Cat cat concatenate</p><p>end\\</p>');
    const find = (query: string, caseSensitive = false, entireWord = false): Promise<Result> =>
      browser.execute('find_text', undefined, { query, caseSensitive, entireWord, includeRectData: false });
    expect(await find('cat')).toMatchObject({ success: true, count: 3 });
    expect((await find('cat', true))['count']).toBe(2);
    expect((await find('cat', false, true))['count']).toBe(2);
    // Quotes and a trailing backslash are literal text (no selector syntax error).
    expect((await find('end\\'))['count']).toBe(1);
    expect(await find('"')).toMatchObject({ success: true, count: 0 });
    expect((await find(''))['success']).toBe(false);
  });

  real('get_elements returns count of every match and honours a smaller limit', async () => {
    await load('<ul><li>a</li><li>b</li><li style="display:none">c</li></ul>');
    const r = await browser.execute('get_elements', undefined, { selector: 'li', limit: 2 });
    expect(r).toMatchObject({ success: true, count: 3 });
    expect(r['elements']).toHaveLength(2);
    expect((r['elements'] as Array<{ tag: string; text: string }>)[0]).toMatchObject({ tag: 'li', text: 'a' });
    const all = await browser.execute('get_elements', undefined, { selector: 'li', limit: 50 });
    expect((all['elements'] as Array<{ box: unknown }>)[2]?.box).toBeNull();
  });

  real('highlight keeps the outline for duration', async () => {
    await load('<p id="p">x</p>');
    expect((await browser.execute('highlight', undefined, { selector: '#p', duration: 200 }))['success']).toBe(true);
    const outline = (): Promise<unknown> => inPage('document.getElementById("p").style.outline');
    expect(await outline()).not.toBe('');
    await new Promise((r) => setTimeout(r, 400));
    expect(await outline()).toBe('');
  });
});

describe('options of a masked select and selectors that test a value, as on the Extension', () => {
  const CARD =
    '<select id="m" autocomplete="cc-exp-month"><option value="01">01</option><option value="05" selected>05</option></select>' +
    '<select id="c" autocomplete="country"><option value="jp">Japan</option></select>' +
    '<input id="h" type="hidden" name="csrf" value="secret">';

  real('get_elements and get_text mask the text of an option of a masked select only', async () => {
    await load(CARD);
    const found = await browser.execute('get_elements', undefined, { selector: 'option', limit: 50 });
    expect((found['elements'] as Array<{ text: string }>).map((e) => e.text)).toEqual(['[MASKED]', '[MASKED]', 'Japan']);
    expect(await browser.execute('get_text', undefined, { selector: '#m option', maxLength: 100 }))
      .toMatchObject({ success: true, text: '[MASKED]' });
    expect(await browser.execute('get_text', undefined, { selector: '#c option', maxLength: 100 }))
      .toMatchObject({ success: true, text: 'Japan' });
  });

  real('the reading commands refuse a selector with [value…], [selected], :checked, :default or a Playwright dialect', async () => {
    await load(CARD);
    const refused = [
      await browser.execute('get_elements', undefined, { selector: 'input[name=csrf][value^="s"]', limit: 50 }),
      await browser.execute('get_elements', undefined, { selector: "xpath=//input[starts-with(@value,'s')]", limit: 50 }),
      await browser.execute('get_elements', undefined, { selector: 'select >> internal:role=option[selected]', limit: 50 }),
      await browser.execute('get_text', undefined, { selector: '#m option:checked', maxLength: 100 }),
      await browser.execute('get_text', undefined, { selector: '#m option[selected]', maxLength: 100 }),
      await browser.execute('wait_for_element', undefined, { selector: '[VALUE="secret"]', timeout: 300, visible: false }),
      await browser.execute('wait_for_element', undefined, { selector: 'role=option[selected]', timeout: 300, visible: false }),
      await browser.execute('highlight', undefined, { selector: 'option:default', duration: 200 }),
      await browser.execute('scroll', undefined, { toElement: 'input[value]', amount: 100 }),
      await browser.execute('snapshot', undefined, { selector: 'input[type=hidden][value^="s"]', includeText: true }),
      await browser.execute('snapshot', undefined, { selector: '//input[@value]', includeText: true }),
    ];
    for (const r of refused) {
      expect(r).toMatchObject({ success: false });
      expect(String(r['error'])).toContain('Selector refused');
    }
  });

  real('scroll toElement returns where the element is, not its text', async () => {
    await load('<div style="height:3000px"></div><p id="t">page text</p>');
    const r = await browser.execute('scroll', undefined, { toElement: '#t', amount: 100 });
    expect(r).toMatchObject({ success: true, element: { tag: 'p' } });
    expect(JSON.stringify(r)).not.toContain('page text');
  });
});

describe('history and waits (H-13)', () => {
  // A wait holds the lock, so the navigation it waits for is started by a
  // timer in the page before the wait is sent.
  const later = (js: string): Promise<unknown> => inPage(`setTimeout(() => { ${js} }, 300); 1`);

  real('wait_for_navigation ends at the next navigation and names the new page', async () => {
    await load('<title>first</title><p>first</p>');
    // Firefox blocks a page's own navigation to a data: URL, so the page
    // goes to about:blank (an empty title) instead.
    await later(`location.href = 'about:blank'`);
    const r = await browser.execute('wait_for_navigation', undefined, { timeout: 10_000, waitUntil: 'load' });
    expect(r).toMatchObject({ success: true, url: 'about:blank', title: '' });
  });

  real('wait_for_url matches an exact URL with ? and * literally', async () => {
    await load('<p>x</p>');
    const url = (await browser.execute('get_page_info', undefined, {}))['url'] as string;
    const target = `${url}#a?b=*`;
    await later(`location.hash = ${JSON.stringify('#a?b=*')}`);
    const r = await browser.execute('wait_for_url', undefined, { url: target, timeout: 10_000 });
    expect(r).toMatchObject({ success: true });
    expect(decodeURIComponent(String(r['url']))).toBe(decodeURIComponent(target));
  });

  real('wait_for_network_idle, refresh, go_back and go_forward', async () => {
    await load('<p>one</p>');
    expect((await browser.execute('wait_for_network_idle', undefined, { timeout: 10_000 }))['success']).toBe(true);
    expect((await browser.execute('refresh', undefined, {}))['success']).toBe(true);
    await load('<p>two</p>');
    const back = await browser.execute('go_back', undefined, {});
    expect(back['success']).toBe(true);
    expect(decodeURIComponent(String(back['url']))).toContain('one');
    const forward = await browser.execute('go_forward', undefined, {});
    expect(decodeURIComponent(String(forward['url']))).toContain('two');
  });
});

describe('other page actions', () => {
  real('hover reaches the element (mouseover fires)', async () => {
    await load('<button id="b" onmouseover="document.title = \'over\'">x</button>');
    expect((await browser.execute('hover', undefined, { selector: '#b' }))['success']).toBe(true);
    expect((await browser.execute('get_page_info', undefined, {}))['title']).toBe('over');
  });

  real('solve_captcha detects a widget and reports that a human is needed', async () => {
    await load('<div class="g-recaptcha"></div><textarea name="g-recaptcha-response"></textarea>');
    const detected = await browser.execute('solve_captcha', undefined, { detectOnly: true });
    expect(detected).toMatchObject({ success: true, present: true, widgets: [{ type: 'recaptcha', solved: false }] });
    const solve = await browser.execute('solve_captcha', undefined, {});
    expect(solve).toMatchObject({ success: false, present: true, needs_human: true });
    await load('<p>none</p>');
    expect(await browser.execute('solve_captcha', undefined, { detectOnly: true })).toMatchObject({ present: false, widgets: [] });
  });

  real('focus_tab makes the tab active and names it (H-23)', async () => {
    await load('<p>first</p>');
    const tabs = await browser.execute('get_tabs', undefined, {});
    const first = defined((tabs['tabs'] as Array<{ id: number; active: boolean }>).find((t) => t.active)).id;
    const created = await browser.execute('create_tab', undefined, NEW_BLANK_TAB);
    const other = created['tabId'] as number;
    const focused = await browser.execute('focus_tab', first, {});
    expect(focused).toMatchObject({ success: true, tabId: first });
    expect(String(focused['url'])).toContain('data:text/html');
    const after = await browser.execute('get_tabs', undefined, {});
    expect((after['tabs'] as Array<{ id: number; active: boolean }>).find((t) => t.active)?.id).toBe(first);
    expect((await browser.execute('close_tab', other, {}))['success']).toBe(true);
  });
});

describe('screenshot', () => {
  let dir = '';
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inari-headless-shot-'));
    vi.stubEnv('FOX_SCREENSHOTS_DIR', dir);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  real('keeps only the file name of a path, and names a file when none is given', async () => {
    await load('<p>x</p>');
    const named = await browser.execute('screenshot', undefined, { filename: `..${path.sep}..${path.sep}escape.png` });
    expect(named).toMatchObject({ success: true, filename: 'escape.png', imagePath: path.join(dir, 'escape.png') });
    expect(fs.existsSync(path.join(dir, 'escape.png'))).toBe(true);
    const unnamed = await browser.execute('screenshot', undefined, {});
    expect(String(unnamed['filename'])).toMatch(/^screenshot_\d+\.png$/);
    expect(path.dirname(String(unnamed['imagePath']))).toBe(dir);
  });

  // A-KM-06: Playwright took the format from the extension and refused a name without one.
  real('always saves a PNG named as the Extension path does, whatever the extension', async () => {
    await load('<p>x</p>');
    const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    for (const [requested, expected] of [
      ['shot', 'shot.png'],
      ['shot.jpg', 'shot.png'],
      ['shot.WEBP', 'shot.png'],
      ['a b?.gif', 'a_b_.gif.png'],
    ] as const) {
      const r = await browser.execute('screenshot', undefined, { filename: requested });
      expect(r, requested).toMatchObject({ success: true, filename: expected, imagePath: path.join(dir, expected) });
      expect(fs.readFileSync(path.join(dir, expected)).subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)).toBe(true);
    }
  });
});

describe('direct execute() calls the tool schemas would refuse (H-24, H-25)', () => {
  real('close_tab without tabId closes nothing; navigate with an empty url fails', async () => {
    await load('<p>x</p>');
    const before = (await browser.execute('get_tabs', undefined, {}))['totalTabs'];
    const r = await browser.execute('close_tab', undefined, {});
    expect(r).toMatchObject({ success: false, error: 'close_tab requires tabId' });
    expect((await browser.execute('get_tabs', undefined, {}))['totalTabs']).toBe(before);
    expect(await browser.execute('navigate', undefined, { url: '', newTab: false })).toMatchObject({ success: false });
  });
});

describe('dialogs', () => {
  const ALERT = '<button id="b" onclick="alert(\'hello\'); document.title = \'after\'">go</button>';

  // Each test gets a tab of its own (the active one) that is closed after it:
  // an armed handler, a pending dialog or a dialog record left by one test
  // stays on its tab, so it cannot reach the next test.
  let tab: number | undefined;
  beforeEach(async () => {
    tab = undefined;
    if (!available) return;
    const created = await browser.execute('create_tab', undefined, NEW_BLANK_TAB);
    expect(created['success']).toBe(true);
    tab = created['tabId'] as number;
  }, 30_000);
  afterEach(async () => {
    if (tab !== undefined) await browser.execute('close_tab', tab, {}); // may be closed already
    tab = undefined;
  }, 30_000);

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
    // Order, not wall-clock time: get_page_info must return while the handler still waits.
    let waitingDone = false;
    const waiting = browser.execute('handle_dialog', undefined, { action: 'dismiss', timeout: 5_000 });
    void waiting.then(() => { waitingDone = true; });
    const info = await browser.execute('get_page_info', undefined, {});
    expect(info['success']).toBe(true);
    expect(waitingDone).toBe(false);
    expect(await waiting).toMatchObject({ success: true, handled: false });
  });

  real('an armed handler expires: a later dialog is treated as unexpected', async () => {
    await load(ALERT);
    const armed = await browser.execute('handle_dialog', undefined, { action: 'accept', timeout: 100 });
    expect(armed['armed']).toBe('accept');
    const realNow = Date.now.bind(Date);
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 31_000);
    try {
      const click = await browser.execute('click', undefined, { selector: '#b' });
      expect(click['success']).toBe(true);
      expect((click['dialogs'] as Array<{ auto: boolean }>)[0]?.auto).toBe(true);
    } finally {
      spy.mockRestore();
    }
  }, 40_000);

  real('closing the tab ends a waiting handle_dialog at once', async () => {
    const started = Date.now();
    const waiting = browser.execute('handle_dialog', tab, { action: 'dismiss', timeout: 20_000 });
    await new Promise((r) => setTimeout(r, 200));
    expect((await browser.execute('close_tab', tab, {}))['success']).toBe(true);
    const r = await waiting;
    expect(r['success']).toBe(false);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  real('a second handle_dialog replaces the first, which does not arm (Q-3)', async () => {
    await load(ALERT);
    const first = browser.execute('handle_dialog', undefined, { action: 'accept', timeout: 300 });
    const second = browser.execute('handle_dialog', undefined, { action: 'dismiss', timeout: 10_000 });
    expect(await first).toMatchObject({ success: false });
    expect(String((await first)['error'])).toContain('Replaced');
    const click = await browser.execute('click', undefined, { selector: '#b' });
    expect(click['success']).toBe(true);
    expect(await second).toMatchObject({ success: true, handled: 'dismiss' });
    // The first one's timeout has passed: it must not have armed itself.
    await new Promise((r) => setTimeout(r, 400));
    const later = await browser.execute('click', undefined, { selector: '#b' });
    expect((later['dialogs'] as Array<{ auto: boolean }>)[0]?.auto).toBe(true);
  }, 40_000);

  real('a cancelled handle_dialog ends at once and does not arm (Q-2)', async () => {
    await load(ALERT);
    const abort = new AbortController();
    const waiting = browser.execute('handle_dialog', undefined, { action: 'accept', timeout: 20_000 },
      { deadline: Infinity, signal: abort.signal });
    abort.abort();
    const r = await waiting;
    expect(r['success']).toBe(false);
    expect(String(r['error'])).toContain('Cancelled');
    const click = await browser.execute('click', undefined, { selector: '#b' });
    expect((click['dialogs'] as Array<{ auto: boolean }>)[0]?.auto).toBe(true);
  }, 40_000);

  real('an unexpected dialog is dismissed after a grace period and reported', async () => {
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

  real('timeout shortens a wait', async () => {
    await load('<p>x</p>');
    const started = Date.now();
    const r = await browser.execute('wait_for_element', undefined, { selector: '#never', timeout: 300, visible: true });
    expect(r['success']).toBe(false);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  real('an argument the tool schema guarantees is required', async () => {
    await load('<p>x</p>');
    const r = await browser.execute('wait_for_element', undefined, { selector: '#never' });
    expect(r['success']).toBe(false);
    expect(String(r['error'])).toContain('Invalid arguments for wait_for_element: timeout');
  });
});

// Without a selector the guard follows the focus from the top document's
// activeElement (the <iframe> / shadow host) to the field inside it
// (headless/focus.ts). The Extension path still has the old limit.
// Moved from password-guard.test.ts (H-29): the guard where the element is
// resolved by the server rather than by content.ts.
describe('type / set_value: password guard on the element written to', () => {
  const script = inPage;

  real('refuses a password field that only appears while the fill waits for it', async () => {
    await load(
      '<div id="host"></div>' +
      '<script>setTimeout(() => { document.getElementById("host").innerHTML = ' +
      '\'<input id="pw" type="password">\'; }, 300)</script>',
    );
    const r = await browser.execute('type', undefined, { selector: '#pw', text: 'secret', clear: false });
    expect(r['success']).toBe(false);
    expect(String(r['error'])).toContain(PASSWORD_REFUSAL);
    expect(await script('document.getElementById("pw").value')).toBe('');
  });

  real('fills a late non-password field', async () => {
    await load(
      '<div id="host"></div>' +
      '<script>setTimeout(() => { document.getElementById("host").innerHTML = ' +
      '\'<input id="user" type="text">\'; }, 300)</script>',
    );
    expect((await browser.execute('type', undefined, { selector: '#user', text: 'alice', clear: false }))['success']).toBe(true);
    expect(await script('document.getElementById("user").value')).toBe('alice');
  });

  real('refuses a <label for> that points at a password field, for type and set_value', async () => {
    await load('<label for="pw">Password</label><input id="pw" type="password">');
    const typed = await browser.execute('type', undefined, { selector: 'label[for=pw]', text: 'secret', clear: false });
    expect(String(typed['error'])).toContain(PASSWORD_REFUSAL);
    const set = await browser.execute('set_value', undefined, { selector: '#pw', value: 'secret' });
    expect(String(set['error'])).toContain(PASSWORD_REFUSAL);
    expect(await script('document.getElementById("pw").value')).toBe('');
  });

  real('allows a password field when the command carries allowPassword', async () => {
    await load('<input id="pw" type="password">');
    const r = await browser.execute('type', undefined, {
      selector: '#pw', text: 'secret', clear: false, allowPassword: true,
    });
    expect(r['success']).toBe(true);
    expect(await script('document.getElementById("pw").value')).toBe('secret');
  });

  real('refuses the focused password field when no selector is given', async () => {
    await load('<input id="pw" type="password">');
    await script('document.getElementById("pw").focus()');
    const r = await browser.execute('type', undefined, { text: 'secret', clear: false });
    expect(r['success']).toBe(false);
    expect(String(r['error'])).toContain(PASSWORD_REFUSAL);
  });
});

describe('type without selector: password guard follows the focus (WP30)', () => {
  const BOX = 'position:absolute;left:0;top:0;width:300px;height:60px;border:0;margin:0';
  const FIELD = (type: string): string => `<input type=${type} style="${BOX}">`;
  const frameDoc = (type: string): string =>
    `<!doctype html><body style="margin:0">${FIELD(type)}</body>`;

  async function typeAfterClick(body: string): Promise<Result> {
    await load(body);
    const click = await browser.execute('click', undefined, { x: 20, y: 20 });
    expect(click['success']).toBe(true);
    return browser.execute('type', undefined, { text: 'x', clear: false, allowPassword: false });
  }

  async function valueOf(field: string): Promise<unknown> {
    return inPage(`${field}.value`);
  }

  real('refuses a focused password field inside a same-origin iframe', async () => {
    const r = await typeAfterClick(`<iframe srcdoc="${frameDoc('password').replace(/"/g, '&quot;')}" style="${BOX}"></iframe>`);
    expect(r['success']).toBe(false);
    expect(String(r['error'])).toMatch(/password field/);
    expect(await valueOf('document.querySelector("iframe").contentDocument.querySelector("input")')).toBe('');
  });

  real('refuses a focused password field inside a cross-origin (data:) iframe', async () => {
    const src = `data:text/html,${encodeURIComponent(frameDoc('password'))}`;
    const r = await typeAfterClick(`<iframe src="${src}" style="${BOX}"></iframe>`);
    expect(r['success']).toBe(false);
    expect(String(r['error'])).toMatch(/password field/);
  });

  real('refuses a focused password field inside an open shadow root', async () => {
    const r = await typeAfterClick(
      `<div id="h"></div><script>h.attachShadow({ mode: 'open' }).innerHTML = '${FIELD('password')}';</script>`,
    );
    expect(r['success']).toBe(false);
    expect(String(r['error'])).toMatch(/password field/);
    expect(await valueOf('document.getElementById("h").shadowRoot.querySelector("input")')).toBe('');
  });

  real('still types into a text field inside an iframe', async () => {
    const r = await typeAfterClick(`<iframe srcdoc="${frameDoc('text').replace(/"/g, '&quot;')}" style="${BOX}"></iframe>`);
    expect(r['success']).toBe(true);
  });
  // TODO(test): focus inside a closed shadow root is not seen (documented
  //   limitation of headless/focus.ts).
});

describe('press_key: password guard (H-1)', () => {
  const PW = '<input id="pw" type="password"><input id="t" type="text">';

  async function valueOf(id: string): Promise<unknown> {
    return inPage(`document.getElementById("${id}").value`);
  }

  const press = (key: string, extra: Record<string, unknown> = {}): Promise<Result> =>
    browser.execute('press_key', undefined,
      { key, ctrl: false, shift: false, alt: false, meta: false, allowPassword: false, ...extra });

  real('refuses a character key on a password field given by selector or focused', async () => {
    await load(PW);
    const bySelector = await press('a', { selector: '#pw' });
    // Refused before the field is focused: focus it for the case without selector.
    await inPage('document.getElementById("pw").focus()');
    const focused = await press('a');
    for (const r of [bySelector, focused]) {
      expect(r['success']).toBe(false);
      expect(String(r['error'])).toMatch(/password field/);
    }
    for (const key of ['KeyA', 'Space', 'Backspace']) {
      expect((await press(key, { selector: '#pw' }))['success']).toBe(false);
    }
    expect((await press('v', { selector: '#pw', ctrl: true }))['success']).toBe(false);
    expect(await valueOf('pw')).toBe('');
  });

  real('refuses when the selector cannot take focus and a password field keeps it', async () => {
    await load(`${PW}<div id="d">x</div>`);
    await inPage('document.getElementById("pw").focus()');
    const r = await press('a', { selector: '#d' });
    expect(r['success']).toBe(false);
    expect(String(r['error'])).toMatch(/password field/);
    expect(await valueOf('pw')).toBe('');
  });

  real('allows keys that do not edit, other fields, and allowPassword', async () => {
    await load(PW);
    expect(await press('Tab', { selector: '#pw' })).toMatchObject({ success: true, key: 'Tab', pressed: 'Tab' });
    expect((await press('a', { selector: '#t' }))['success']).toBe(true);
    expect(await valueOf('t')).toBe('a');
    expect((await press('b', { selector: '#pw', allowPassword: true }))['success']).toBe(true);
    expect(await valueOf('pw')).toBe('b');
  });
});

describe('password fields of an XHTML document (H-5)', () => {
  const XHTML = (body: string): string =>
    `data:application/xhtml+xml;charset=utf-8,${encodeURIComponent(
      `<html xmlns="http://www.w3.org/1999/xhtml"><body>${body}</body></html>`,
    )}`;

  real('are refused although tagName is lower case there', async () => {
    const nav = await browser.execute('navigate', undefined,
      { url: XHTML('<input id="pw" type="password"/><label id="l" for="pw">pw</label>'), newTab: false });
    expect(nav['success']).toBe(true);
    for (const selector of ['#pw', '#l']) {
      const r = await browser.execute('type', undefined, { selector, text: 'secret', clear: false });
      expect(String(r['error'])).toMatch(/password field/);
    }
    await inPage('document.getElementById("pw").focus()');
    const focused = await browser.execute('type', undefined, { text: 'secret', clear: false });
    expect(String(focused['error'])).toMatch(/password field/);
  });
});

describe('commands given up while waiting for the lock (Q-2)', () => {
  // A click on it sets the title, so a command that ran shows.
  const BUTTON = `<button id="b" onclick="document.title = 'ran'">x</button>`;
  const CLICK = { selector: '#b' };

  async function busy(): Promise<Result> {
    // Holds the lock for ~500 ms.
    return browser.execute('wait_for_element', undefined, { selector: '#never', timeout: 500, visible: true });
  }

  real('a command whose caller gave up meanwhile is not run', async () => {
    await load(BUTTON);
    const abort = new AbortController();
    const hold = busy();
    const queued = browser.execute('click', undefined, CLICK,
      { deadline: Infinity, signal: abort.signal });
    abort.abort();
    await hold;
    const r = await queued;
    expect(r['success']).toBe(false);
    expect(String(r['error'])).toContain('Not run');
    const info = await browser.execute('get_page_info', undefined, {});
    expect(info['title']).not.toBe('ran');
  });

  real('a command whose deadline passed meanwhile is not run', async () => {
    await load(BUTTON);
    const hold = busy();
    const queued = browser.execute('click', undefined, CLICK,
      { deadline: Date.now() + 100, signal: new AbortController().signal });
    await hold;
    expect(String((await queued)['error'])).toContain('Not run');
    const info = await browser.execute('get_page_info', undefined, {});
    expect(info['title']).not.toBe('ran');
  });

  real('a cancelled wait_for_* ends at once and frees the lock (H-4)', async () => {
    await load('<p>x</p>');
    const waits: Array<[string, Record<string, unknown>]> = [
      ['wait_for_element', { selector: '#never', timeout: 20_000, visible: true }],
      ['wait_for_url', { url: 'https://never.example.test/', timeout: 20_000 }],
      ['wait_for_navigation', { timeout: 20_000, waitUntil: 'load' }],
    ];
    for (const [action, args] of waits) {
      const abort = new AbortController();
      const started = Date.now();
      const running = browser.execute(action, undefined, args, { deadline: Infinity, signal: abort.signal });
      await new Promise((r) => setTimeout(r, 200));
      abort.abort();
      const r = await running;
      expect(r['success'], action).toBe(false);
      expect(String(r['error']), action).toContain('cancelled');
      expect((await browser.execute('get_page_info', undefined, {}))['success'], action).toBe(true);
      expect(Date.now() - started, action).toBeLessThan(5_000);
    }
  }, 40_000);

  real('a command still awaited runs after the one before it', async () => {
    await load(BUTTON);
    const hold = busy();
    const queued = browser.execute('click', undefined, CLICK,
      { deadline: Date.now() + 30_000, signal: new AbortController().signal });
    await hold;
    expect((await queued)['success']).toBe(true);
    expect((await browser.execute('get_page_info', undefined, {}))['title']).toBe('ran');
  });
});

describe('element waits and create_tab (R-3, R-2)', () => {
  real('set_value on a missing element fails within the element timeout, not after 60 s', async () => {
    await load('<p>x</p>');
    const started = Date.now();
    const r = await browser.execute('set_value', undefined, { selector: '#never', value: 'v' });
    expect(r['success']).toBe(false);
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 40_000);

  real('a create_tab whose page load fails leaves no page behind', async () => {
    const pages = (): number => browser.contextPageCount();
    const tabs = async (): Promise<number> =>
      (await browser.execute('get_tabs', undefined, {}))['totalTabs'] as number;
    const before = { pages: pages(), tabs: await tabs() };
    const r = await browser.execute('create_tab', undefined, { url: 'not a url' });
    expect(r['success']).toBe(false);
    expect(pages()).toBe(before.pages);
    expect(await tabs()).toBe(before.tabs);
  });
});

describe('results name the tab and its URL (O-1)', () => {
  real('a click that navigates reports the URL it ended on and the tab id', async () => {
    await load('<a id="a" href="#next">next</a>');
    const tabs = await browser.execute('get_tabs', undefined, {});
    const active = defined((tabs['tabs'] as Array<{ id: number; active: boolean }>).find((t) => t.active)).id;
    const click = await browser.execute('click', undefined, { selector: '#a' });
    expect(click['success']).toBe(true);
    expect(String(click['url'])).toMatch(/#next$/);
    expect(click['tabId']).toBe(active);
    const text = await browser.execute('get_text', undefined, { maxLength: 100 });
    expect(text).toMatchObject({ success: true, tabId: active });
    const nav = await browser.execute('navigate', undefined, { url: PAGE('<p>y</p>'), newTab: false });
    expect(nav['tabId']).toBe(active);
  });

  real('an action on another tab names that tab; a closed tab is not reported', async () => {
    await load('<p>first</p>');
    const created = await browser.execute('create_tab', undefined, NEW_BLANK_TAB);
    const other = created['tabId'] as number;
    const tabs = await browser.execute('get_tabs', undefined, {});
    const first = defined((tabs['tabs'] as Array<{ id: number }>).find((t) => t.id !== other)).id;
    const info = await browser.execute('get_page_info', first, {});
    expect(info).toMatchObject({ success: true, tabId: first });
    expect(String(info['url'])).toContain('data:text/html');
    const closed = await browser.execute('close_tab', other, {});
    expect(closed).toMatchObject({ success: true, closed: other });
    expect(closed).not.toHaveProperty('url');
  });

  real('a failed result gets no url or tabId', async () => {
    await load('<p>x</p>');
    const r = await browser.execute('click', undefined, {});
    expect(r['success']).toBe(false);
    expect(r).not.toHaveProperty('tabId');
  });
});

describe('closing the last tab (Q-1)', () => {
  real('tab commands still work afterwards and other actions name the way out', async () => {
    const list = async (): Promise<number[]> =>
      ((await browser.execute('get_tabs', undefined, {}))['tabs'] as Array<{ id: number }>).map((t) => t.id);
    for (const id of await list()) {
      expect((await browser.execute('close_tab', id, {}))['success']).toBe(true);
    }
    expect(browser.isReady()).toBe(true);
    expect(await browser.execute('get_tabs', undefined, {})).toMatchObject({ success: true, totalTabs: 0 });
    const click = await browser.execute('click', undefined, { selector: '#a' });
    expect(click['success']).toBe(false);
    expect(String(click['error'])).toContain('No headless tab is open');
    const plain = await browser.execute('navigate', undefined, { url: PAGE('<p>x</p>'), newTab: false });
    expect(String(plain['error'])).toContain('No headless tab is open');

    const opened = await browser.execute('navigate', undefined, { url: PAGE('<p>new</p>'), newTab: true });
    expect(opened['success']).toBe(true);
    expect(typeof opened['tabId']).toBe('number');
    expect((await browser.execute('close_tab', opened['tabId'] as number, {}))['success']).toBe(true);

    const created = await browser.execute('create_tab', undefined, NEW_BLANK_TAB);
    expect(created['success']).toBe(true);
    await load('<p>back</p>');
    expect(await list()).toEqual([created['tabId']]);
  });
});
