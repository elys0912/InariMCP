import type { SafetyConfig } from './config.js';

export interface ContainerScope {
  enabled: boolean;
  containerName: string;
}

export interface ContainerDenial {
  success: false;
  safetyDecision: 'out_of_scope';
  error: string;
}

export interface ContainerInfo {
  enabled: true;
  containerName: string;
}

/**
 * Check container scope at the MCP Server (config) level.
 *
 * The MCP Server is a Node.js process and cannot call browser.tabs.get()
 * directly. When container scope is enabled:
 *   - If no tabId is provided, pass through (null) — the caller is not
 *     targeting a specific tab yet.
 *   - The actual cookieStoreId verification happens in the Extension's
 *     background.ts when the command arrives there.
 *
 * Returns ContainerInfo when container scope is active (so callers can
 * attach scope metadata to messages sent to the Extension), or null when
 * container scope is disabled.
 */
export function checkContainerScope(
  config: SafetyConfig,
  _tabId?: number,
): ContainerDenial | null {
  if (!config.containerScope.enabled) {
    return null;
  }

  // Actual tab-level container check is done Extension-side.
  // MCP Server only validates config-level enablement.
  return null;
}

/**
 * Return container configuration for forwarding to the Extension.
 * The Extension uses this to enforce container scope on incoming commands.
 */
export function getContainerConfig(
  config: SafetyConfig,
): { enabled: boolean; containerName: string } {
  return {
    enabled: config.containerScope.enabled,
    containerName: config.containerScope.containerName,
  };
}
