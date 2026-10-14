/**
 * Contract: the approval floor of the headless backend
 * (packages/mcp-server/src/headless/approval-floor.ts) checks each action as
 * the Extension's action table does (the `approval` column of
 * packages/extension/src/background/action-table.ts).
 */

import { describe, expect, it } from 'vitest';
import { BROWSER_ACTIONS } from '@inari-mcp/shared';
import { WIRE_ACTION_MAP } from '../../packages/extension/src/action-map.ts';
import { describeAction } from '../../packages/extension/src/background/action-table.ts';
import { floorCheckOf } from '../../packages/mcp-server/src/headless/approval-floor.js';
import { headlessRoute } from '../../packages/mcp-server/src/headless/actions.js';

/** Where the two differ on purpose. */
const INTENDED: Readonly<Record<string, string>> = {
  // Headless answers "not supported in headless mode" and opens nothing.
  open_in_container: 'none',
};

/** Actions both backends run, with the Extension's check and the floor's. */
function compared(): Array<{ action: string; extension: string; floor: string }> {
  return BROWSER_ACTIONS
    .filter((action) => headlessRoute(action).kind !== 'unsupported')
    .flatMap((action) => {
      const internal = WIRE_ACTION_MAP.get(action);
      if (internal === null || internal === undefined) return [];
      return [{ action, extension: describeAction(internal).approval, floor: floorCheckOf(action) }];
    });
}

describe('headless approval floor ⇔ Extension action table', () => {
  it('checks every action both backends run the same way', () => {
    const differ = compared()
      .filter(({ action, extension, floor }) => floor !== extension && INTENDED[action] !== floor)
      .map(({ action, extension, floor }) => `${action}: extension ${extension}, floor ${floor}`);
    expect(differ).toEqual([]);
  });

  it('lists only differences that still exist', () => {
    const differing = new Set(compared().filter((c) => c.floor !== c.extension).map((c) => c.action));
    const stale = Object.keys(INTENDED).filter((action) => !differing.has(action));
    expect(stale).toEqual([]);
  });

  it('gives the actions only headless runs (no Extension row) the strictest check where they act', () => {
    expect(floorCheckOf('handle_dialog')).toBe('act');
    expect(floorCheckOf('snapshot')).toBe('read');
  });
});
