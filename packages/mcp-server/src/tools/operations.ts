/**
 * Public tool names and the operations they run.
 *
 * An operation is one entry of schemas.ts TOOL_SCHEMAS. The SafetyGuard,
 * the password guard and the command routing of handlers.ts work on
 * operations only; a public tool call is turned into an operation call
 * here, and the name and arguments the caller used travel along as the
 * CallLabel (messages, approvals, audit log).
 */

import type { z } from 'zod';
import { isRecord } from '@inari-mcp/shared';
import type { CallLabel } from '../safety/guard.js';
import { TOOL_SCHEMAS, callSchemaOf, isOperationName } from './schemas.js';
import type { OperationName, ToolClassification } from './schemas.js';
import { PUBLIC_TOOLS, PUBLIC_TOOL_NAMES, isPublicToolName } from './public-tools.js';
import type { PublicTool } from './public-tools.js';

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
 * discriminator and other unknown keys dropped). Any other public tool is
 * itself an operation and runs as is, with the arguments unchanged.
 *
 * Throws for a name that is no public tool, and for an unknown variant: the
 * callers parse the call with callSchemaFor() first, which refuses both.
 */
export function resolveOperation(toolName: string, args: Record<string, unknown>): ResolvedCall {
  const tool = isPublicToolName(toolName) ? PUBLIC_TOOLS[toolName] : undefined;
  if (tool?.discriminator !== undefined) return resolveVariant(toolName, tool, tool.discriminator, args);

  // A public tool without a discriminator has the name of its operation (asIs).
  if (tool === undefined || !isOperationName(toolName)) throw new Error(`${toolName}: unknown tool`);
  return { op: toolName, args, label: { tool: toolName, args } };
}

/** The operation of the variant that the discriminator of a grouped tool names. */
function resolveVariant(
  toolName: string,
  tool: PublicTool,
  discriminator: string,
  args: Record<string, unknown>,
): ResolvedCall {
  const value = args[discriminator] ?? tool.defaultVariant;
  const variant = typeof value === 'string' && Object.hasOwn(tool.variants, value)
    ? tool.variants[value]
    : undefined;
  if (variant === undefined) {
    throw new Error(`${toolName}: unknown ${discriminator} '${variantText(value)}'`);
  }

  const op = variant.op(args);
  const opArgs = parseOperationArgs(op, variant.toOp ? variant.toOp(args) : args);
  return { op, args: opArgs, label: { tool: toolName, args } };
}

/** Schema a call to `toolName` is parsed with: the public tool's callSchema, else null. */
export function callSchemaFor(toolName: string): z.ZodType | null {
  return isPublicToolName(toolName) ? PUBLIC_TOOLS[toolName].callSchema : null;
}

/** Every name the daemon accepts: the public tools. */
export function callableToolNames(): Set<string> {
  return new Set(PUBLIC_TOOL_NAMES);
}

/** What GET /mcp/tools says about a callable name. */
export interface ToolDescription {
  description: string;
  /** The safety classes of the operations it can run, joined by `|` (as before). */
  classification: string;
  /** The same classes as a list. */
  classifications: ToolClassification[];
}

/** Description and safety classes of a public tool (GET /mcp/tools). */
export function describeTool(toolName: string): ToolDescription | null {
  if (!isPublicToolName(toolName)) return null;
  const tool = PUBLIC_TOOLS[toolName];
  const classes = [...new Set(Object.values(tool.variants).flatMap((v) => v.ops)
    .map((op) => TOOL_SCHEMAS[op].classification))];
  return { description: tool.description, classification: classes.join('|'), classifications: classes };
}
