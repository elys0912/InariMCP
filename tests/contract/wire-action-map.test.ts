/**
 * Contract: server wire action names (shared BROWSER_ACTIONS) ⇔ Extension
 * WIRE_ACTION_MAP (packages/extension/src/action-map.ts) ⇔ background
 * action table (packages/extension/src/background/action-table.ts).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { BROWSER_ACTIONS } from '@kitsune-mcp/shared';
import {
  ACTION_TABLE,
  UNKNOWN_ACTION,
  describeAction,
} from '../../packages/extension/src/background/action-table.ts';

type WireMap = ReadonlyMap<string, string | null>;

let wireMap: WireMap;

beforeAll(async () => {
  // action-map.ts imports only a type; loading it as a module runs it once
  // and it publishes the table on globalThis (it also exports it).
  await import('../../packages/extension/src/action-map.ts');
  wireMap = (globalThis as { KITSUNE_WIRE_ACTION_MAP?: WireMap }).KITSUNE_WIRE_ACTION_MAP!;
});

describe('BROWSER_ACTIONS ⇔ WIRE_ACTION_MAP', () => {
  it('the extension publishes the table', () => {
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
    // TODO(test): observer id round trip through a fake content script
  });
});
