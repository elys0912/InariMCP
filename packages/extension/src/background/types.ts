// Types shared by the background modules (L0, types only).

import type { CompiledUrlRule } from "../url-rule";

export interface NativeMessage {
  // Numeric for extension-initiated requests (sendToNativeHost), string for
  // MCP Server commands (BrowserCommand.requestId).
  requestId?: number | string;
  action?: string;
  tabId?: number;
  data?: Record<string, unknown>;
  error?: string;
  [key: string]: unknown;
}

export interface CommandResult {
  success: boolean;
  error?: string;
  [key: string]: unknown;
}

export interface ScreenshotOptions {
  format?: string;
  quality?: number;
  fullPage?: boolean;
  /** false: capture nothing (the image would have nowhere to go). */
  saveToFile?: boolean;
  /** all_tabs: attach imageData per tab (the MCP Server always sets it). */
  includeData?: boolean;
  urlPattern?: string;
  /** all_tabs: time budget of the whole run (ms). */
  timeout?: number;
}

export interface GetAllTabsOptions {
  currentWindowOnly?: boolean;
  includeFavicon?: boolean;
  urlPattern?: string;
  limit?: number;
}

export interface RefreshOptions {
  bypassCache?: boolean;
  waitForLoad?: boolean;
}

/** Layer 0 container scope as sent by the MCP Server. */
export interface ContainerScope {
  containerName: string;
}

/**
 * Resolved container scope. cookieStoreId is null when the agent container
 * does not exist yet (then no existing tab is in scope).
 */
export interface ScopeFilter {
  containerName: string;
  cookieStoreId: string | null;
}

export type ScopeDecision =
  | { allowed: true; scope: ScopeFilter; tabId: number | undefined }
  | { allowed: false; error: string };

/** blocked / allowed rules of one command (url-rule.ts). */
export interface UrlLists {
  blocked: CompiledUrlRule[];
  allowed: CompiledUrlRule[];
  /** The server sent an allowed list: URLs outside it are refused. */
  allowlistActive: boolean;
}
