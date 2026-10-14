/**
 * Everything derived from the tool definitions of TOOL_SCHEMAS: the
 * SafetyGuard tool sets and the MCP tool annotations. Derived here, never
 * listed by hand, so a renamed or added tool cannot drift out of the guard.
 */

import { OPERATION_NAMES, TOOL_SCHEMAS, isOperationName } from './schemas.js';
import type { OperationName, ToolClassification, ToolDefinition } from './schemas.js';

/**
 * Classes the guard lets through without the read-only (Layer 5) and
 * protected-domain (Layer 7) checks. None of them changes page data.
 */
const GUARD_PASS_THROUGH: ReadonlySet<ToolClassification> = new Set<ToolClassification>([
  'observe',
  'interact',
  'wait',
  'human',
]);

function namesWhere(pred: (def: ToolDefinition) => boolean): ReadonlySet<OperationName> {
  return new Set(OPERATION_NAMES.filter((name) => pred(TOOL_SCHEMAS[name])));
}

/**
 * Whether `name` is an operation in `set`. The guard is also asked about
 * names from the wire, which may be no operation at all.
 */
export function isOperationIn(set: ReadonlySet<OperationName>, name: string): boolean {
  return isOperationName(name) && set.has(name);
}

/** Tools the guard treats as observation (see GUARD_PASS_THROUGH). */
export const OBSERVE_TOOLS: ReadonlySet<OperationName> = namesWhere((def) =>
  GUARD_PASS_THROUGH.has(def.classification),
);

/**
 * Tools that do not act on the content of a tab (ToolDefinition
 * tabIndependent), so the blocked/allowed check of the tab's last-known URL
 * does not apply. fox_navigate with a `url` and fox_close_tab stay usable to
 * leave a tab that ended up on a blocked site. The guard's pre-check and the
 * rules handlers.ts attaches for the Extension's own check both use it.
 */
export const TAB_INDEPENDENT_TOOLS: ReadonlySet<OperationName> = namesWhere(
  (def) => def.tabIndependent === true,
);

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
}

const ANNOTATIONS_BY_CLASS: Record<ToolClassification, ToolAnnotations> = {
  observe: { readOnlyHint: true, destructiveHint: false },
  wait: { readOnlyHint: true, destructiveHint: false },
  interact: { readOnlyHint: false, destructiveHint: false },
  human: { readOnlyHint: false, destructiveHint: false },
  act: { readOnlyHint: false, destructiveHint: true },
  workflow: { readOnlyHint: false, destructiveHint: true },
};

/** MCP annotations: the class defaults plus the tool's own exceptions. */
export function toolAnnotations(def: ToolDefinition): ToolAnnotations {
  return { ...ANNOTATIONS_BY_CLASS[def.classification], ...def.annotations };
}
