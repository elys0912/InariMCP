/**
 * The public tools (WP13 tool consolidation: 41 tools → 21).
 *
 * Ten tools are the operations of schemas.ts as they are. The other eleven
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
import { TOOL_SCHEMAS } from './schemas.js';
import { toolAnnotations } from './classification.js';
import type { ToolAnnotations } from './classification.js';

export interface PublicVariant {
  /** The operation it runs (a TOOL_SCHEMAS key), from its parsed arguments. */
  op(args: Record<string, unknown>): string;
  /** Operations it can run (annotations). */
  ops: string[];
  /**
   * The operation's arguments, from the variant's parsed arguments
   * (discriminator included). Default: the same keys; the operation's
   * schema drops the keys it does not know.
   */
  toOp?(args: Record<string, unknown>): Record<string, unknown>;
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

function opShape(op: string): ZodRawShape {
  const schema = TOOL_SCHEMAS[op]?.inputSchema;
  if (!(schema instanceof z.ZodObject)) throw new Error(`no object schema for operation ${op}`);
  return schema.shape as ZodRawShape;
}

/** The fields `keys` of an operation's schema (all of them by default). */
function fieldsOf(op: string, keys?: string[]): ZodRawShape {
  const shape = opShape(op);
  if (!keys) return { ...shape };
  const picked: ZodRawShape = {};
  for (const key of keys) {
    const field = shape[key];
    if (!field) throw new Error(`operation ${op} has no argument ${key}`);
    picked[key] = field;
  }
  return picked;
}

/** Strip ZodDefault / ZodOptional wrappers. */
function unwrap(field: ZodTypeAny): { base: ZodTypeAny; required: boolean; defaultValue?: unknown } {
  let base = field;
  let required = true;
  let defaultValue: unknown;
  for (;;) {
    if (base instanceof z.ZodDefault) {
      defaultValue = (base._def as { defaultValue: () => unknown }).defaultValue();
      required = false;
      base = base._def.innerType as ZodTypeAny;
    } else if (base instanceof z.ZodOptional) {
      required = false;
      base = base._def.innerType as ZodTypeAny;
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
    for (const [key, field] of Object.entries(schema.shape as Record<string, ZodTypeAny>)) {
      if (key === discriminator) continue;
      const list = occurrences.get(key) ?? [];
      list.push({ variant, field });
      occurrences.set(key, list);
    }
  }

  const enumValues = names as [string, ...string[]];
  const disc = z.enum(enumValues).describe(discriminatorDescription);
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
  const all = Object.values(variants).flatMap((v) => v.ops).map((op) => {
    const def = TOOL_SCHEMAS[op];
    if (!def) throw new Error(`unknown operation ${op}`);
    return toolAnnotations(def);
  });
  return {
    readOnlyHint: all.every((a) => a.readOnlyHint),
    destructiveHint: all.some((a) => a.destructiveHint),
  };
}

/**
 * A tool that is one operation as is. `description` replaces the
 * operation's own (FOX_CAPS=legacy keeps that one).
 */
function asIs(op: string, description?: string): PublicTool {
  const def = TOOL_SCHEMAS[op];
  if (!def || !(def.inputSchema instanceof z.ZodObject)) throw new Error(`no object schema for operation ${op}`);
  const variants = { default: { op: () => op, ops: [op] } };
  return {
    name: op,
    description: description ?? def.description,
    callSchema: def.inputSchema,
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
function same(op: string): PublicVariant {
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
  const members = Object.values(objects) as [z.AnyZodObject, z.AnyZodObject, ...z.AnyZodObject[]];
  const union = z.discriminatedUnion(discriminator, members as never);
  const refined = options.refine
    ? union.superRefine((v, ctx) => options.refine!(v as Record<string, unknown>, ctx))
    : union;
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
      run: { ...same('fox_find_text'), toOp: renamed({ text: 'query' }) },
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
          const { container, ...rest } = args as { container?: { name?: string; cookieStoreId?: string } };
          if (container === undefined) return rest;
          return {
            ...rest,
            ...(container.name !== undefined ? { containerName: container.name } : {}),
            ...(container.cookieStoreId !== undefined ? { cookieStoreId: container.cookieStoreId } : {}),
          };
        },
      },
    },
    close: { fields: fieldsOf('fox_close_tab'), run: same('fox_close_tab') },
    switch: { fields: fieldsOf('fox_switch_tab'), run: same('fox_switch_tab') },
  },
  refine: (args, ctx) => {
    if (args['action'] !== 'create' || args['container'] === undefined) return;
    const container = args['container'] as { name?: string; cookieStoreId?: string };
    if (container.name === undefined && container.cookieStoreId === undefined) {
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
          index: z.number().int().optional().describe('Option index to select'),
        }).describe('The option to select: exactly one of value, text or index'),
        tabId,
      },
      run: {
        ...same('fox_select_option'),
        toOp: (args) => {
          const { option, ...rest } = args as { option: Record<string, unknown> };
          return { ...rest, ...option };
        },
      },
    },
  },
  refine: (args, ctx) => {
    if (args['kind'] !== 'select') return;
    const option = args['option'] as Record<string, unknown>;
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
    "Wait for a page condition; fails after timeout (ms). for 'element': an element matching selector appears (and is visible, unless visible=false). for 'network_idle': the page's own top-frame fetch/XHR requests have been idle for idleTime ms; requests made by fox_evaluate, and those in flight before the first call on the page, are not seen; headless: Playwright networkidle, idleTime ignored. for 'navigation': the tab's next top-level navigation finishes (waitUntil load or domcontentloaded; optionally only one matching urlPattern); a navigation that finished before the call is missed, so prefer for 'url' when the destination is known; headless: waitUntil and urlPattern ignored. for 'url': the URL equals url or matches the urlPattern regex (one of them required); returns at once if it already does.",
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

const foxLogging = grouped({
  name: 'fox_logging',
  description:
    "Control console and fetch/XHR capture of the tab (top frame); read the logs with fox_get_logs. action 'start': start capturing (before the actions to monitor); logs are kept per tab across reloads and navigations (the newest 500 console and 500 network entries) until cleared or the tab is closed; refused on a protected site unless approved, and recording pauses while the tab is on one. action 'stop': stop capturing; the logs are kept. action 'clear': clear the console and/or network logs. Not supported in headless mode.",
  discriminator: 'action',
  discriminatorDescription: "'start', 'stop' or 'clear'",
  variants: {
    start: { fields: fieldsOf('fox_start_logging'), run: same('fox_start_logging') },
    stop: { fields: fieldsOf('fox_stop_logging'), run: same('fox_stop_logging') },
    clear: { fields: fieldsOf('fox_clear_logs'), run: same('fox_clear_logs') },
  },
});

const foxGetLogs = grouped({
  name: 'fox_get_logs',
  description:
    "Return what fox_logging captured on this tab (the latest `limit`); paused while the tab is on a protected site; not supported in headless mode. kind 'console': top-frame calls to console.log/warn/error/info/debug, filtered by level and/or a case-insensitive search text; not uncaught exceptions, browser errors, iframes or console output of fox_evaluate; currentPageReached=false means the current page could not be asked for its latest entries. kind 'network': fetch/XHR requests filtered by URL regex, method, status or errorsOnly (network error or status >= 400); no images, scripts, CSS or WebSocket traffic; authorization, cookie, API-key and token headers and secret fields in URLs and bodies are masked, other headers and bodies (truncated) are returned as recorded.",
  discriminator: 'kind',
  discriminatorDescription: "'console' or 'network'",
  variants: {
    console: { fields: fieldsOf('fox_get_console_logs'), run: same('fox_get_console_logs') },
    network: { fields: fieldsOf('fox_get_network_logs'), run: same('fox_get_network_logs') },
  },
});

const foxEvaluate = grouped({
  name: 'fox_evaluate',
  description:
    "Run JavaScript in the tab's top frame; refused when script execution is disabled (allow_script_execution in safety.json or FOX_ALLOW_SCRIPTS=0). mode 'script': return the value of the last expression (JSON-compatible; no top-level `return`, wrap code in an IIFE); Extension path: runs in the content script's isolated world, which sees the page DOM but not the variables of the page's own scripts, and its console.log and fetch/XHR are not captured by fox_logging; headless: runs in the page's own world. mode 'chain': evaluate steps in order, each receiving the prior result as `$prev`, console output captured per step. mode 'wait_and_act': poll until condition is truthy, then run actionScript and return its result. chain and wait_and_act are headless only (the Extension path returns an error).",
  discriminator: 'mode',
  discriminatorDescription: "'script', 'chain' or 'wait_and_act'",
  variants: {
    script: { fields: fieldsOf('fox_execute_script'), run: same('fox_execute_script') },
    chain: { fields: fieldsOf('fox_eval_chain'), run: same('fox_eval_chain') },
    wait_and_act: {
      fields: {
        ...fieldsOf('fox_wait_and_act', ['condition', 'actionScript', 'pollIntervalMs']),
        timeout: z.number().int().optional().default(15000).describe('Max wait time in ms before giving up'),
        tabId,
      },
      run: { ...same('fox_wait_and_act'), toOp: renamed({ timeout: 'timeoutMs' }) },
    },
  },
});

const foxObserver = grouped({
  name: 'fox_observer',
  description:
    "Watch DOM changes. Requires script execution enabled. action 'inject': start a MutationObserver on an element (default body) that collects attribute, child list and subtree changes; it ends when the page reloads or navigates; headless: one observer per page (a new call replaces it, observerId is ignored), changes collect in window.__fox_mutations. action 'remove': remove the observer observerId and return the changes it collected (the last 100); fails when no such observer exists on the current page; headless: observerId is ignored and only the number of changes is returned.",
  discriminator: 'action',
  discriminatorDescription: "'inject' or 'remove'",
  variants: {
    inject: { fields: fieldsOf('fox_inject_observer'), run: same('fox_inject_observer') },
    remove: { fields: fieldsOf('fox_remove_observer'), run: same('fox_remove_observer') },
  },
});

// ---------------------------------------------------------------------------
// Registry of the public tools
// ---------------------------------------------------------------------------

/**
 * Public descriptions of tools that are an operation as is: shorter than
 * the operation's, and naming the public tools.
 */
const AS_IS_DESCRIPTIONS: Record<string, string> = {
  fox_screenshot:
    "Take a screenshot. Images are saved to files and returned as resource_link, never as base64 (saveToFile=false captures nothing, includeData has no effect, the same filename overwrites the file). scope: viewport (visible area; a background tab given by tabId is briefly brought to the front), full_page (entire page; falls back to the visible area with fullPageCaptured=false), all_tabs (every tab, or those whose URL matches the urlPattern regex, within the timeout budget; tabs on protected sites are skipped; fails when no tab could be captured), scroll_capture (takes NO images: scrolls and returns the interactive elements visible at each position). Headless: viewport and full_page only.",
  fox_snapshot:
    "Extension path: not implemented (returns an error); use fox_read or fox_find there. Headless: the accessibility tree of the page (or of the first element matching selector) as indented YAML text (Playwright ariaSnapshot), filtered by maxDepth, includeText and roles, cut at 50000 characters.",
  fox_click:
    "Click an element found by selector (CSS), xpath, text or x+y viewport coordinates, in that order. Top document only (not inside iframes or shadow DOM); fails on a disabled element. The element is scrolled into view and receives synthetic mousedown/mouseup/click events (isTrusted=false: pages that require real user input may ignore them); doubleClick / rightClick send dblclick / contextmenu. Returns the clicked element's info. Headless: selector or x+y only.",
  fox_type:
    "Type text into an input, textarea or contenteditable element found by selector, id, name or placeholder (in that order), else into the focused field; `text` is never used to find the element. Fails on a disabled element; password fields are refused. Sends synthetic key events (isTrusted=false) `delay` ms apart (0 = none; shortened so that all delays stay within 10 s); fox_set_value is faster for long values. clear empties the field first; pressEnter also submits the form like a real Enter unless a keydown handler cancels it. Headless: selector and text only (with selector the field is filled, else the focused element receives the keys).",
};

export const PUBLIC_TOOLS: Record<string, PublicTool> = Object.fromEntries([
  asIs('fox_screenshot', AS_IS_DESCRIPTIONS['fox_screenshot']),
  asIs('fox_snapshot', AS_IS_DESCRIPTIONS['fox_snapshot']),
  foxRead,
  foxFind,
  foxTabs,
  foxTab,
  asIs('fox_navigate'),
  asIs('fox_click', AS_IS_DESCRIPTIONS['fox_click']),
  asIs('fox_type', AS_IS_DESCRIPTIONS['fox_type']),
  asIs('fox_press_key'),
  foxSetValue,
  foxInteract,
  foxWait,
  foxLogging,
  foxGetLogs,
  foxEvaluate,
  foxObserver,
  asIs('fox_handle_dialog'),
  asIs('fox_request_approval'),
  asIs('fox_detect_captcha'),
  asIs('fox_safety_status'),
].map((tool) => [tool.name, tool]));

/**
 * Deprecated tool names (the operations that are no public tool any more)
 * and what replaces them: `[tool, discriminator value]`, or null when the
 * tool was removed (fox_run_workflow, fox_audit_page: not implemented on
 * any backend).
 */
export const LEGACY_REPLACEMENTS: Record<string, readonly [string, string] | null> = {
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
  fox_start_logging: ['fox_logging', 'start'],
  fox_stop_logging: ['fox_logging', 'stop'],
  fox_clear_logs: ['fox_logging', 'clear'],
  fox_get_console_logs: ['fox_get_logs', 'console'],
  fox_get_network_logs: ['fox_get_logs', 'network'],
  fox_execute_script: ['fox_evaluate', 'script'],
  fox_eval_chain: ['fox_evaluate', 'chain'],
  fox_wait_and_act: ['fox_evaluate', 'wait_and_act'],
  fox_inject_observer: ['fox_observer', 'inject'],
  fox_remove_observer: ['fox_observer', 'remove'],
  fox_run_workflow: null,
  fox_audit_page: null,
};
