import { isHeadlessEnabled } from '../utils/headless-env.js';
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

/**
 * Layer 0 (container scope) — division of responsibility.
 *
 * The MCP Server is a Node.js process and cannot see browser tabs or their
 * cookieStoreId, so it CANNOT decide whether a command targets a tab inside
 * the agent container. The real per-tab check lives in the Extension
 * (background.ts `enforceContainerScope`).
 *
 * The server's job is therefore:
 *   1. Attach `containerScope: { containerName }` to every BrowserCommand
 *      (handlers.ts, via getContainerConfig()).
 *   2. Refuse everything when the active backend has no containers at all
 *      (headless / Playwright — see checkHeadlessContainerScope()).
 */

/**
 * Return the effective container-scope configuration to forward to the
 * Extension. `enabled` is false when the whole safety guard is disabled
 * (safety.json `enabled: false` turns off every layer, Layer 0 included).
 */
export function getContainerConfig(
  config: SafetyConfig,
): ContainerScope {
  return {
    enabled: config.enabled && config.containerScope.enabled,
    containerName: config.containerScope.containerName,
  };
}

/**
 * Server-side part of Layer 0.
 *
 * The headless backend has no Firefox containers, so no tab
 * can ever be "inside the agent container". With container scope enabled we
 * fail closed and refuse every command instead of silently ignoring the scope.
 *
 * Returns null when container scope is disabled or the Extension backend is
 * in use (the Extension then performs the actual per-tab check).
 */
export function checkHeadlessContainerScope(
  config: SafetyConfig,
): ContainerDenial | null {
  const why = headlessContainerScopeWarning(config);
  if (why === null) return null;
  return { success: false, safetyDecision: 'out_of_scope', error: `${why} fox_safety_status still works.` };
}

/**
 * Why (and how to get out of) the refusal above, or null when it does not
 * apply. Refusal stays the rule — ignoring the scope would be fail-open — so
 * the way out is a separate safety.json for the headless daemon: the daemon's
 * environment (FOX_HEADLESS, FOX_SAFETY_CONFIG) is fixed when it starts.
 */
export function headlessContainerScopeWarning(config: SafetyConfig): string | null {
  if (!getContainerConfig(config).enabled || !isHeadlessEnabled()) return null;
  return (
    `Container scope is enabled (container '${config.containerScope.containerName}') ` +
    'but this daemon runs the headless backend, which has no Firefox containers, so every ' +
    'browser command is refused. Either use the Extension backend, or start the headless ' +
    'daemon with its own safety.json that sets container_scope.enabled to false ' +
    '(point FOX_SAFETY_CONFIG at it and restart the daemon).'
  );
}
