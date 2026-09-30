/**
 * Contract: timeouts get shorter towards the browser, so the innermost layer
 * that gives up reports its own (meaningful) error first.
 *
 *   relay        HTTP wait for the daemon   maxCommandTimeoutMs(args) + RELAY_TIMEOUT_MARGIN_MS
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
 *   4. the only timeout argument keys in the tool schemas are `timeout` and
 *      `timeoutMs` (the keys both relay and daemon read).
 *   5. daemon > extension for content.ts fallbacks (no argument).
 *   6. native-host bookkeeping TTL > daemon's longest base timeout.
 *
 * Also (5b): the Extension's own budgets for navigate / refresh / new-tab
 * load waits (TIMEOUTS.PAGE_LOAD), screenshot all_tabs and fox_type typing
 * are shorter than the daemon's default. TIMEOUTS.NAVIGATION is only the
 * fallback of fox_wait_for_navigation, whose schema always sends a timeout.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ZodTypeAny } from 'zod';
import { BROWSER_ACTIONS, ENV_DEFAULTS, type BrowserAction } from '@kitsune-mcp/shared';
import {
  maxCommandTimeoutMs,
  resolveCommandTimeout,
  type BrowserKind,
} from '../../packages/mcp-server/src/connection/manager.js';
import { RELAY_TIMEOUT_MARGIN_MS } from '../../packages/mcp-server/src/relay/daemon-client.js';
import { TOOL_SCHEMAS } from '../../packages/mcp-server/src/tools/schemas.js';
import { camelizeArgs } from '../../packages/mcp-server/src/utils/camelize.js';
import { readExtensionSource, readNumericObjectConstant } from './helpers/extension-source.js';

const KINDS: readonly BrowserKind[] = ['native-host', 'headless'];
const ARG_SETS: readonly Record<string, unknown>[] = [
  {},
  { timeout: 1_000 },
  { timeout: 60_000 },
  { timeoutMs: 600_000 },
  { timeout: 3_600_000 },
  { timeoutMs: 45_000, timeout: 90_000 },
];

function daemonTimeout(action: BrowserAction, args: Record<string, unknown>, kind: BrowserKind): number {
  return resolveCommandTimeout({ action, requestId: '1', data: camelizeArgs(args) }, kind);
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
    expect(RELAY_TIMEOUT_MARGIN_MS).toBeGreaterThan(0);
    for (const args of ARG_SETS) {
      expect(maxCommandTimeoutMs(args) + RELAY_TIMEOUT_MARGIN_MS).toBeGreaterThan(maxCommandTimeoutMs(args));
    }
  });
});

describe('2. relay margin covers the headless startup wait', () => {
  it('RELAY_TIMEOUT_MARGIN_MS > FOX_HEADLESS_STARTUP_TIMEOUT default', () => {
    expect(RELAY_TIMEOUT_MARGIN_MS).toBeGreaterThan(ENV_DEFAULTS.FOX_HEADLESS_STARTUP_TIMEOUT);
  });
});

describe('3. daemon waits longer than an explicit browser-side wait', () => {
  it('resolveCommandTimeout >= argument + 5 s for every action / transport', () => {
    for (const arg of [1, 1_000, 30_000, 90_000, 200_000, 3_600_000]) {
      for (const key of ['timeout', 'timeoutMs']) {
        for (const action of BROWSER_ACTIONS) {
          for (const kind of KINDS) {
            expect(daemonTimeout(action, { [key]: arg }, kind)).toBeGreaterThanOrEqual(arg + 5_000);
          }
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
  it('tool schemas only use `timeout` / `timeoutMs`', () => {
    const keys = new Set<string>();
    for (const def of Object.values(TOOL_SCHEMAS)) {
      const shape = (def.inputSchema as unknown as { shape: Record<string, unknown> }).shape;
      for (const key of Object.keys(shape)) if (/timeout/i.test(key)) keys.add(key);
    }
    expect([...keys].sort()).toEqual(['timeout', 'timeoutMs']);
  });
});

describe('5. daemon waits longer than the extension-side fallbacks', () => {
  const content = readNumericObjectConstant(readExtensionSource('content.ts'), 'TIMEOUTS');
  const background = readNumericObjectConstant(readExtensionSource('background.ts'), 'TIMEOUTS');

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
    ['wait_for_change', 'DEFAULT'],
    ['wait_for_network_idle', 'NETWORK_IDLE'],
  ] as const)('%s: daemon base > content.ts TIMEOUTS.%s', (action, key) => {
    expect(content[key]).toBeTypeOf('number');
    for (const kind of KINDS) {
      expect(daemonTimeout(action, {}, kind)).toBeGreaterThan(content[key]!);
    }
  });
});

describe('5b. extension-side waits without a timeout argument end before the daemon (WP5)', () => {
  const content = readNumericObjectConstant(readExtensionSource('content.ts'), 'TIMEOUTS');
  const background = readNumericObjectConstant(readExtensionSource('background.ts'), 'TIMEOUTS');

  it.each([
    ['navigate', background, 'PAGE_LOAD'],
    ['refresh', background, 'PAGE_LOAD'],
    ['hard_refresh', background, 'PAGE_LOAD'],
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
  });
});
