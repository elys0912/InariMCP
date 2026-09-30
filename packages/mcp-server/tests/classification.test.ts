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

  it.each(['fox_switch_tab', 'fox_detect_captcha', 'fox_hover', 'fox_scroll', 'fox_highlight'])(
    'lets %s through in read-only mode',
    (tool) => {
      expect(guard({ readOnly: true }).check(tool, { tabId: 1 })).toBeNull();
    },
  );

  it.each(['fox_click', 'fox_type', 'fox_navigate', 'fox_close_tab', 'fox_run_workflow'])(
    'refuses %s in read-only mode',
    (tool) => {
      expect(guard({ readOnly: true }).check(tool, {})?.safetyDecision).toBe('read_only');
    },
  );
});

describe('toolAnnotations', () => {
  const ann = (name: string) => toolAnnotations(TOOL_SCHEMAS[name]!);

  it.each(['fox_hover', 'fox_scroll', 'fox_highlight', 'fox_switch_tab'])(
    '%s is neither read-only nor destructive',
    (tool) => {
      expect(ann(tool)).toEqual({ readOnlyHint: false, destructiveHint: false });
    },
  );

  it.each(['fox_screenshot', 'fox_get_text', 'fox_wait_for_url', 'fox_get_console_logs',
    'fox_get_network_logs', 'fox_detect_captcha', 'fox_safety_status'])(
    '%s is read-only',
    (tool) => {
      expect(ann(tool)).toEqual({ readOnlyHint: true, destructiveHint: false });
    },
  );

  it.each(['fox_click', 'fox_type', 'fox_navigate', 'fox_close_tab', 'fox_execute_script'])(
    '%s is destructive',
    (tool) => {
      expect(ann(tool)).toEqual({ readOnlyHint: false, destructiveHint: true });
    },
  );

  it.each(['fox_create_tab', 'fox_open_in_container', 'fox_start_logging', 'fox_remove_observer',
    'fox_request_approval'])(
    '%s changes state without being destructive',
    (tool) => {
      expect(ann(tool)).toEqual({ readOnlyHint: false, destructiveHint: false });
    },
  );
});
