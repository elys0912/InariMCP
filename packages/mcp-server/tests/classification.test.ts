import { describe, expect, it } from 'vitest';
import { OBSERVE_TOOLS, SCRIPT_TOOLS, toolAnnotations } from '../src/tools/classification.js';
import { TOOL_SCHEMAS } from '../src/tools/schemas.js';
import { SafetyGuard } from '../src/safety/guard.js';
import { DEFAULT_CONFIG, type SafetyConfig } from '../src/safety/config.js';

// Names the hand-written OBSERVE_TOOLS list used to carry; none is a tool.
const FORMER_NAMES = [
  'fox_screenshot_all_tabs', 'fox_get_value', 'fox_get_tab_info', 'fox_find_tabs',
  'fox_wait_for_change', 'fox_observe_element', 'fox_stop_observing',
  'fox_scroll_and_capture', 'fox_focus_tab', 'fox_solve_captcha',
];

function guard(overrides: Partial<SafetyConfig> = {}): SafetyGuard {
  return new SafetyGuard({
    ...DEFAULT_CONFIG,
    auditLog: false,
    maxActionsPerMinute: 0,
    protectedUrlPatterns: [],
    ...overrides,
  });
}

describe('tool sets derived from the schemas', () => {
  it('only name registered tools', () => {
    for (const name of [...OBSERVE_TOOLS, ...SCRIPT_TOOLS]) {
      expect(TOOL_SCHEMAS[name], name).toBeDefined();
    }
  });

  it('carry none of the former names', () => {
    for (const name of FORMER_NAMES) {
      expect(OBSERVE_TOOLS.has(name), name).toBe(false);
    }
  });

  it('put every script-class tool (and nothing else) in SCRIPT_TOOLS', () => {
    expect([...SCRIPT_TOOLS].sort()).toEqual([
      'fox_eval_chain', 'fox_execute_script', 'fox_inject_observer',
      'fox_remove_observer', 'fox_wait_and_act',
    ]);
  });

  // The decision per tool is recorded in tests/golden/guard-decisions.json
  // (readOnly column); this states the rule behind it.
  it('read-only mode lets exactly the observation tools through and refuses every other tool', () => {
    const g = guard({ readOnly: true });
    for (const name of Object.keys(TOOL_SCHEMAS)) {
      const expected = OBSERVE_TOOLS.has(name) ? null : 'read_only';
      expect(g.check(name, {})?.safetyDecision ?? null, name).toBe(expected);
    }
  });
});

// The annotations per tool are recorded in tests/golden/tools-list-legacy.json
// (and tests/contract/public-tools.test.ts for the public tools); these are the
// rules that tie them to the guard, so an MCP client can rely on them.
describe('toolAnnotations', () => {
  const annotated = Object.values(TOOL_SCHEMAS).map((def) => [def.name, toolAnnotations(def)] as const);

  it('a read-only tool is let through in read-only mode', () => {
    for (const [name, { readOnlyHint }] of annotated) {
      if (readOnlyHint) expect(OBSERVE_TOOLS.has(name), name).toBe(true);
    }
  });

  it('a destructive tool is not read-only and is refused in read-only mode', () => {
    for (const [name, { readOnlyHint, destructiveHint }] of annotated) {
      if (!destructiveHint) continue;
      expect(readOnlyHint, name).toBe(false);
      expect(OBSERVE_TOOLS.has(name), name).toBe(false);
    }
  });
});
