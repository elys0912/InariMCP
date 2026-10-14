/**
 * The Extension's approval check of one command (background/dispatch.ts),
 * for fake browsers in the contract tests: the command's row of the action
 * table (wire name → internal name, then dispatch.ts routeAction), then
 * url-policy.ts checkApproval against a single tab at `tabUrl`.
 */

import type { BrowserCommand } from '@inari-mcp/shared';
import { WIRE_ACTION_MAP } from '../../../packages/extension/src/action-map.ts';
import { describeAction } from '../../../packages/extension/src/background/action-table.ts';
import { routeAction } from '../../../packages/extension/src/background/dispatch.ts';
import {
  checkApproval,
  isUpfrontApproval,
  type ApprovalInputs,
} from '../../../packages/extension/src/background/url-policy.ts';
import { compileUrlRules } from '../../../packages/extension/src/url-rule.ts';

type Tab = NonNullable<ApprovalInputs['tab']>;

/** The Extension's refusal of `command` on a tab at `tabUrl`, or null when it may run. */
export function extensionApprovalRefusal(
  command: BrowserCommand,
  tabUrl: string,
): Record<string, unknown> | null {
  const internal = WIRE_ACTION_MAP.get(command.action);
  // Not implemented in the Extension: dispatch refuses it before this check,
  // so there is no approval refusal.
  if (internal === undefined || internal === null) return null;
  const { action } = routeAction(internal, command.data);
  const approval = action === undefined ? undefined : describeAction(action).approval;
  if (!isUpfrontApproval(approval)) return null;

  return checkApproval(approval, {
    tab: { id: 1, url: tabUrl } as Tab,
    data: command.data,
    confirmReadRules: compileUrlRules(command.confirmReadUrlRules ?? []).rules,
    approvedSite: command.approvedHost,
  });
}
