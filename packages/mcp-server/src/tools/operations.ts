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

import type { z } from 'zod';
import type { CallLabel } from '../safety/guard.js';
import { TOOL_SCHEMAS } from './schemas.js';
import { LEGACY_REPLACEMENTS, PUBLIC_TOOLS } from './public-tools.js';

export interface ResolvedCall {
  /** Operation name (a TOOL_SCHEMAS key). */
  op: string;
  /** Arguments of the operation. */
  args: Record<string, unknown>;
  /** The call as made by the caller. */
  label: CallLabel;
}

/**
 * The operation a call runs. `args` are the arguments as parsed by
 * callSchemaFor(toolName).
 *
 * A grouped public tool (fox_wait, fox_tab, ...) runs the operation of the
 * variant its discriminator names, with the arguments renamed back to the
 * operation's and parsed by the operation's schema (its defaults; the
 * discriminator and other unknown keys dropped). Any other name is itself
 * an operation and runs as is, with the arguments unchanged.
 */
export function resolveOperation(toolName: string, args: Record<string, unknown>): ResolvedCall {
  const tool = PUBLIC_TOOLS[toolName];
  if (tool?.discriminator !== undefined) {
    const value = args[tool.discriminator] ?? tool.defaultVariant;
    const variant = typeof value === 'string' && Object.hasOwn(tool.variants, value)
      ? tool.variants[value]
      : undefined;
    if (variant === undefined) {
      throw new Error(`${toolName}: unknown ${tool.discriminator} '${String(value)}'`);
    }
    const op = variant.op(args);
    const schema = TOOL_SCHEMAS[op]?.inputSchema;
    if (!schema) throw new Error(`${toolName}: unknown operation ${op}`);
    const opArgs = schema.parse(variant.toOp ? variant.toOp(args) : args) as Record<string, unknown>;
    return { op, args: opArgs, label: { tool: toolName, args } };
  }

  const replacement = LEGACY_REPLACEMENTS[toolName];
  return {
    op: toolName,
    args,
    label: { tool: toolName, args, ...(replacement ? { replacedBy: replacement[0] } : {}) },
  };
}

/**
 * Schema a call to `toolName` is parsed with: the public tool's callSchema,
 * else the operation's own schema (deprecated names), else null.
 */
export function callSchemaFor(toolName: string): z.ZodType | null {
  return PUBLIC_TOOLS[toolName]?.callSchema ?? TOOL_SCHEMAS[toolName]?.inputSchema ?? null;
}

/** Every name the daemon accepts: the public tools and the deprecated names. */
export function callableToolNames(): Set<string> {
  return new Set([...Object.keys(PUBLIC_TOOLS), ...Object.keys(TOOL_SCHEMAS)]);
}

/** Description and safety classes of a callable name (GET /mcp/tools). */
export function describeTool(toolName: string): { description: string; classification: string } | null {
  const tool = PUBLIC_TOOLS[toolName];
  if (tool) {
    const classes = new Set(Object.values(tool.variants).flatMap((v) => v.ops)
      .map((op) => TOOL_SCHEMAS[op]!.classification));
    return { description: tool.description, classification: [...classes].join('|') };
  }
  const def = TOOL_SCHEMAS[toolName];
  return def ? { description: def.description, classification: def.classification } : null;
}

/**
 * The deprecation notice for a deprecated tool name, or null for a current
 * one (the same text as the `[Deprecated: ...]` description prefix).
 */
export function deprecationNote(toolName: string): string | null {
  if (!Object.hasOwn(LEGACY_REPLACEMENTS, toolName)) return null;
  const replacement = LEGACY_REPLACEMENTS[toolName];
  if (replacement === null || replacement === undefined) {
    return `${toolName} is deprecated and will be removed: it is not implemented on any backend.`;
  }
  const [tool, variant] = replacement;
  const discriminator = PUBLIC_TOOLS[tool]?.discriminator;
  return `${toolName} is deprecated; use ${tool} with ${discriminator}='${variant}'.`;
}
