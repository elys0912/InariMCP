/**
 * Contract: server wire action names (shared BROWSER_ACTIONS) ⇔ Extension
 * WIRE_ACTION_MAP (packages/extension/src/action-map.ts) ⇔ background
 * action table (packages/extension/src/background/action-table.ts).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BROWSER_ACTIONS } from '@kitsune-mcp/shared';
import { WIRE_ACTION_MAP as wireMap } from '../../packages/extension/src/action-map.ts';
import {
  ACTION_TABLE,
  UNKNOWN_ACTION,
  describeAction,
} from '../../packages/extension/src/background/action-table.ts';

describe('BROWSER_ACTIONS ⇔ WIRE_ACTION_MAP', () => {
  it('the extension exports the table as a Map', () => {
    expect(wireMap).toBeInstanceOf(Map);
  });

  it('every BROWSER_ACTIONS entry is a key of WIRE_ACTION_MAP (⊆)', () => {
    const missing = BROWSER_ACTIONS.filter((a) => !wireMap.has(a));
    expect(missing).toEqual([]);
  });

  it('WIRE_ACTION_MAP has no key outside BROWSER_ACTIONS (no stale wire names)', () => {
    const known = new Set<string>(BROWSER_ACTIONS);
    const extra = [...wireMap.keys()].filter((k) => !known.has(k));
    expect(extra).toEqual([]);
  });

  it('every mapped internal name is a row of the action table', () => {
    const unhandled = [...wireMap.entries()]
      .filter(([, internal]) => internal !== null && !ACTION_TABLE.has(internal))
      .map(([wire, internal]) => `${wire} -> ${internal}`);
    expect(unhandled).toEqual([]);
  });

  it('every row of the action table is reached by a wire name, except the internal-only ones', () => {
    const mapped = new Set([...wireMap.values()].filter((v): v is string => v !== null));
    const internalOnly = [...ACTION_TABLE.keys()].filter((k) => !mapped.has(k));
    expect(internalOnly).toEqual(['status']); // popup
  });

  it('an action outside the table fails closed (strictest row, refused)', async () => {
    for (const name of ['noSuchAction', 'constructor', '__proto__', 'eval_chain']) {
      expect(describeAction(name)).toBe(UNKNOWN_ACTION);
    }
    expect(UNKNOWN_ACTION).toMatchObject({ scope: 'tab', protectedCheck: 'upfront' });
    await expect(UNKNOWN_ACTION.handler({ action: 'noSuchAction' } as never)).resolves.toEqual({
      success: false,
      error: 'Unknown action: noSuchAction',
    });
  });

  it('3.A17: the observer tools reach the content script observer', () => {
    expect(wireMap.get('inject_observer')).toBe('observeElement');
    expect(wireMap.get('remove_observer')).toBe('stopObserving');
  });
});

describe('3.A17: observer id round trip, wire name to a fake content script', () => {
  const g = globalThis as Record<string, unknown>;
  /** The messages the background handed to browser.tabs.sendMessage. */
  const sent: Record<string, unknown>[] = [];
  const TAB_ID = 7;

  beforeAll(async () => {
    // The content modules need a document and a MutationObserver; nothing
    // here fires a mutation, so observe() only has to be callable.
    g.document = { querySelector: (selector: string) => (selector === '#missing' ? null : { selector }) };
    g.MutationObserver = class {
      observe(): void {}
      disconnect(): void {}
    };
    const { handleMessage } = await import('../../packages/extension/src/content/handler.ts');
    g.browser = {
      tabs: {
        get: async (id: number) => ({ id }),
        sendMessage: async (_tabId: number, message: Record<string, unknown>) => {
          sent.push(message);
          return handleMessage(message as never);
        },
      },
    };
  });

  afterAll(() => {
    for (const name of ['document', 'MutationObserver', 'browser']) delete g[name];
  });

  /** One wire command, through WIRE_ACTION_MAP and the action table. */
  const run = async (wire: string, data: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const action = wireMap.get(wire);
    const row = action ? ACTION_TABLE.get(action) : undefined;
    if (!action || !row) throw new Error(`${wire} has no row of the action table`);
    return row.handler({ action, data, tabId: TAB_ID } as never);
  };

  it('inject_observer gives an id that remove_observer takes back', async () => {
    const injected = await run('inject_observer', { selector: '#panel' });
    expect(injected).toMatchObject({ success: true, observing: true, target: '#panel' });
    const id = injected.observerId as string;
    // WP44 A-06: time and page-wide counter.
    expect(id).toMatch(/^obs_\d+_\d+$/);
    // The internal name, not the wire name, reaches the content script.
    expect(sent[0]).toEqual({ action: 'observeElement', selector: '#panel' });

    const removed = await run('remove_observer', { observerId: id });
    expect(removed).toMatchObject({
      success: true, stopped: true, observerId: id, target: '#panel', totalChanges: 0,
    });
    expect(sent[1]).toEqual({ action: 'stopObserving', observerId: id });

    // The id is gone with the observer: the second call fails, it does not
    // report a second stop.
    const again = await run('remove_observer', { observerId: id });
    expect(again.success).toBe(false);
    expect(again.error).toContain(`No observer '${id}'`);
  });

  it('an id chosen by the caller comes back unchanged', async () => {
    const injected = await run('inject_observer', { selector: '#panel', observerId: 'obs_mine' });
    expect(injected).toMatchObject({ success: true, observerId: 'obs_mine' });
    expect(await run('remove_observer', { observerId: 'obs_mine' }))
      .toMatchObject({ success: true, stopped: true, observerId: 'obs_mine' });
  });

  it('inject_observer on a missing element fails and leaves no id behind', async () => {
    const injected = await run('inject_observer', { selector: '#missing', observerId: 'obs_none' });
    expect(injected).toMatchObject({ success: false, error: 'Element not found: #missing' });
    expect(await run('remove_observer', { observerId: 'obs_none' }))
      .toMatchObject({ success: false });
  });
});
