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

// TODO: P7 — contextualIdentities API integration.
// When container_scope.enabled is true, this should verify that the target tab
// belongs to the specified container (cookieStoreId check via browser.tabs.get).
// For now, enabled mode always returns null (pass-through) as a stub.
export function checkContainerScope(config: SafetyConfig): ContainerDenial | null {
  if (!config.containerScope.enabled) {
    return null;
  }

  // TODO: P7 — Implement actual container scope check.
  return null;
}
