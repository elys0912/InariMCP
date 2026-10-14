/**
 * Contract: the public tools of tools/public-tools.ts against the operations
 * they run (schemas.ts).
 *
 *   - listSchema (tools/list) says, per argument, which variants use it,
 *     which require it and their defaults, as callSchema enforces them
 *   - tool annotations are those of the WP13 specification (2.2)
 *   - no argument is lost between a public tool and its operation: every
 *     variant argument reaches an operation argument and back
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ZodTypeAny } from 'zod';
import { TOOL_SCHEMAS } from '../../packages/mcp-server/src/tools/schemas.js';
import {
  PUBLIC_TOOLS,
  PUBLIC_TOOL_NAMES,
  unwrap,
  type PublicTool,
  type PublicToolName,
} from '../../packages/mcp-server/src/tools/public-tools.js';

const GROUPED = Object.values(PUBLIC_TOOLS).filter((t) => t.discriminator !== undefined);

/** The variant objects of a grouped tool's callSchema, by discriminator value. */
function variantObjects(tool: PublicTool): Record<string, z.AnyZodObject> {
  let schema: ZodTypeAny = tool.callSchema as ZodTypeAny;
  while (schema instanceof z.ZodEffects) schema = schema._def.schema as ZodTypeAny;
  if (!(schema instanceof z.ZodDiscriminatedUnion)) throw new Error(`${tool.name}: not a discriminated union`);
  const options = schema.options as z.AnyZodObject[];
  return Object.fromEntries(options.map((o) => [(o.shape[tool.discriminator!] as z.ZodLiteral<string>).value, o]));
}

/** A value of the field's type (all object keys set). */
function sample(field: ZodTypeAny): unknown {
  const { base } = unwrap(field);
  if (base instanceof z.ZodString) return 's';
  if (base instanceof z.ZodNumber) return 1;
  if (base instanceof z.ZodBoolean) return true;
  if (base instanceof z.ZodEnum) return (base.options as string[])[0];
  if (base instanceof z.ZodLiteral) return base.value;
  if (base instanceof z.ZodArray) return [sample(base.element as ZodTypeAny)];
  if (base instanceof z.ZodRecord) return {};
  if (base instanceof z.ZodObject) {
    return Object.fromEntries(Object.entries(base.shape as Record<string, ZodTypeAny>).map(([k, v]) => [k, sample(v)]));
  }
  throw new Error(`no sample for ${base.constructor.name}`);
}

const opKeys = (op: string): string[] =>
  Object.keys(TOOL_SCHEMAS[op]!.inputSchema.shape).sort();

// ---------------------------------------------------------------------------

describe('the public tool table', () => {
  it('keys every tool by its own name', () => {
    for (const name of PUBLIC_TOOL_NAMES) expect(PUBLIC_TOOLS[name].name).toBe(name);
  });
});

describe('tools that are an operation as is', () => {
  it('list with the operation schema itself', () => {
    for (const tool of Object.values(PUBLIC_TOOLS).filter((t) => t.discriminator === undefined)) {
      expect(tool.listSchema, tool.name).toBe(TOOL_SCHEMAS[tool.name]!.inputSchema);
      expect(Object.keys(tool.variants), tool.name).toEqual(['default']);
    }
  });

  // G-7: the call schema is the operation's callSchema where it has one,
  // else its inputSchema.
  it('parse with the operation callSchema when there is one, else with its inputSchema', () => {
    const navigate = TOOL_SCHEMAS['fox_navigate']!;
    expect(navigate.callSchema).toBeDefined();
    expect(PUBLIC_TOOLS.fox_navigate.callSchema).toBe(navigate.callSchema);
    expect(PUBLIC_TOOLS.fox_navigate.callSchema.safeParse({}).success).toBe(false);

    const click = TOOL_SCHEMAS['fox_click']!;
    expect(click.callSchema).toBeUndefined();
    expect(PUBLIC_TOOLS.fox_click.callSchema).toBe(click.inputSchema);
  });
});

describe('listSchema of the grouped tools', () => {
  it.each(GROUPED.map((t) => [t.name, t] as const))('%s: discriminator and keys', (_name, tool) => {
    const variants = variantObjects(tool);
    const shape = tool.listSchema.shape as Record<string, ZodTypeAny>;
    const disc = shape[tool.discriminator!]!;
    expect(disc.isOptional()).toBe(tool.defaultVariant !== undefined);
    expect([...(unwrap(disc).base as z.ZodEnum<[string, ...string[]]>).options].sort())
      .toEqual(Object.keys(tool.variants).sort());
    expect(Object.keys(variants).sort()).toEqual(Object.keys(tool.variants).sort());

    const variantKeys = new Set(Object.values(variants).flatMap((o) => Object.keys(o.shape)));
    expect(Object.keys(shape).sort()).toEqual([...variantKeys].sort());
  });

  it.each(GROUPED.map((t) => [t.name, t] as const))('%s: per-argument notes match callSchema', (_name, tool) => {
    const disc = tool.discriminator!;
    const variants = variantObjects(tool);
    const all = Object.keys(variants);
    for (const [key, field] of Object.entries(tool.listSchema.shape as Record<string, ZodTypeAny>)) {
      if (key === disc) continue;
      expect(field.isOptional(), `${tool.name}.${key} optional`).toBe(true);
      expect(unwrap(field).defaultValue, `${tool.name}.${key} has no default`).toBeUndefined();

      const using = all.filter((v) => key in variants[v]!.shape);
      const required = using.filter((v) => unwrap(variants[v]!.shape[key] as ZodTypeAny).required);
      const defaults = using
        .map((v) => [v, unwrap(variants[v]!.shape[key] as ZodTypeAny).defaultValue] as const)
        .filter(([, d]) => d !== undefined);

      const description = field.description ?? '';
      const match = /^\(([^)]*(?:\([^)]*\)[^)]*)*)\) /.exec(description);
      const notes = match ? match[1]!.split('; ') : [];
      const label = `${tool.name}.${key}: ${description.slice(0, 80)}`;

      const scope = notes.find((n) => n.startsWith(`${disc}=`));
      expect(scope ? scope.slice(disc.length + 1).split('|').sort() : all.sort(), label).toEqual([...using].sort());

      const req = notes.find((n) => n.startsWith('required'));
      const claimed = req === undefined ? []
        : req === 'required' ? using
          : req.replace('required for ', '').split('|');
      expect([...claimed].sort(), label).toEqual([...required].sort());

      const def = notes.find((n) => n.startsWith('default '));
      expect(def !== undefined, label).toBe(defaults.length > 0);
      for (const [, value] of defaults) {
        expect(def, label).toContain(typeof value === 'string' ? `'${value}'` : JSON.stringify(value));
      }
    }
  });
});

describe('tool annotations (WP13 specification 2.2)', () => {
  const EXPECTED: Record<PublicToolName, [readOnlyHint: boolean, destructiveHint: boolean]> = {
    fox_screenshot: [true, false],
    fox_snapshot: [true, false],
    fox_read: [true, false],
    fox_find: [true, false],
    fox_tabs: [true, false],
    fox_safety_status: [true, false],
    fox_tab: [false, true],
    fox_navigate: [false, true],
    fox_click: [false, true],
    fox_type: [false, true],
    fox_press_key: [false, true],
    fox_set_value: [false, true],
    fox_handle_dialog: [false, true],
    fox_interact: [false, false],
    fox_wait: [true, false],
    fox_request_approval: [false, false],
    fox_detect_captcha: [true, false],
  };

  it('every public tool has the specified readOnlyHint / destructiveHint', () => {
    for (const name of PUBLIC_TOOL_NAMES) {
      const [readOnlyHint, destructiveHint] = EXPECTED[name];
      expect(PUBLIC_TOOLS[name].annotations, name).toEqual({ readOnlyHint, destructiveHint });
    }
  });
});

describe('variants and their operations', () => {
  const cases = GROUPED.flatMap((tool) => Object.keys(tool.variants).map((v) => [`${tool.name} ${v}`, tool, v] as const));

  it.each(cases)('%s: every argument reaches the operation, and every operation argument is reachable', (_label, tool, value) => {
    const disc = tool.discriminator!;
    const object = variantObjects(tool)[value]!;
    const run = tool.variants[value]!;
    const shape = object.shape as Record<string, ZodTypeAny>;

    const full = sample(object) as Record<string, unknown>;
    const minimal = Object.fromEntries(
      Object.entries(shape).filter(([, f]) => unwrap(f).required).map(([k, f]) => [k, sample(f)]),
    );

    const reached = new Set<string>();
    for (const args of [full, minimal]) {
      const op = run.op(args);
      reached.add(op);
      expect(run.ops).toContain(op);
      const out = run.toOp ? run.toOp(args) : args;
      const keys = Object.keys(out).filter((k) => k !== disc);
      const known = opKeys(op);
      expect(keys.filter((k) => !known.includes(k)), `${op}: arguments the operation would drop`).toEqual([]);
      expect(TOOL_SCHEMAS[op]!.inputSchema.safeParse(out).success, `${op} parses`).toBe(true);
      if (args === full) expect(keys.sort(), `${op}: arguments not reachable`).toEqual(known);
    }
    expect([...reached].sort()).toEqual([...run.ops].sort());
  });
});
