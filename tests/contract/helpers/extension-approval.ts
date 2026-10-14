/**
 * The Extension's approval check of one command (background/dispatch.ts),
 * for fake browsers in the contract tests: the command's row of the action
 * table (wire name → internal name, fox_navigate newTab → createTab), then
 * url-policy.ts checkApproval against a single tab at `tabUrl`.
 */

import type { BrowserCommand } from '@inari-mcp/shared';
import { WIRE_ACTION_MAP } from '../../../packages/extension/src/action-map.ts';
import { describeAction } from '../../../packages/extension/src/background/action-table.ts';
import { checkApproval } from '../../../packages/extension/src/background/url-policy.ts';
import { compileUrlRules } from '../../../packages/extension/src/url-rule.ts';

type Tab = NonNullable<Parameters<typeof checkApproval>[1]>;

/** The Extension's refusal of `command` on a tab at `tabUrl`, or null when it may run. */
export function extensionApprovalRefusal(
  command: BrowserCommand,
  tabUrl: string,
): Record<string, unknown> | null {
  const internal = WIRE_ACTION_MAP.get(command.action);
  // Not implemented in the Extension: refused before any check.
  if (internal === undefined || internal === null) return null;
  const action = internal === 'navigate' && command.data?.['newTab'] === true ? 'createTab' : internal;
  const approval = describeAction(action).approval;
  if (approval !== 'act' && approval !== 'actOnUrl' && approval !== 'read') return null;
  const tab = { id: 1, url: tabUrl } as Tab;
  const confirmReadRules = compileUrlRules(command.confirmReadUrlRules ?? []).rules;
  return checkApproval(approval, tab, command.data, confirmReadRules, command.approvedHost);
}
