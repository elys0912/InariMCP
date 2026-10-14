/**
 * Contract: server wire action names (shared BROWSER_ACTIONS) ⇔ Extension
 * WIRE_ACTION_MAP (packages/extension/src/action-map.ts) ⇔ background
 * action table (packages/extension/src/background/action-table.ts).
 */

import { describe, expect, it } from 'vitest';
import { BROWSER_ACTIONS } from '@inari-mcp/shared';
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
    expect(UNKNOWN_ACTION).toMatchObject({ scope: 'tab', approval: 'act' });
    await expect(UNKNOWN_ACTION.handler({ action: 'noSuchAction' } as never)).resolves.toEqual({
      success: false,
      error: 'Unknown action: noSuchAction',
    });
  });

  // Decision #9 / Fo-07: the Extension itself requires a human approval for
  // every action that changes page or browser state, whatever the MCP Server
  // attached (hover too: the page's own handlers run); reads, getTabInfo
  // included, check confirm_read_sites; the rest changes no page data and
  // returns no page content.
  it('every action that changes page or browser state needs an approval', () => {
    const rows = (pred: (approval: string) => boolean): string[] =>
      [...ACTION_TABLE].filter(([, d]) => pred(d.approval)).map(([name]) => name).sort();
    expect(rows((a) => a === 'act')).toEqual([
      'click', 'clickAndWait', 'closeTab', 'goBack', 'goForward', 'hardRefresh', 'hover', 'pressKey', 'refresh',
      'selectOption', 'setValue', 'type',
    ]);
    expect(rows((a) => a === 'actOnUrl')).toEqual(['createTab', 'navigate', 'open_in_container']);
    expect(rows((a) => a === 'actPerTab')).toEqual(['reloadAll', 'reloadByUrl']);
    expect(rows((a) => a === 'read')).toEqual([
      'find_text', 'getElements', 'getPageInfo', 'getTabInfo', 'getText', 'getValue', 'screenshot', 'scrollAndCapture',
    ]);
    expect(rows((a) => a === 'readPerTab')).toEqual(['screenshotAllTabs']);
  });

  // InariMCP (AMO): no wire name runs code given as a string or records the
  // page's console / network traffic.
  it('the script, observer and logging actions are gone', () => {
    const removed = [
      'execute_script', 'eval_chain', 'wait_and_act', 'inject_observer', 'remove_observer',
      'observe_element', 'stop_observing',
      'start_logging', 'stop_logging', 'get_console_logs', 'get_network_logs', 'clear_logs',
    ];
    for (const name of removed) {
      expect(wireMap.has(name), name).toBe(false);
      expect((BROWSER_ACTIONS as readonly string[]).includes(name), name).toBe(false);
    }
    for (const internal of ['executeScript', 'observeElement', 'stopObserving', 'startLogging', 'getConsoleLogs']) {
      expect(describeAction(internal), internal).toBe(UNKNOWN_ACTION);
    }
  });
});
