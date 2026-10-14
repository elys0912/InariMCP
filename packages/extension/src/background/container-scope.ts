// Layer 0 container scope: the scope check of handleCommand, and the
// container tools (L2).

import { errorMessage } from "../error-message";
import type { ContainerScope, CommandResult, ScopeFilter, ScopeDecision } from "./types";

/** parseContainerScope. */
export type ParsedContainerScope =
  | { kind: "absent" }
  | { kind: "scope"; scope: ContainerScope }
  | { kind: "invalid" };

/**
 * Parse the `containerScope` field attached by the MCP Server. Absent (the
 * server omits it when container_scope is off) is no scope; anything else
 * that is not `{ containerName: <non-empty string> }` is `invalid` and the
 * command is refused: an unusable scope must not switch Layer 0 off.
 */
export function parseContainerScope(raw: unknown): ParsedContainerScope {
  if (raw === undefined) return { kind: "absent" };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { kind: "invalid" };
  const name = (raw as Record<string, unknown>).containerName;
  return typeof name === "string" && name !== ""
    ? { kind: "scope", scope: { containerName: name } }
    : { kind: "invalid" };
}

export function outOfScope(error: string): CommandResult {
  return { success: false, safetyDecision: "out_of_scope", error };
}

/**
 * Look up the agent container's cookieStoreId by name. Returns null when no
 * such container exists (then no existing tab can be in scope). If several
 * containers share the name, the first one is used -- the same rule as
 * open_in_container.
 */
async function findScopeContainer(containerName: string): Promise<string | null> {
  const matches = await browser.contextualIdentities.query({ name: containerName });
  const first = matches[0];
  return first ? first.cookieStoreId : null;
}

/**
 * Create the agent container on demand. Used only by tab-creating actions,
 * matching open_in_container's existing auto-create behaviour.
 */
export async function ensureScopeContainer(scope: ScopeFilter): Promise<string> {
  const existing = await findScopeContainer(scope.containerName);
  if (existing) return existing;
  const created = await browser.contextualIdentities.create({
    name: scope.containerName,
    color: "toolbar",
    icon: "circle",
  });
  return created.cookieStoreId;
}

export function isTabInScope(tab: browser.tabs.Tab, scope: ScopeFilter | null): boolean {
  if (scope === null) return true;
  return scope.cookieStoreId !== null && tab.cookieStoreId === scope.cookieStoreId;
}

/**
 * Layer 0 enforcement. For single-tab actions, requires the target tab
 * (resolved once by handleCommand: explicit tabId, else the active tab) to
 * be in the agent container. A tab that could not be resolved is refused.
 * `selfScoped`: the action enforces the scope itself or touches no tab
 * (action table scope "self" / "noTab"); then only the filter is returned.
 */
export async function enforceContainerScope(
  selfScoped: boolean,
  tab: browser.tabs.Tab | undefined,
  containerScope: ContainerScope,
): Promise<ScopeDecision> {
  const { containerName } = containerScope;
  let cookieStoreId: string | null;
  try {
    cookieStoreId = await findScopeContainer(containerName);
  } catch (error) {
    return {
      allowed: false,
      error: `Container scope check failed: ${errorMessage(error)}`,
    };
  }
  const scope: ScopeFilter = { containerName, cookieStoreId };

  if (selfScoped) {
    return { allowed: true, scope, tabId: undefined };
  }

  if (cookieStoreId === null) {
    return {
      allowed: false,
      error:
        `Container '${containerName}' does not exist, so no tab is inside the container scope. ` +
        "Open a tab in it first: fox_tab with action 'create' and container.",
    };
  }

  if (!tab) {
    return {
      allowed: false,
      error: "Could not resolve the target tab for the container scope check",
    };
  }
  if (tab.cookieStoreId !== cookieStoreId) {
    return {
      allowed: false,
      error: `Tab ${tab.id} is outside the container scope (container '${containerName}')`,
    };
  }
  return { allowed: true, scope, tabId: tab.id };
}

export async function listContainers(
  scope: ScopeFilter | null = null,
): Promise<CommandResult> {
  try {
    const all = await browser.contextualIdentities.query({});
    // With container scope, only the agent container is visible.
    const containers = scope
      ? all.filter((c) => c.cookieStoreId === scope.cookieStoreId)
      : all;
    return {
      success: true,
      containers: containers.map((c) => ({
        name: c.name,
        color: c.color,
        icon: c.icon,
        cookieStoreId: c.cookieStoreId,
      })),
    };
  } catch (error) {
    return { success: false, error: errorMessage(error) };
  }
}

/** fox_tab create with a container: the arguments open_in_container reads. */
interface OpenInContainerData {
  url: string;
  containerName?: string;
  cookieStoreId?: string;
  color?: string;
  icon?: string;
  active?: boolean;
}

/**
 * Container scope: opening a tab in any container other than the agent
 * container is refused (user decision -- no new tabs outside the scope).
 * Null when the container is allowed, or there is no scope.
 */
function containerScopeRefusal(data: OpenInContainerData, scope: ScopeFilter | null): CommandResult | null {
  if (!scope) return null;
  if (data.containerName !== undefined && data.containerName !== scope.containerName) {
    return outOfScope(
      `Container '${data.containerName}' is outside the container scope ` +
      `(only '${scope.containerName}' is allowed)`,
    );
  }
  if (data.cookieStoreId !== undefined && (scope.cookieStoreId === null || data.cookieStoreId !== scope.cookieStoreId)) {
    return outOfScope(
      `cookieStoreId '${data.cookieStoreId}' is outside the container scope ` +
      `(only '${scope.containerName}' is allowed)`,
    );
  }
  return null;
}

/** Verify the container exists before handing the ID to tabs.create: the failure, or null. */
async function missingContainer(storeId: string): Promise<CommandResult | null> {
  try {
    await browser.contextualIdentities.get(storeId);
    return null;
  } catch {
    return {
      success: false,
      error: `Container with cookieStoreId '${storeId}' does not exist`,
    };
  }
}

/** The cookieStoreId of the container named `containerName`, created when there is none. */
async function containerIdByName(containerName: string, data: OpenInContainerData): Promise<string> {
  const matches = await browser.contextualIdentities.query({ name: containerName });
  if (matches.length > 0) return matches[0].cookieStoreId;

  const created = await browser.contextualIdentities.create({
    name: containerName,
    color: data.color || "toolbar",
    icon: data.icon || "circle",
  });
  return created.cookieStoreId;
}

export async function openInContainer(
  data: OpenInContainerData,
  scope: ScopeFilter | null = null,
): Promise<CommandResult> {
  try {
    const refusal = containerScopeRefusal(data, scope);
    if (refusal) return refusal;

    let storeId = data.cookieStoreId;
    if (storeId) {
      const missing = await missingContainer(storeId);
      if (missing) return missing;
    }
    if (!storeId && data.containerName) storeId = await containerIdByName(data.containerName, data);
    if (!storeId) {
      return {
        success: false,
        error: "Either containerName or cookieStoreId is required",
      };
    }

    const url = data.url || "about:blank";
    const tab = await browser.tabs.create({ url, cookieStoreId: storeId, active: data.active !== false });
    return { success: true, tabId: tab.id, cookieStoreId: storeId, url };
  } catch (error) {
    return { success: false, error: errorMessage(error) };
  }
}
