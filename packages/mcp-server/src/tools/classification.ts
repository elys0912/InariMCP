/**
 * Everything derived from TOOL_SCHEMAS[*].classification: the SafetyGuard
 * tool sets and the MCP tool annotations. Derived here, never listed by
 * hand, so a renamed or added tool cannot drift out of the guard.
 */

import { TOOL_SCHEMAS } from './schemas.js';
import type { ToolClassification, ToolDefinition } from './schemas.js';

/**
 * Classes the guard lets through without the read-only (Layer 5), script
 * (Layer 6) and protected-domain (Layer 7) checks. None of them changes
 * page data.
 */
const GUARD_PASS_THROUGH: ReadonlySet<ToolClassification> = new Set<ToolClassification>([
  'observe',
  'interact',
  'wait',
  'logging',
  'human',
]);

function namesWhere(pred: (def: ToolDefinition) => boolean): ReadonlySet<string> {
  return new Set(Object.values(TOOL_SCHEMAS).filter(pred).map((def) => def.name));
}

/** Tools the guard treats as observation (see GUARD_PASS_THROUGH). */
export const OBSERVE_TOOLS: ReadonlySet<string> = namesWhere((def) =>
  GUARD_PASS_THROUGH.has(def.classification),
);

/** Tools refused when allowScriptExecution is false. */
export const SCRIPT_TOOLS: ReadonlySet<string> = namesWhere(
  (def) => def.classification === 'script',
);

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
}

const ANNOTATIONS_BY_CLASS: Record<ToolClassification, ToolAnnotations> = {
  observe: { readOnlyHint: true, destructiveHint: false },
  wait: { readOnlyHint: true, destructiveHint: false },
  interact: { readOnlyHint: false, destructiveHint: false },
  logging: { readOnlyHint: false, destructiveHint: false },
  human: { readOnlyHint: false, destructiveHint: false },
  act: { readOnlyHint: false, destructiveHint: true },
  script: { readOnlyHint: false, destructiveHint: true },
  workflow: { readOnlyHint: false, destructiveHint: true },
};

/** MCP annotations: the class defaults plus the tool's own exceptions. */
export function toolAnnotations(def: ToolDefinition): ToolAnnotations {
  return { ...ANNOTATIONS_BY_CLASS[def.classification], ...def.annotations };
}
