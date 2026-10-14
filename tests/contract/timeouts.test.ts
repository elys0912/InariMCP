/**
 * Contract: timeouts get shorter towards the browser, so the innermost layer
 * that gives up reports its own (meaningful) error first.
 *
 *   relay        HTTP wait for the daemon   maxCommandTimeoutMs(args) + relayTimeoutMarginMs(env)
 *                                           (mcp-server/src/relay/daemon-client.ts)
 *   daemon       transport timeout          resolveCommandTimeout(command, kind)
 *                                           (mcp-server/src/connection/manager.ts)
 *   native-host  no command timer; forwards frames. In-flight bookkeeping
 *                expires after IN_FLIGHT_TTL_MS (native-host/src/host.ts)
 *   extension    browser-side wait          the tool's timeout argument, else
 *                                           content.ts TIMEOUTS.* fallbacks
 *                                           (request_approval: background.ts
 *                                           TIMEOUTS.APPROVAL, popup wait)
 *
 * Claims checked here:
 *   1. relay > daemon, for every action, both transports and any timeout
 *      argument (the daemon's worst case is maxCommandTimeoutMs).
 *   2. the relay margin covers the daemon's headless startup wait.
 *   3. daemon > extension when a timeout argument is given (arg + 5 s),
 *      including every default the tool schemas fill in.
 *   4. the only timeout argument key in the tool schemas is `timeout` (the
 *      key both relay and daemon read).
 *   5. daemon > extension for content.ts fallbacks (no argument).
 *   6. native-host bookkeeping TTL > daemon's longest base timeout, and >
 *      the daemon's wait for the largest timeout argument the schemas
 *      accept (MAX_TIMEOUT_ARG_MS, tools/schemas.ts).
 *
 * Also (5b): the Extension's own budgets for navigate / refresh / new-tab /
 * back / forward
 * load waits (TIMEOUTS.PAGE_LOAD), screenshot all_tabs and fox_type typing
 * are shorter than the daemon's default. TIMEOUTS.NAVIGATION is only the
 * fallback of fox_wait_for_navigation, whose schema always sends a timeout.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ZodTypeAny } from 'zod';
import { BROWSER_ACTIONS, ENV_DEFAULTS, type BrowserAction } from '@inari-mcp/shared';
import {
  maxCommandTimeoutMs,
  resolveCommandTimeout,
  type BrowserKind,
} from '../../packages/mcp-server/src/connection/manager.js';
import { relayTimeoutMarginMs } from '../../packages/mcp-server/src/relay/daemon-client.js';
import { MAX_TIMEOUT_ARG_MS, TOOL_SCHEMAS } from '../../packages/mcp-server/src/tools/schemas.js';
import { PUBLIC_TOOLS } from '../../packages/mcp-server/src/tools/public-tools.js';
import { readExtensionTree, readNumericObjectConstant } from './helpers/extension-source.js';

const KINDS: readonly BrowserKind[] = ['native-host', 'headless'];
const ARG_SETS: readonly Record<string, unknown>[] = [
  {},
  { timeout: 1_000 },
  { timeout: 60_000 },
  { timeout: 3_600_000 },
];

function daemonTimeout(action: BrowserAction, args: Record<string, unknown>, kind: BrowserKind): number {
  return resolveCommandTimeout({ action, requestId: '1', data: { ...args } }, kind);
}

/** Tool name → default of each timeout-like argument its schema fills in. */
function schemaTimeoutDefaults(): { tool: string; key: string; value: number }[] {
  const out: { tool: string; key: string; value: number }[] = [];
  for (const [tool, def] of Object.entries(TOOL_SCHEMAS)) {
    const shape = (def.inputSchema as unknown as { shape: Record<string, ZodTypeAny> }).shape;
    for (const [key, field] of Object.entries(shape)) {
      if (!/timeout/i.test(key)) continue;
      const parsed = field.safeParse(undefined);
      if (parsed.success && typeof parsed.data === 'number') out.push({ tool, key, value: parsed.data });
    }
  }
  return out;
}

describe('1. relay waits longer than the daemon', () => {
  it('maxCommandTimeoutMs(args) bounds resolveCommandTimeout for every action / transport', () => {
    for (const args of ARG_SETS) {
      for (const action of BROWSER_ACTIONS) {
        for (const kind of KINDS) {
          expect(daemonTimeout(action, args, kind), `${action} ${kind} ${JSON.stringify(args)}`)
            .toBeLessThanOrEqual(maxCommandTimeoutMs(args));
        }
      }
    }
  });

  it('the relay adds a positive margin on top', () => {
    expect(relayTimeoutMarginMs({})).toBeGreaterThan(0);
  });
});

describe('2. relay margin covers the headless startup wait', () => {
  it('relayTimeoutMarginMs > FOX_HEADLESS_STARTUP_TIMEOUT default', () => {
    expect(relayTimeoutMarginMs({})).toBeGreaterThan(ENV_DEFAULTS.FOX_HEADLESS_STARTUP_TIMEOUT);
  });

  it('R-13: the margin follows a raised FOX_HEADLESS_STARTUP_TIMEOUT', () => {
    const raised = 10 * ENV_DEFAULTS.FOX_HEADLESS_STARTUP_TIMEOUT;
    expect(relayTimeoutMarginMs({ FOX_HEADLESS_STARTUP_TIMEOUT: String(raised) })).toBeGreaterThan(raised);
  });
});

describe('3. daemon waits longer than an explicit browser-side wait', () => {
  it('resolveCommandTimeout >= argument + 5 s for every action / transport', () => {
    for (const arg of [1, 1_000, 30_000, 90_000, 200_000, 3_600_000]) {
      for (const action of BROWSER_ACTIONS) {
        for (const kind of KINDS) {
          expect(daemonTimeout(action, { timeout: arg }, kind)).toBeGreaterThanOrEqual(arg + 5_000);
        }
      }
    }
  });

  it('holds for every timeout default filled in by the tool schemas', () => {
    const defaults = schemaTimeoutDefaults();
    expect(defaults.length).toBeGreaterThan(0);
    for (const { tool, key, value } of defaults) {
      for (const action of BROWSER_ACTIONS) {
        for (const kind of KINDS) {
          expect(daemonTimeout(action, { [key]: value }, kind), `${tool}.${key}`).toBeGreaterThan(value);
        }
      }
    }
  });
});

describe('4. timeout argument keys', () => {
  it('tool schemas only use `timeout`', () => {
    const keys = new Set<string>();
    for (const def of Object.values(TOOL_SCHEMAS)) {
      const shape = (def.inputSchema as unknown as { shape: Record<string, unknown> }).shape;
      for (const key of Object.keys(shape)) if (/timeout/i.test(key)) keys.add(key);
    }
    expect([...keys].sort()).toEqual(['timeout']);
  });
});

describe('5. daemon waits longer than the extension-side fallbacks', () => {
  const content = readNumericObjectConstant(readExtensionTree('content'), 'TIMEOUTS');
  const background = readNumericObjectConstant(readExtensionTree('background'), 'TIMEOUTS');

  // Approval requests wait in the background (toolbar popup), not in the page.
  it('request_approval: daemon base > background.ts TIMEOUTS.APPROVAL', () => {
    expect(background['APPROVAL']).toBeTypeOf('number');
    expect(content['APPROVAL']).toBeUndefined();
    for (const kind of KINDS) {
      expect(daemonTimeout('request_approval', {}, kind)).toBeGreaterThan(background['APPROVAL']!);
    }
  });

  it.each([
    ['solve_captcha', 'CAPTCHA'],
    ['wait_for_element', 'WAIT_ELEMENT'],
    ['wait_for_network_idle', 'NETWORK_IDLE'],
  ] as const)('%s: daemon base > content.ts TIMEOUTS.%s', (action, key) => {
    expect(content[key]).toBeTypeOf('number');
    for (const kind of KINDS) {
      expect(daemonTimeout(action, {}, kind)).toBeGreaterThan(content[key]!);
    }
  });
});

describe('5b. extension-side waits without a timeout argument end before the daemon (WP5)', () => {
  const content = readNumericObjectConstant(readExtensionTree('content'), 'TIMEOUTS');
  const background = readNumericObjectConstant(readExtensionTree('background'), 'TIMEOUTS');

  it.each([
    ['navigate', background, 'PAGE_LOAD'],
    ['refresh', background, 'PAGE_LOAD'],
    ['hard_refresh', background, 'PAGE_LOAD'],
    ['go_back', background, 'PAGE_LOAD'],
    ['go_forward', background, 'PAGE_LOAD'],
    ['screenshot_all_tabs', background, 'ALL_TABS_BUDGET'],
    ['type', content, 'TYPING_BUDGET'],
  ] as const)('%s: daemon base > %s', (action, table, key) => {
    expect(table[key]).toBeTypeOf('number');
    for (const kind of KINDS) {
      expect(daemonTimeout(action, {}, kind), `${action} ${kind}`).toBeGreaterThan(table[key]!);
    }
  });
  // TODO(test): per-character overhead of fox_type on top of TYPING_BUDGET
  // (100 ms focus wait + event dispatch) stays inside the daemon margin.
});

describe('6. native-host in-flight bookkeeping outlives the daemon timeout', () => {
  it('IN_FLIGHT_TTL_MS > longest base command timeout', () => {
    // host.ts keeps the constant module-private, so read it from source.
    const source = readFileSync(
      fileURLToPath(new URL('../../packages/native-host/src/host.ts', import.meta.url)),
      'utf-8',
    );
    const m = /const IN_FLIGHT_TTL_MS = ([0-9_ *]+);/.exec(source);
    expect(m).not.toBeNull();
    const ttl = m![1]!
      .split('*')
      .map((part) => Number(part.trim().replace(/_/g, '')))
      .reduce((a, b) => a * b, 1);
    expect(ttl).toBe(600_000);
    expect(ttl).toBeGreaterThan(maxCommandTimeoutMs({}));
    // ... and the daemon's wait for the largest timeout argument (WP30).
    expect(ttl).toBeGreaterThan(maxCommandTimeoutMs({ timeout: MAX_TIMEOUT_ARG_MS }));
  });

  it('every timeout argument (operations and public tools) is capped at MAX_TIMEOUT_ARG_MS', () => {
    const fields: [string, ZodTypeAny][] = [];
    const collect = (name: string, shape: Record<string, ZodTypeAny>): void => {
      for (const [key, field] of Object.entries(shape)) if (/timeout/i.test(key)) fields.push([`${name}.${key}`, field]);
    };
    for (const [tool, def] of Object.entries(TOOL_SCHEMAS)) {
      collect(tool, (def.inputSchema as unknown as { shape: Record<string, ZodTypeAny> }).shape);
    }
    for (const [tool, def] of Object.entries(PUBLIC_TOOLS)) {
      collect(tool, def.listSchema.shape as Record<string, ZodTypeAny>);
    }
    expect(fields.length).toBeGreaterThan(0);
    for (const [name, field] of fields) {
      expect(field.safeParse(MAX_TIMEOUT_ARG_MS).success, name).toBe(true);
      expect(field.safeParse(MAX_TIMEOUT_ARG_MS + 1).success, name).toBe(false);
    }
  });
});
