/**
 * headless/approval-floor.ts: the headless backend checks the approval
 * against the page an action runs on, as the Extension does, whatever the
 * guard decided before sending.
 */

import { describe, expect, it } from 'vitest';
import { BROWSER_ACTIONS, type BrowserCommand } from '@inari-mcp/shared';
import {
  commandApprovalOf,
  floorCheckOf,
  floorRefusal,
  type CommandApproval,
} from '../src/headless/approval-floor.js';
import { headlessRoute } from '../src/headless/actions.js';
import { attachSafetyMetadata } from '../src/tools/handlers.js';
import { DEFAULT_CONFIG } from '../src/safety/config.js';

const PAGE = 'https://shop.example.test/cart';

function approval(overrides: Partial<CommandApproval> = {}): CommandApproval {
  return { approvedHost: undefined, readSites: [], unusableRules: 0, ...overrides };
}

/** The approval of a command as handlers.ts builds it, with confirm_read_sites attached. */
function approvalWithReadSites(readSites: string[], approvedHost?: string): CommandApproval {
  const command: BrowserCommand = { action: 'get_text', data: {}, requestId: '' };
  attachSafetyMetadata(command, { ...DEFAULT_CONFIG, confirmReadSites: readSites }, 'fox_get_text', {});
  return commandApprovalOf({ ...command, ...(approvedHost !== undefined ? { approvedHost } : {}) });
}

describe('floorRefusal: acting actions', () => {
  it('refuses an action without an approval, naming the page', () => {
    expect(floorRefusal('click', {}, PAGE, approval())).toMatchObject({
      success: false, safetyDecision: 'confirmation_required', url: PAGE,
    });
  });

  it('runs an action approved for the site of the page', () => {
    expect(floorRefusal('click', {}, PAGE, approval({ approvedHost: 'shop.example.test' }))).toBeNull();
  });

  it('refuses an action approved for another site (the page moved since)', () => {
    expect(floorRefusal('type', {}, 'https://other.example.test/', approval({ approvedHost: 'shop.example.test' })))
      .toMatchObject({ safetyDecision: 'confirmation_required', url: 'https://other.example.test/' });
  });

  it('refuses an action without a page, without a URL to name', () => {
    const refusal = floorRefusal('press_key', {}, null, approval({ approvedHost: 'shop.example.test' }));
    expect(refusal).toMatchObject({ safetyDecision: 'confirmation_required' });
    expect(refusal).not.toHaveProperty('url');
  });

  it('checks an opening action against the URL it opens, a blank tab when none', () => {
    const host = { approvedHost: 'shop.example.test' };
    expect(floorRefusal('navigate', { url: 'https://shop.example.test/a' }, 'https://other.test/', approval(host))).toBeNull();
    expect(floorRefusal('navigate', { url: 'https://other.example.test/' }, PAGE, approval(host)))
      .toMatchObject({ safetyDecision: 'confirmation_required', url: 'https://other.example.test/' });
    expect(floorRefusal('create_tab', {}, null, approval({ approvedHost: 'about:' }))).toBeNull();
  });
});

describe('floorRefusal: reads and the rest', () => {
  it('runs a read without confirm_read_sites, and the actions that change no page data', () => {
    expect(floorRefusal('get_text', {}, PAGE, approval())).toBeNull();
    for (const action of ['scroll', 'wait_for_url', 'get_tabs']) {
      expect(floorRefusal(action, {}, PAGE, approval()), action).toBeNull();
    }
  });

  it('refuses a read of a confirm_read_sites page unless approved for its site', () => {
    expect(floorRefusal('snapshot', {}, PAGE, approvalWithReadSites(['shop.example.test']))).toMatchObject({
      safetyDecision: 'confirmation_required', url: PAGE, matchedPattern: 'shop.example.test',
    });
    expect(floorRefusal('snapshot', {}, PAGE, approvalWithReadSites(['shop.example.test'], 'shop.example.test')))
      .toBeNull();
    expect(floorRefusal('snapshot', {}, PAGE, approvalWithReadSites(['bank.example.test']))).toBeNull();
  });

  it('refuses a command whose confirm_read_sites rules cannot be used', () => {
    expect(floorRefusal('get_text', {}, PAGE, approval({ unusableRules: 1 })))
      .toMatchObject({ success: false, safetyDecision: 'config_error' });
  });
});

describe('floorCheckOf: the actions of each check', () => {
  const supported = BROWSER_ACTIONS.filter((a) => headlessRoute(a).kind !== 'unsupported');
  const withCheck = (check: string): string[] => supported.filter((a) => floorCheckOf(a) === check).sort();

  it('asks for every action that changes page or browser state', () => {
    // Contains, not equals: get_value is 'act' here only until its wire action is removed.
    expect(withCheck('act')).toEqual(expect.arrayContaining([
      'click', 'close_tab', 'go_back', 'go_forward', 'handle_dialog', 'hover', 'press_key', 'refresh',
      'select_option', 'set_value', 'type',
    ]));
    expect(withCheck('actOnUrl')).toEqual(['create_tab', 'navigate']);
    expect(withCheck('read')).toEqual([
      'find_text', 'get_elements', 'get_page_info', 'get_text', 'screenshot', 'snapshot',
    ]);
  });

  it('gives a name that is no action the strictest check', () => {
    expect(floorCheckOf('no_such_action')).toBe('act');
    expect(floorCheckOf('constructor')).toBe('act');
  });
});
