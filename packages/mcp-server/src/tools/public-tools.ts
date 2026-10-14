/**
 * The public tools (WP13 tool consolidation: 31 operations → 17 tools).
 *
 * Ten tools are the operations of schemas.ts as they are. The other seven
 * group several operations behind a discriminator argument (fox_wait
 * `for`, fox_tab `action`, ...); each value of it is a variant that runs
 * one operation (tools/operations.ts). The wire actions, the Extension, the
 * Native Host and the headless backend do not change.
 *
 * Two schemas per grouped tool:
 *   - callSchema: a discriminated union of the variants (their own
 *     required arguments and defaults); the daemon parses calls with it.
 *   - listSchema: one flat object for tools/list. MCP clients and the
 *     Anthropic API need an object schema (no top-level oneOf / anyOf),
 *     and the MCP SDK lists a union as an empty object. The discriminator
 *     is a required enum; every other argument is optional and its
 *     description says which variants use it, and with which default.
 *     Defaults are not set here: they differ per variant and are applied
 *     by callSchema.
 */

import { z } from 'zod';
import type { ZodRawShape, ZodTypeAny } from 'zod';
import { isRecord } from '@inari-mcp/shared';
import { TOOL_SCHEMAS, callSchemaOf } from './schemas.js';
import type { OperationName } from './schemas.js';
import { toolAnnotations } from './classification.js';
import type { ToolAnnotations } from './classification.js';
import { isOneOf } from './one-of.js';

export interface PublicVariant {
  /** The operation it runs, from its parsed arguments. */
  op(args: Record<string, unknown>): OperationName;
  /** Operations it can run (annotations). */
  ops: OperationName[];
  /**
   * The operation's arguments, from the variant's parsed arguments
   * (discriminator included). Default: the same keys; the operation's
   * schema drops the keys it does not know.
   */
  toOp?(args: Record<string, unknown>): Record<string, unknown>;
  /**
   * The inverse of toOp: the variant's arguments (discriminator excluded)
   * from the operation's. A call by the deprecated operation name is
   * audited in the public tool's form with it (tools/operations.ts).
   * Default: the same keys.
   */
  fromOp?(opArgs: Record<string, unknown>): Record<string, unknown>;
}

export interface PublicTool {
  name: string;
  description: string;
  /** Parses a call (daemon, transport/http-bridge.ts). */
  callSchema: z.ZodType;
  /** Listed in tools/list (registry.ts): always a ZodObject. */
  listSchema: z.AnyZodObject;
  annotations: ToolAnnotations;
  /** Absent for the tools that are an operation as is. */
  discriminator?: string;
  /** Variant of a call without the discriminator (else it is required). */
  defaultVariant?: string;
  variants: Record<string, PublicVariant>;
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

/** The fields `keys` of an operation's schema (all of them by default). */
function fieldsOf(op: OperationName, keys?: string[]): ZodRawShape {
  const shape: ZodRawShape = TOOL_SCHEMAS[op].inputSchema.shape;
  if (!keys) return { ...shape };
  const picked: ZodRawShape = {};
  for (const key of keys) {
    const field = shape[key];
    if (!field) throw new Error(`operation ${op} has no argument ${key}`);
    picked[key] = field;
  }
  return picked;
}

/** Strip ZodDefault / ZodOptional wrappers (also used by tests/contract/public-tools.test.ts). */
export function unwrap(field: ZodTypeAny): { base: ZodTypeAny; required: boolean; defaultValue?: unknown } {
  let base = field;
  let required = true;
  let defaultValue: unknown;
  for (;;) {
    if (base instanceof z.ZodDefault) {
      defaultValue = base._def.defaultValue();
      required = false;
      base = base._def.innerType;
    } else if (base instanceof z.ZodOptional) {
      required = false;
      base = base._def.innerType;
    } else {
      return { base, required, defaultValue };
    }
  }
}

function formatDefault(value: unknown): string {
  return typeof value === 'string' ? `'${value}'` : JSON.stringify(value);
}

/**
 * The flat tools/list schema of a grouped tool (see the file comment).
 * Fields keep the order of their first appearance.
 */
function flatListSchema(
  discriminator: string,
  discriminatorDescription: string,
  variants: Record<string, z.AnyZodObject>,
  discriminatorOptional = false,
): z.AnyZodObject {
  const names = Object.keys(variants);
  const occurrences = new Map<string, Array<{ variant: string; field: ZodTypeAny }>>();
  for (const [variant, schema] of Object.entries(variants)) {
    const variantShape: ZodRawShape = schema.shape;
    for (const [key, field] of Object.entries(variantShape)) {
      if (key === discriminator) continue;
      const list = occurrences.get(key) ?? [];
      list.push({ variant, field });
      occurrences.set(key, list);
    }
  }

  const [firstName, ...otherNames] = names;
  if (firstName === undefined) throw new Error(`${discriminator}: no variants`);
  const disc = z.enum([firstName, ...otherNames]).describe(discriminatorDescription);
  const shape: ZodRawShape = { [discriminator]: discriminatorOptional ? disc.optional() : disc };

  for (const [key, list] of occurrences) {
    const first = unwrap(list[0]!.field);
    const used = list.map((o) => o.variant);
    const scope = used.length === names.length ? '' : `${discriminator}=${used.join('|')}`;
    const required = list.filter((o) => unwrap(o.field).required).map((o) => o.variant);
    const requiredNote =
      required.length === 0 ? ''
        : required.length === used.length ? 'required'
          : `required for ${required.join('|')}`;
    const defaults = list
      .map((o) => ({ variant: o.variant, value: unwrap(o.field).defaultValue }))
      .filter((d) => d.value !== undefined);
    const sameDefault = defaults.length > 0 &&
      defaults.every((d) => JSON.stringify(d.value) === JSON.stringify(defaults[0]!.value));
    const defaultNote =
      defaults.length === 0 ? ''
        : sameDefault && defaults.length === used.length ? `default ${formatDefault(defaults[0]!.value)}`
          : `default ${defaults.map((d) => `${formatDefault(d.value)} (${d.variant})`).join(', ')}`;
    const notes = [scope, requiredNote, defaultNote].filter(Boolean).join('; ');
    const description = list[0]!.field.description ?? first.base.description ?? '';
    shape[key] = first.base.optional().describe(notes ? `(${notes}) ${description}` : description);
  }
  return z.object(shape);
}

/** fold the variants' operation annotations: readOnlyHint AND, destructiveHint OR. */
function foldAnnotations(variants: Record<string, PublicVariant>): ToolAnnotations {
  const all = Object.values(variants).flatMap((v) => v.ops).map((op) => toolAnnotations(TOOL_SCHEMAS[op]));
  return {
    readOnlyHint: all.every((a) => a.readOnlyHint),
    destructiveHint: all.some((a) => a.destructiveHint),
  };
}

/**
 * A tool that is one operation as is. `description` replaces the
 * operation's own (FOX_CAPS=legacy keeps that one).
 */
function asIs(op: OperationName, description?: string): PublicTool {
  const def = TOOL_SCHEMAS[op];
  const variants = { default: { op: () => op, ops: [op] } };
  return {
    name: op,
    description: description ?? def.description,
    callSchema: callSchemaOf(def),
    listSchema: def.inputSchema,
    annotations: toolAnnotations(def),
    variants,
  };
}

interface VariantSpec {
  /** Arguments of the variant, discriminator excluded. */
  fields: ZodRawShape;
  run: PublicVariant;
}

/** Run operation `op` with the variant's arguments as they are. */
function same(op: OperationName): PublicVariant {
  return { op: () => op, ops: [op] };
}

function grouped(options: {
  name: string;
  description: string;
  discriminator: string;
  discriminatorDescription: string;
  variants: Record<string, VariantSpec>;
  /** Value used when the discriminator is missing (default: required). */
  defaultVariant?: string;
  /** Checks across arguments that a variant object cannot express. */
  refine?: (args: Record<string, unknown>, ctx: z.RefinementCtx) => void;
}): PublicTool {
  const { discriminator } = options;
  const objects: Record<string, z.AnyZodObject> = {};
  for (const [value, spec] of Object.entries(options.variants)) {
    objects[value] = z.object({ [discriminator]: z.literal(value), ...spec.fields });
  }
  const [first, second, ...rest] = Object.values(objects);
  if (first === undefined || second === undefined) {
    throw new Error(`${options.name}: a grouped tool needs at least two variants`);
  }
  const union = z.discriminatedUnion(discriminator, [first, second, ...rest]);
  const refine = options.refine;
  const refined = refine ? union.superRefine((v, ctx) => refine(v, ctx)) : union;
  const callSchema = options.defaultVariant === undefined
    ? refined
    : z.preprocess((raw) => {
      if (raw && typeof raw === 'object' && !Array.isArray(raw) && !(discriminator in raw)) {
        return { ...raw, [discriminator]: options.defaultVariant };
      }
      return raw;
    }, refined);

  const variants: Record<string, PublicVariant> = {};
  for (const [value, spec] of Object.entries(options.variants)) variants[value] = spec.run;

  const discriminatorDescription = options.defaultVariant === undefined
    ? options.discriminatorDescription
    : `${options.discriminatorDescription} (default '${options.defaultVariant}')`;
  return {
    name: options.name,
    description: options.description,
    callSchema,
    listSchema: flatListSchema(discriminator, discriminatorDescription, objects, options.defaultVariant !== undefined),
    annotations: foldAnnotations(variants),
    discriminator,
    ...(options.defaultVariant !== undefined ? { defaultVariant: options.defaultVariant } : {}),
    variants,
  };
}

/** Rename argument keys; the others are kept. */
function renamed(map: Record<string, string>) {
  return (args: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) out[map[key] ?? key] = value;
    return out;
  };
}

const tabId = z.number().int().optional().describe('Tab ID (defaults to active tab)');

// ---------------------------------------------------------------------------
// Grouped tools
// ---------------------------------------------------------------------------

const foxRead = grouped({
  name: 'fox_read',
  description:
    "Read the page. mode 'info': URL, title, document/viewport size, scroll position, up to 100 visible interactive elements (tag, type, id, name, text, href, value, placeholder, ariaLabel, center position, generated selector), forms with their first 20 fields, h1-h3 headings; password values masked; headless: URL and title only. mode 'text': visible text of the page or of the element `selector`, cheaper than a screenshot.",
  discriminator: 'mode',
  discriminatorDescription: "What to read: 'info' (page overview) or 'text' (visible text)",
  variants: {
    info: { fields: fieldsOf('fox_get_page_info'), run: same('fox_get_page_info') },
    text: { fields: fieldsOf('fox_get_text'), run: same('fox_get_text') },
  },
});

const foxFind = grouped({
  name: 'fox_find',
  description:
    "Find in the page. by 'selector': elements matching a CSS selector (the first `limit`, plus the total count), each with tag, id, classes, name, type, text (200 chars), value (passwords masked), href, src, placeholder, ariaLabel, role, disabled, checked, visible, viewport position (incl. centerX/centerY) and a generated selector; headless: tag, text and box only, at most 50. by 'text': count matches of `text` with Firefox's browser.find (all frames, also outside the viewport), optionally with rects; `text` is the words to search for, not an element locator as in fox_click.",
  discriminator: 'by',
  discriminatorDescription: "'selector' (CSS selector) or 'text' (full-text search)",
  variants: {
    selector: { fields: fieldsOf('fox_get_elements'), run: same('fox_get_elements') },
    text: {
      fields: {
        text: z.string().describe('Text to search for in the page'),
        ...fieldsOf('fox_find_text', ['caseSensitive', 'entireWord', 'includeRectData', 'tabId']),
      },
      run: { ...same('fox_find_text'), toOp: renamed({ text: 'query' }), fromOp: renamed({ query: 'text' }) },
    },
  },
});

const foxTabs = grouped({
  name: 'fox_tabs',
  description:
    "List tabs or containers. what 'tabs': id, url, title, active, windowId, pinned, status, audible, plus totals; by default the current window and at most 50 tabs (currentWindowOnly=false for all windows; urlPattern filters before limit; includeFavicon adds favicon URLs); headless: id, url, title and active only, arguments ignored. what 'containers': Firefox containers (name, color, icon, cookieStoreId), only the agent container when container scope is enabled in safety.json; not available in headless mode.",
  discriminator: 'what',
  discriminatorDescription: "'tabs' or 'containers'",
  variants: {
    tabs: { fields: fieldsOf('fox_get_tabs'), run: same('fox_get_tabs') },
    containers: { fields: {}, run: same('fox_list_containers') },
  },
});

const containerSchema = z.object({
  name: z.string().optional().describe('Container name to use (created if not found)'),
  cookieStoreId: z.string().optional().describe(
    'cookieStoreId of an existing container (e.g. "firefox-container-1", as listed by fox_tabs what=containers). Takes precedence over name',
  ),
});

const foxTab = grouped({
  name: 'fox_tab',
  description:
    "Open, close or switch tabs. action 'create': open a new tab (url, default about:blank; active); with `container` the tab opens in a Firefox container (by name, created if not found, or by cookieStoreId, which must exist; isolated cookies/storage; url required; with container scope enabled in safety.json only the agent container is allowed; not available in headless mode). action 'close': close the tab tabId. action 'switch': focus/activate the tab tabId.",
  discriminator: 'action',
  discriminatorDescription: "'create', 'close' or 'switch'",
  variants: {
    create: {
      fields: {
        url: z.string().optional().describe("URL to open in the new tab (default 'about:blank'; required with container)"),
        active: z.boolean().optional().default(true).describe('Make the new tab active'),
        container: containerSchema.optional().describe('Open the tab in this Firefox container'),
      },
      run: {
        op: (args) => (args['container'] === undefined ? 'fox_create_tab' : 'fox_open_in_container'),
        ops: ['fox_create_tab', 'fox_open_in_container'],
        toOp: (args) => {
          const { container, ...rest } = args;
          if (!isRecord(container)) return rest;
          const { name, cookieStoreId } = container;
          return {
            ...rest,
            ...(name !== undefined ? { containerName: name } : {}),
            ...(cookieStoreId !== undefined ? { cookieStoreId } : {}),
          };
        },
        fromOp: (opArgs) => {
          const { containerName, cookieStoreId, ...rest } = opArgs;
          if (containerName === undefined && cookieStoreId === undefined) return rest;
          return {
            ...rest,
            container: {
              ...(containerName !== undefined ? { name: containerName } : {}),
              ...(cookieStoreId !== undefined ? { cookieStoreId } : {}),
            },
          };
        },
      },
    },
    close: { fields: fieldsOf('fox_close_tab'), run: same('fox_close_tab') },
    switch: { fields: fieldsOf('fox_switch_tab'), run: same('fox_switch_tab') },
  },
  refine: (args, ctx) => {
    const container = args['container'];
    if (args['action'] !== 'create' || !isRecord(container)) return;
    if (container['name'] === undefined && container['cookieStoreId'] === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['container'], message: 'container needs name or cookieStoreId' });
    }
    if (typeof args['url'] !== 'string' || args['url'] === '') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['url'], message: 'url is required with container' });
    }
  },
});

const OPTION_KEYS = ['value', 'text', 'index'] as const;

const foxSetValue = grouped({
  name: 'fox_set_value',
  description:
    "Set a form value directly (no key events), then dispatch input and change events; password fields are refused. kind 'input' (default): the value of an input, textarea, select or contenteditable element; faster than fox_type for long values; reports success even when nothing changed (an element of another kind, or a select without an option of that value). kind 'select': choose an option of a select element by option value, text or index.",
  discriminator: 'kind',
  discriminatorDescription: "'input' or 'select'",
  defaultVariant: 'input',
  variants: {
    input: { fields: fieldsOf('fox_set_value'), run: same('fox_set_value') },
    select: {
      fields: {
        selector: z.string().describe('CSS selector for the select element'),
        option: z.object({
          value: z.string().optional().describe('Option value to select'),
          text: z.string().optional().describe('Option text to select'),
          index: z.number().int().min(0).optional().describe('Option index to select'),
        }).describe('The option to select: exactly one of value, text or index'),
        tabId,
      },
      run: {
        ...same('fox_select_option'),
        toOp: (args) => {
          const { option, ...rest } = args;
          return isRecord(option) ? { ...rest, ...option } : rest;
        },
        fromOp: (opArgs) => {
          const option: Record<string, unknown> = {};
          const rest: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(opArgs)) {
            if (isOneOf(OPTION_KEYS, key)) option[key] = value;
            else rest[key] = value;
          }
          return { ...rest, option };
        },
      },
    },
  },
  refine: (args, ctx) => {
    const option = args['option'];
    if (args['kind'] !== 'select' || !isRecord(option)) return;
    const given = OPTION_KEYS.filter((key) => option[key] !== undefined);
    if (given.length !== 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['option'], message: 'option needs exactly one of value, text or index' });
    }
  },
});

const foxInteract = grouped({
  name: 'fox_interact',
  description:
    "Change UI state only, never page data (allowed in read-only mode). action 'hover': dispatch synthetic mouseenter / mouseover events on the element (isTrusted=false: JavaScript hover handlers run, CSS :hover styles do not apply). action 'scroll': scroll the page or the element `selector` by direction and amount, or scroll the element toElement into view. action 'highlight': show a colored overlay (and optional label) on the element for visual debugging.",
  discriminator: 'action',
  discriminatorDescription: "'hover', 'scroll' or 'highlight'",
  variants: {
    hover: { fields: fieldsOf('fox_hover'), run: same('fox_hover') },
    scroll: { fields: fieldsOf('fox_scroll'), run: same('fox_scroll') },
    highlight: { fields: fieldsOf('fox_highlight'), run: same('fox_highlight') },
  },
});

const foxWait = grouped({
  name: 'fox_wait',
  description:
    "Wait for a page condition; fails after timeout (ms). for 'element': an element matching selector appears (and is visible, unless visible=false). for 'network_idle': the page's own top-frame fetch/XHR requests have been idle for idleTime ms; requests already in flight when the call starts are not seen; headless: Playwright networkidle, idleTime ignored. for 'navigation': the tab's next top-level navigation finishes (waitUntil load or domcontentloaded; optionally only one matching urlPattern); a navigation that finished before the call is missed, so prefer for 'url' when the destination is known; headless: urlPattern ignored. for 'url': the URL equals url or matches the urlPattern regex (one of them required); returns at once if it already does.",
  discriminator: 'for',
  discriminatorDescription: "'element', 'network_idle', 'navigation' or 'url'",
  variants: {
    element: { fields: fieldsOf('fox_wait_for_element'), run: same('fox_wait_for_element') },
    network_idle: { fields: fieldsOf('fox_wait_for_network_idle'), run: same('fox_wait_for_network_idle') },
    navigation: { fields: fieldsOf('fox_wait_for_navigation'), run: same('fox_wait_for_navigation') },
    url: { fields: fieldsOf('fox_wait_for_url'), run: same('fox_wait_for_url') },
  },
  refine: (args, ctx) => {
    if (args['for'] !== 'url') return;
    const has = (key: string) => typeof args[key] === 'string' && args[key] !== '';
    if (!has('url') && !has('urlPattern')) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['url'], message: "for 'url' needs url or urlPattern" });
    }
  },
});

// ---------------------------------------------------------------------------
// Registry of the public tools
// ---------------------------------------------------------------------------

/**
 * Public descriptions of tools that are an operation as is: shorter than
 * the operation's, and naming the public tools.
 */
const AS_IS_DESCRIPTIONS = {
  fox_screenshot:
    "Take a screenshot. Images are saved to files and returned as resource_link, never as base64 (saveToFile=false captures nothing, includeData has no effect, the same filename overwrites the file). scope: viewport (visible area; a background tab given by tabId is captured without switching to it; a discarded tab fails), full_page (entire page; falls back to the visible area with fullPageCaptured=false), all_tabs (every tab, or those whose URL matches the urlPattern regex, within the timeout budget; tabs on sites listed in confirm_read_sites are skipped; fails when no tab could be captured), scroll_capture (takes NO images: scrolls and returns the interactive elements visible at each position). Headless: viewport and full_page only.",
  fox_snapshot:
    "Extension path: not implemented (returns an error); use fox_read or fox_find there. Headless: the accessibility tree of the page (or of the first element matching selector) as indented YAML text (Playwright ariaSnapshot), filtered by maxDepth, includeText and roles, cut at 50000 characters.",
  fox_click:
    "Click an element found by selector (CSS), xpath, text or x+y viewport coordinates, in that order. Top document only (not inside iframes or shadow DOM); fails on a disabled element. The element is scrolled into view and receives synthetic mousedown/mouseup/click events (isTrusted=false: pages that require real user input may ignore them); doubleClick / rightClick send dblclick / contextmenu. Returns the clicked element's info. Headless: selector or x+y only.",
  fox_type:
    "Type text into an input, textarea or contenteditable element found by selector, id, name or placeholder (in that order), else into the focused field; `text` is never used to find the element. Fails on a disabled element; password fields are refused. Sends synthetic key events (isTrusted=false) `delay` ms apart (0 = none; shortened so that all delays stay within 10 s); fox_set_value is faster for long values. clear empties the field first; pressEnter also submits the form like a real Enter unless a keydown handler cancels it. Headless: selector, text and clear only (with selector the text is appended unless clear, else the focused element receives the keys).",
  // The operation's own text says "Not in any FOX_CAPS profile", which holds
  // for the legacy names only: the public tool is in the core profile.
  fox_handle_dialog:
    'Extension path: not implemented (returns an error; commands to a tab showing an alert/confirm/prompt time out there). Headless only: wait for the next dialog and accept or dismiss it (promptText for prompts). Call it before the action that opens the dialog: it does not block other commands, and when no dialog comes within timeout it arms itself for the next dialog on the tab (30 s). Dialogs nobody handles are dismissed automatically after 2 s and reported in the next result of that tab.',
} satisfies Partial<Record<OperationName, string>>;

/**
 * The public tools by name, in tools/list order. Each key is the `name` of
 * its tool (tests/contract/public-tools.test.ts).
 */
const PUBLIC_TOOL_TABLE = {
  fox_screenshot: asIs('fox_screenshot', AS_IS_DESCRIPTIONS.fox_screenshot),
  fox_snapshot: asIs('fox_snapshot', AS_IS_DESCRIPTIONS.fox_snapshot),
  fox_read: foxRead,
  fox_find: foxFind,
  fox_tabs: foxTabs,
  fox_tab: foxTab,
  fox_navigate: asIs('fox_navigate'),
  fox_click: asIs('fox_click', AS_IS_DESCRIPTIONS.fox_click),
  fox_type: asIs('fox_type', AS_IS_DESCRIPTIONS.fox_type),
  fox_press_key: asIs('fox_press_key'),
  fox_set_value: foxSetValue,
  fox_interact: foxInteract,
  fox_wait: foxWait,
  fox_handle_dialog: asIs('fox_handle_dialog', AS_IS_DESCRIPTIONS.fox_handle_dialog),
  fox_request_approval: asIs('fox_request_approval'),
  fox_detect_captcha: asIs('fox_detect_captcha'),
  fox_safety_status: asIs('fox_safety_status'),
} satisfies Record<string, PublicTool>;

export type PublicToolName = keyof typeof PUBLIC_TOOL_TABLE;

export const PUBLIC_TOOLS: Readonly<Record<PublicToolName, PublicTool>> = PUBLIC_TOOL_TABLE;

/** Whether `name` (a name from the wire) is a public tool. */
export function isPublicToolName(name: string): name is PublicToolName {
  return Object.hasOwn(PUBLIC_TOOLS, name);
}

/** Every public tool name, in tools/list order. */
export const PUBLIC_TOOL_NAMES: readonly PublicToolName[] = Object.keys(PUBLIC_TOOLS).filter(isPublicToolName);

/** The operations that are no public tool any more (the deprecated names). */
export type LegacyOperationName = Exclude<OperationName, PublicToolName>;

/** Whether `name` is a deprecated operation name. */
export function isLegacyOperationName(name: string): name is LegacyOperationName {
  return Object.hasOwn(LEGACY_REPLACEMENTS, name);
}

/**
 * Deprecated tool names (the operations that are no public tool any more)
 * and what replaces them: `[tool, discriminator value]`, or null when the
 * tool was removed (fox_run_workflow, fox_audit_page: not implemented on
 * any backend). The key set is checked by the type: every operation is a
 * public tool or listed here.
 */
export const LEGACY_REPLACEMENTS: Readonly<Record<LegacyOperationName, readonly [PublicToolName, string] | null>> = {
  fox_get_page_info: ['fox_read', 'info'],
  fox_get_text: ['fox_read', 'text'],
  fox_get_elements: ['fox_find', 'selector'],
  fox_find_text: ['fox_find', 'text'],
  fox_get_tabs: ['fox_tabs', 'tabs'],
  fox_list_containers: ['fox_tabs', 'containers'],
  fox_create_tab: ['fox_tab', 'create'],
  fox_open_in_container: ['fox_tab', 'create'],
  fox_close_tab: ['fox_tab', 'close'],
  fox_switch_tab: ['fox_tab', 'switch'],
  fox_select_option: ['fox_set_value', 'select'],
  fox_hover: ['fox_interact', 'hover'],
  fox_scroll: ['fox_interact', 'scroll'],
  fox_highlight: ['fox_interact', 'highlight'],
  fox_wait_for_element: ['fox_wait', 'element'],
  fox_wait_for_network_idle: ['fox_wait', 'network_idle'],
  fox_wait_for_navigation: ['fox_wait', 'navigation'],
  fox_wait_for_url: ['fox_wait', 'url'],
  fox_run_workflow: null,
  fox_audit_page: null,
};
