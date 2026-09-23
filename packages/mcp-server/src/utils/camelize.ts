/**
 * Key conversion utility: snake_case → camelCase for tool arguments.
 *
 * MCP tool schemas use snake_case (full_page, url_pattern, bypass_cache)
 * but the Extension's background.ts / content.ts read camelCase
 * (fullPage, urlPattern, bypassCache).
 *
 * Fork-source: server.py L114-125 camelize_args()
 */

/**
 * Convert a single snake_case key to camelCase.
 *
 * @example camelKey('tab_id')    → 'tabId'
 * @example camelKey('full_page') → 'fullPage'
 * @example camelKey('url')       → 'url'
 */
function camelKey(key: string): string {
  const [head, ...rest] = key.split('_');
  return head + rest.map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('');
}

/**
 * Convert all snake_case keys of a flat argument object to camelCase.
 *
 * Only top-level keys are converted — nested objects are passed through
 * as-is (the Extension does not expect deep conversion).
 */
export function camelizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    result[camelKey(key)] = value;
  }
  return result;
}
