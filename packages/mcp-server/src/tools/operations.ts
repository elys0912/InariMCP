/**
 * Public tool names and the operations they run (WP13 tool consolidation).
 *
 * An operation is one of the tools of schemas.ts TOOL_SCHEMAS (the 41
 * tools before the consolidation). The SafetyGuard, the password guard and
 * the command routing of handlers.ts work on operations only; a public tool
 * call is turned into an operation call here, and the name and arguments
 * the caller used travel along as the CallLabel (messages, approvals,
 * audit log).
 */

import type { CallLabel } from '../safety/guard.js';

export interface ResolvedCall {
  /** Operation name (a TOOL_SCHEMAS key). */
  op: string;
  /** Arguments of the operation. */
  args: Record<string, unknown>;
  /** The call as made by the caller. */
  label: CallLabel;
}

/**
 * The operation a call runs. A name that is itself an operation runs as
 * is, with the arguments unchanged.
 */
export function resolveOperation(toolName: string, args: Record<string, unknown>): ResolvedCall {
  return { op: toolName, args, label: { tool: toolName, args } };
}
