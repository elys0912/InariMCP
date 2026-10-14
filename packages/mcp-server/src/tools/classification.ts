/**
 * Everything derived from the tool definitions of TOOL_SCHEMAS: the
 * SafetyGuard tool sets and the MCP tool annotations. Derived here, never
 * listed by hand, so a renamed or added tool cannot drift out of the guard.
 */

import { OPERATION_NAMES, TOOL_SCHEMAS, isOperationName } from './schemas.js';
import type { OperationName, ToolClassification, ToolDefinition } from './schemas.js';

/**
 * Classes that change page or browser state (input, navigation, tabs): the
 * guard asks the human for every call of them, on every site.
 */
const ACTING_CLASSES: ReadonlySet<ToolClassification> = new Set<ToolClassification>([
  'act',
  'workflow',
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

/**
 * Tools that change page or browser state (ACTING_CLASSES): human approval
 * for every call, and refused in read-only mode. Every other class (observe,
 * interact, wait, human) changes no page data and runs without approval.
 */
export const ACTING_TOOLS: ReadonlySet<OperationName> = namesWhere((def) =>
  ACTING_CLASSES.has(def.classification),
);

/**
 * Tools that read the content of a tab (class observe, not tab-independent):
 * on a site of confirm_read_sites they ask the human first.
 */
export const PAGE_READ_TOOLS: ReadonlySet<OperationName> = namesWhere((def) =>
  def.classification === 'observe' && def.tabIndependent !== true,
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
