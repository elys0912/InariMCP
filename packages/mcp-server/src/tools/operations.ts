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
import { isRecord } from '@inari-mcp/shared';
import type { CallLabel } from '../safety/guard.js';
import { TOOL_SCHEMAS, callSchemaOf, isOperationName } from './schemas.js';
import type { OperationName, ToolClassification } from './schemas.js';
import {
  LEGACY_REPLACEMENTS,
  PUBLIC_TOOLS,
  isLegacyOperationName,
  isPublicToolName,
} from './public-tools.js';
import type { PublicToolName } from './public-tools.js';

export interface ResolvedCall {
  /** The operation the call runs. */
  op: OperationName;
  /** Arguments of the operation. */
  args: Record<string, unknown>;
  /** The call as made by the caller. */
  label: CallLabel;
}

/** A discriminator value as the error for an unknown variant shows it. */
function variantText(value: unknown): string {
  return typeof value === 'string' || value === undefined ? String(value) : JSON.stringify(value);
}

/** `raw` parsed by the schema of `op`. Every operation schema is a z.object, so a non-object means a broken table. */
function parseOperationArgs(op: OperationName, raw: Record<string, unknown>): Record<string, unknown> {
  const parsed: unknown = callSchemaOf(TOOL_SCHEMAS[op]).parse(raw);
  if (!isRecord(parsed)) throw new Error(`the arguments of ${op} did not parse to an object`);
  return parsed;
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
 *
 * Throws for a name that is neither, and for an unknown variant: the
 * callers parse the call with callSchemaFor() first, which refuses both.
 */
export function resolveOperation(toolName: string, args: Record<string, unknown>): ResolvedCall {
  const tool = isPublicToolName(toolName) ? PUBLIC_TOOLS[toolName] : undefined;
  if (tool?.discriminator !== undefined) {
    const value = args[tool.discriminator] ?? tool.defaultVariant;
    const variant = typeof value === 'string' && Object.hasOwn(tool.variants, value)
      ? tool.variants[value]
      : undefined;
    if (variant === undefined) {
      throw new Error(`${toolName}: unknown ${tool.discriminator} '${variantText(value)}'`);
    }
    const op = variant.op(args);
    const opArgs = parseOperationArgs(op, variant.toOp ? variant.toOp(args) : args);
    return { op, args: opArgs, label: { tool: toolName, args } };
  }

  if (!isOperationName(toolName)) throw new Error(`${toolName}: unknown tool`);
  const replacement = isLegacyOperationName(toolName) ? LEGACY_REPLACEMENTS[toolName] : null;
  if (replacement === null) return { op: toolName, args, label: { tool: toolName, args } };
  const [replacedBy, variantValue] = replacement;
  return {
    op: toolName,
    args,
    label: { tool: toolName, args, replacedBy, auditArgs: publicArgsOf(replacedBy, variantValue, args) },
  };
}

/**
 * The arguments of a call by a deprecated operation name, as the public
 * tool that replaces it takes them: the discriminator first, then the
 * variant's arguments (its fromOp, else the same keys), parsed by the
 * public tool's callSchema. The audit log records a call in this one form,
 * whichever name it was made by: both carry the defaults of the public
 * tool's schema (G-4). An operation default the public variant does not
 * have stays (fox_create_tab's url 'about:blank').
 */
function publicArgsOf(
  tool: PublicToolName,
  variantValue: string,
  opArgs: Record<string, unknown>,
): Record<string, unknown> {
  const publicTool = PUBLIC_TOOLS[tool];
  const discriminator = publicTool.discriminator;
  if (discriminator === undefined) return opArgs;
  const variant = publicTool.variants[variantValue];
  const rest = variant?.fromOp ? variant.fromOp(opArgs) : opArgs;
  const publicArgs = { [discriminator]: variantValue, ...rest };
  const parsed = publicTool.callSchema.safeParse(publicArgs);
  return parsed.success && isRecord(parsed.data) ? parsed.data : publicArgs;
}

/**
 * Schema a call to `toolName` is parsed with: the public tool's callSchema,
 * else the operation's own schema (deprecated names), else null.
 */
export function callSchemaFor(toolName: string): z.ZodType | null {
  if (isPublicToolName(toolName)) return PUBLIC_TOOLS[toolName].callSchema;
  return isOperationName(toolName) ? callSchemaOf(TOOL_SCHEMAS[toolName]) : null;
}

/** Every name the daemon accepts: the public tools and the deprecated names. */
export function callableToolNames(): Set<string> {
  return new Set([...Object.keys(PUBLIC_TOOLS), ...Object.keys(TOOL_SCHEMAS)]);
}

/** What GET /mcp/tools says about a callable name. */
export interface ToolDescription {
  description: string;
  /** The safety classes of the operations it can run, joined by `|` (as before). */
  classification: string;
  /** The same classes as a list. */
  classifications: ToolClassification[];
}

/** Description and safety classes of a callable name (GET /mcp/tools). */
export function describeTool(toolName: string): ToolDescription | null {
  if (isPublicToolName(toolName)) {
    const tool = PUBLIC_TOOLS[toolName];
    const classes = [...new Set(Object.values(tool.variants).flatMap((v) => v.ops)
      .map((op) => TOOL_SCHEMAS[op].classification))];
    return { description: tool.description, classification: classes.join('|'), classifications: classes };
  }
  if (!isOperationName(toolName)) return null;
  const def = TOOL_SCHEMAS[toolName];
  return {
    description: def.description,
    classification: def.classification,
    classifications: [def.classification],
  };
}

/**
 * The deprecation notice for a deprecated tool name, or null for a current
 * one (the same text as the `[Deprecated: ...]` description prefix).
 */
export function deprecationNote(toolName: string): string | null {
  if (!isLegacyOperationName(toolName)) return null;
  const replacement = LEGACY_REPLACEMENTS[toolName];
  if (replacement === null) {
    return `${toolName} is deprecated and will be removed: it is not implemented on any backend.`;
  }
  const [tool, variant] = replacement;
  const discriminator = PUBLIC_TOOLS[tool].discriminator;
  return `${toolName} is deprecated; use ${tool} with ${discriminator}='${variant}'.`;
}
