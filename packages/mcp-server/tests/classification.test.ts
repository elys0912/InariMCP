import { describe, expect, it } from 'vitest';
import {
  ACTING_TOOLS,
  PAGE_READ_TOOLS,
  TAB_INDEPENDENT_TOOLS,
  isOperationIn,
  toolAnnotations,
} from '../src/tools/classification.js';
import { OPERATION_NAMES, TOOL_SCHEMAS } from '../src/tools/schemas.js';
import { SafetyGuard } from '../src/safety/guard.js';
import { DEFAULT_CONFIG, type SafetyConfig } from '../src/safety/config.js';

// Names of tools that no longer exist; none is a tool.
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
    ...overrides,
  });
}

describe('tool sets derived from the schemas', () => {
  it('only name registered tools', () => {
    for (const name of [...ACTING_TOOLS, ...PAGE_READ_TOOLS]) {
      expect(TOOL_SCHEMAS[name], name).toBeDefined();
    }
  });

  it('carry none of the former names', () => {
    for (const name of FORMER_NAMES) {
      expect(isOperationIn(ACTING_TOOLS, name), name).toBe(false);
      expect(isOperationIn(PAGE_READ_TOOLS, name), name).toBe(false);
    }
  });

  // Decision #9: the tools that change page or browser state, each asked about.
  it('put the acting tools in ACTING_TOOLS', () => {
    expect([...ACTING_TOOLS].sort()).toEqual([
      'fox_click', 'fox_close_tab', 'fox_create_tab', 'fox_handle_dialog', 'fox_navigate',
      'fox_open_in_container', 'fox_press_key', 'fox_run_workflow', 'fox_select_option',
      'fox_set_value', 'fox_type',
    ]);
  });

  it('put the tools that read a tab in PAGE_READ_TOOLS', () => {
    expect([...PAGE_READ_TOOLS].sort()).toEqual([
      'fox_audit_page', 'fox_find_text', 'fox_get_elements', 'fox_get_page_info', 'fox_get_text',
      'fox_screenshot', 'fox_snapshot',
    ]);
  });

  // G-8: derived from ToolDefinition.tabIndependent, the set the guard had by hand.
  it('put the tab-independent tools in TAB_INDEPENDENT_TOOLS', () => {
    expect([...TAB_INDEPENDENT_TOOLS].sort()).toEqual([
      'fox_close_tab', 'fox_create_tab', 'fox_get_tabs', 'fox_list_containers',
      'fox_open_in_container', 'fox_safety_status', 'fox_switch_tab',
    ]);
  });

  // InariMCP (AMO): no tool runs caller-supplied JavaScript or records the
  // page's console / network traffic.
  it('define no script or logging tool', () => {
    const classes = new Set(OPERATION_NAMES.map((name) => TOOL_SCHEMAS[name]!.classification));
    expect([...classes].sort()).toEqual(['act', 'human', 'interact', 'observe', 'wait', 'workflow']);
  });

  // The decision per tool is recorded in tests/golden/guard-decisions.json
  // (readOnly column); this states the rule behind it.
  it('read-only mode refuses exactly the acting tools', () => {
    const g = guard({ readOnly: true });
    for (const name of OPERATION_NAMES) {
      const expected = ACTING_TOOLS.has(name) ? 'read_only' : null;
      expect(g.check(name, {})?.safetyDecision ?? null, name).toBe(expected);
    }
  });
});

// The annotations per tool are recorded in tests/golden/tools-list-legacy.json
// (and tests/contract/public-tools.test.ts for the public tools); these are the
// rules that tie them to the guard, so an MCP client can rely on them.
describe('toolAnnotations', () => {
  const annotated = OPERATION_NAMES.map((name) => [name, toolAnnotations(TOOL_SCHEMAS[name])] as const);

  it('a read-only tool is no acting tool (no approval, allowed in read-only mode)', () => {
    for (const [name, { readOnlyHint }] of annotated) {
      if (readOnlyHint) expect(ACTING_TOOLS.has(name), name).toBe(false);
    }
  });

  it('a destructive tool is not read-only and is an acting tool', () => {
    for (const [name, { readOnlyHint, destructiveHint }] of annotated) {
      if (!destructiveHint) continue;
      expect(readOnlyHint, name).toBe(false);
      expect(ACTING_TOOLS.has(name), name).toBe(true);
    }
  });
});
