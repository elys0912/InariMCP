/**
 * Pure helpers of the headless backend (no playwright import, so they can be
 * tested and loaded without it).
 */

/**
 * Timeout argument in ms. The schemas use both `timeout` and `timeoutMs`;
 * `timeoutMs` wins (same order as connection/manager.ts resolveCommandTimeout).
 * Zero, negative or non-numeric values fall back.
 */
export function argTimeout(args: Record<string, unknown>, fallback: number): number {
  for (const key of ['timeoutMs', 'timeout']) {
    const v = args[key];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  }
  return fallback;
}

export interface AriaFilter {
  maxDepth?: number;
  includeText?: boolean;
  roles?: string[];
}

/**
 * Apply fox_snapshot's maxDepth / includeText / roles to Playwright's
 * ariaSnapshot() YAML. One line is one node, two spaces of indent per level.
 * With `roles` the result is a flat list of the matching lines.
 */
export function filterAriaSnapshot(yaml: string, o: AriaFilter): string {
  let lines = yaml.split('\n').filter((l) => l.trim() !== '');
  const depth = (l: string): number => Math.floor((l.length - l.trimStart().length) / 2);
  if (o.maxDepth !== undefined) lines = lines.filter((l) => depth(l) < o.maxDepth!);
  if (o.includeText === false) lines = lines.filter((l) => !/^\s*- text:/.test(l));
  if (o.roles !== undefined && o.roles.length > 0) {
    const wanted = new Set(o.roles.map((r) => r.toLowerCase()));
    lines = lines
      .filter((l) => wanted.has((/^\s*- (\w+)/.exec(l)?.[1] ?? '').toLowerCase()))
      .map((l) => l.trimStart());
  }
  return lines.join('\n');
}

interface IgnoredParam {
  key: string;
  /** Schema default: a value equal to it is not worth a warning. */
  def?: unknown;
  note: string;
}

/** Parameters the headless backend does not honour, per action. */
const HEADLESS_IGNORED: Record<string, IgnoredParam[]> = {
  navigate: [{ key: 'waitForLoad', def: true, note: 'always waits for domcontentloaded' }],
  refresh: [{ key: 'bypassCache', def: false, note: 'cache is not bypassed' }],
  screenshot: [{ key: 'saveToFile', def: true, note: 'the screenshot is always saved to a file' }],
  click: [
    { key: 'xpath', note: 'use selector or x+y' },
    { key: 'text', note: 'use selector or x+y' },
    { key: 'doubleClick', def: false, note: 'single click only' },
    { key: 'rightClick', def: false, note: 'left click only' },
  ],
  type: [
    { key: 'placeholder', note: 'use selector' },
    { key: 'name', note: 'use selector' },
    { key: 'id', note: 'use selector' },
    { key: 'clear', def: false, note: 'existing content is always replaced' },
    { key: 'pressEnter', def: false, note: 'Enter is not pressed; use fox_press_key' },
    { key: 'delay', def: 50, note: 'text is entered at once' },
  ],
  get_elements: [{ key: 'limit', def: 50, note: 'always returns at most 50 elements' }],
  find_text: [
    { key: 'caseSensitive', def: false, note: 'not applied' },
    { key: 'entireWord', def: false, note: 'not applied' },
    { key: 'includeRectData', def: false, note: 'no rect data' },
  ],
  get_tabs: [
    { key: 'urlPattern', note: 'tabs are not filtered' },
    { key: 'includeFavicon', def: false, note: 'no favicon' },
    { key: 'limit', def: 50, note: 'not applied' },
  ],
  highlight: [
    { key: 'duration', def: 3000, note: 'fixed at 2000 ms' },
    { key: 'label', note: 'no label is drawn' },
  ],
  create_tab: [{ key: 'active', def: true, note: 'the new tab always becomes active' }],
  wait_for_element: [{ key: 'visible', def: true, note: 'always waits for the element to be visible' }],
  wait_for_network_idle: [{ key: 'idleTime', def: 500, note: 'fixed by the browser engine' }],
  wait_for_navigation: [
    { key: 'waitUntil', def: 'load', note: 'not applied' },
    { key: 'urlPattern', note: 'any navigation ends the wait; use fox_wait_for_url' },
  ],
  inject_observer: [{ key: 'observerId', note: 'one observer per page' }],
  remove_observer: [{ key: 'observerId', note: 'one observer per page' }],
};

/** One warning per parameter that was set to something other than its default and is ignored. */
export function ignoredParamWarnings(action: string, args: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const p of HEADLESS_IGNORED[action] ?? []) {
    const v = args[p.key];
    if (v === undefined || v === null || v === p.def) continue;
    out.push(`${p.key}: ignored in headless mode (${p.note})`);
  }
  return out;
}
