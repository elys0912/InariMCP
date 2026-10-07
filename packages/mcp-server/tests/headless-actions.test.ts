/**
 * Headless backend actions against a real headless Firefox (Playwright).
 * Skipped as a whole when Firefox cannot be launched.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { HeadlessBrowser } from '../src/headless/backend.js';

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

  real('moves the window by direction and amount (no direction: down)', async () => {
    await load(TALL);
    const down = await browser.execute('scroll', undefined, { direction: 'down', amount: 300 });
    expect(down).toMatchObject({ success: true, scrolled: true, target: 'window', position: { y: 300 } });
    const dflt = await browser.execute('scroll', undefined, { amount: 300 });
    expect(dflt).toMatchObject({ direction: 'down', position: { y: 600 } });
    const up = await browser.execute('scroll', undefined, { direction: 'up', amount: -100 });
    expect(up['position']).toMatchObject({ y: 500 });
    const top = await browser.execute('scroll', undefined, { direction: 'top', amount: 300 });
    expect(top['position']).toMatchObject({ y: 0 });
  });

  real('an unknown direction fails and does not scroll', async () => {
    await load(TALL);
    const r = await browser.execute('scroll', undefined, { direction: 'sideways', amount: 300 });
    expect(r['success']).toBe(false);
    expect(String(r['error'])).toContain('direction');
    const windowY = await browser.execute('execute_script', undefined, { script: 'window.scrollY' });
    expect(windowY['result']).toBe(0);
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
    const windowY = await browser.execute('execute_script', undefined, { script: 'window.scrollY' });
    expect(windowY['result']).toBe(0);
  });

  real('toElement brings the element into view and wins over direction', async () => {
    await load(TALL);
    const r = await browser.execute('scroll', undefined, { toElement: '#t', direction: 'top', amount: 300 });
    expect(r['success']).toBe(true);
    expect((r['element'] as { tag: string }).tag).toBe('div');
    expect((r['position'] as { y: number }).y).toBeGreaterThan(2000);
  });

  real('an unknown selector or toElement fails', async () => {
    await load(TALL);
    expect((await browser.execute('scroll', undefined, { selector: '#none', direction: 'down', amount: 300 }))['success']).toBe(false);
    expect((await browser.execute('scroll', undefined, { toElement: '#none', amount: 300 }))['success']).toBe(false);
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

describe('get_value', () => {
  real('masks a password field as the Extension does, and returns other values', async () => {
    await load('<input id="p" type="password" value="secret"><input id="c" autocomplete="current-password" value="secret"><input id="t" value="plain">');
    for (const selector of ['#p', '#c']) {
      expect(await browser.execute('get_value', undefined, { selector })).toMatchObject({ success: true, value: '[MASKED]' });
    }
    expect(await browser.execute('get_value', undefined, { selector: '#t' })).toMatchObject({ success: true, value: 'plain' });
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
    const r = await browser.execute('wait_for_element', undefined, { selector: '#never', timeout: 300 });
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
describe('type without selector: password guard follows the focus (WP30)', () => {
  const BOX = 'position:absolute;left:0;top:0;width:300px;height:60px;border:0;margin:0';
  const FIELD = (type: string): string => `<input type=${type} style="${BOX}">`;
  const frameDoc = (type: string): string =>
    `<!doctype html><body style="margin:0">${FIELD(type)}</body>`;

  async function typeAfterClick(body: string): Promise<Result> {
    await load(body);
    const click = await browser.execute('click', undefined, { x: 20, y: 20 });
    expect(click['success']).toBe(true);
    return browser.execute('type', undefined, { text: 'x', allowPassword: false });
  }

  async function valueOf(field: string): Promise<unknown> {
    return (await browser.execute('execute_script', undefined, { script: `${field}.value` }))['result'];
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

describe('commands given up while waiting for the lock (Q-2)', () => {
  const TITLE = "document.title = 'ran'";

  async function busy(): Promise<Result> {
    // Holds the lock for ~500 ms.
    return browser.execute('wait_for_element', undefined, { selector: '#never', timeout: 500 });
  }

  real('a command whose caller gave up meanwhile is not run', async () => {
    await load('<p>x</p>');
    const abort = new AbortController();
    const hold = busy();
    const queued = browser.execute('execute_script', undefined, { script: TITLE },
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
    await load('<p>x</p>');
    const hold = busy();
    const queued = browser.execute('execute_script', undefined, { script: TITLE },
      { deadline: Date.now() + 100, signal: new AbortController().signal });
    await hold;
    expect(String((await queued)['error'])).toContain('Not run');
    const info = await browser.execute('get_page_info', undefined, {});
    expect(info['title']).not.toBe('ran');
  });

  real('a command still awaited runs after the one before it', async () => {
    await load('<p>x</p>');
    const hold = busy();
    const queued = browser.execute('execute_script', undefined, { script: TITLE },
      { deadline: Date.now() + 30_000, signal: new AbortController().signal });
    await hold;
    expect((await queued)['success']).toBe(true);
  });
});

describe('waits and page scripts end on their own (R-1, L-1, R-8)', () => {
  const ctx = (ms: number): { deadline: number; signal: AbortSignal } =>
    ({ deadline: Date.now() + ms, signal: new AbortController().signal });

  real('wait_and_act with pollIntervalMs 0 or negative ends at timeoutMs and frees the lock', async () => {
    await load('<p>x</p>');
    for (const pollIntervalMs of [0, -50]) {
      const started = Date.now();
      const r = await browser.execute('wait_and_act', undefined,
        { condition: 'false', actionScript: '1', pollIntervalMs, timeoutMs: 300 });
      expect(r['success']).toBe(false);
      expect(String(r['error'])).toContain('Condition not met');
      expect(Date.now() - started).toBeLessThan(5_000);
    }
    expect((await browser.execute('get_page_info', undefined, {}))['success']).toBe(true);
  });

  real('wait_and_act reports the measured elapsed_ms', async () => {
    await load('<p>x</p>');
    const r = await browser.execute('wait_and_act', undefined, {
      condition: `(() => { window.__t ??= Date.now(); return Date.now() - window.__t > 300; })()`,
      actionScript: "'done'",
      pollIntervalMs: 50,
      timeoutMs: 5_000,
    });
    expect(r).toMatchObject({ success: true, result: 'done' });
    expect(r['elapsed_ms'] as number).toBeGreaterThanOrEqual(250);
  });

  real('a condition that never settles does not hold wait_and_act past timeoutMs', async () => {
    await load('<p>x</p>');
    const started = Date.now();
    const r = await browser.execute('wait_and_act', undefined,
      { condition: 'new Promise(() => {})', actionScript: '1', pollIntervalMs: 200, timeoutMs: 500 });
    expect(r['success']).toBe(false);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  real('execute_script whose promise never settles is given up at the deadline', async () => {
    await load('<p>x</p>');
    const started = Date.now();
    const r = await browser.execute('execute_script', undefined, { script: 'new Promise(() => {})' }, ctx(500));
    expect(r['success']).toBe(false);
    expect(String(r['error'])).toContain('did not finish');
    expect(Date.now() - started).toBeLessThan(5_000);
    expect((await browser.execute('get_page_info', undefined, {}))['success']).toBe(true);
  });

  real('execute_script is given up at once when the caller gives up', async () => {
    await load('<p>x</p>');
    const abort = new AbortController();
    const running = browser.execute('execute_script', undefined, { script: 'new Promise(() => {})' },
      { deadline: Infinity, signal: abort.signal });
    await new Promise((r) => setTimeout(r, 200));
    abort.abort();
    const r = await running;
    expect(r['success']).toBe(false);
    expect(String(r['error'])).toContain('cancelled');
  });

  real('an eval_chain step that never settles fails at the deadline', async () => {
    await load('<p>x</p>');
    const r = await browser.execute('eval_chain', undefined,
      {
        steps: [
          { script: '1', captureConsole: true, stopOnError: true },
          { label: 'hang', script: 'new Promise(() => {})', captureConsole: true, stopOnError: true },
        ],
      }, ctx(500));
    expect(r['success']).toBe(true);
    const steps = r['steps'] as Array<{ label: string; error: string | null }>;
    expect(steps[0]!.error).toBeNull();
    expect(steps[1]).toMatchObject({ label: 'hang' });
    expect(String(steps[1]!.error)).toContain('did not finish');
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
    const pages = (): number =>
      (browser as unknown as { _context: { pages(): unknown[] } })._context.pages().length;
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
    const active = (tabs['tabs'] as Array<{ id: number; active: boolean }>).find((t) => t.active)!.id;
    const click = await browser.execute('click', undefined, { selector: '#a' });
    expect(click['success']).toBe(true);
    expect(String(click['url'])).toMatch(/#next$/);
    expect(click['tabId']).toBe(active);
    const script = await browser.execute('execute_script', undefined, { script: '1' });
    expect(script).toMatchObject({ success: true, result: 1, tabId: active });
    const nav = await browser.execute('navigate', undefined, { url: PAGE('<p>y</p>'), newTab: false });
    expect(nav['tabId']).toBe(active);
  });

  real('an action on another tab names that tab; a closed tab is not reported', async () => {
    await load('<p>first</p>');
    const created = await browser.execute('create_tab', undefined, NEW_BLANK_TAB);
    const other = created['tabId'] as number;
    const tabs = await browser.execute('get_tabs', undefined, {});
    const first = (tabs['tabs'] as Array<{ id: number }>).find((t) => t.id !== other)!.id;
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
