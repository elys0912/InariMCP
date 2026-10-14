// Minimal type declarations for Firefox WebExtension `browser.*` APIs
// used by InariMCP background script.

declare namespace browser {
  namespace runtime {
    interface Port {
      name: string;
      error?: { message: string };
      onMessage: {
        addListener(callback: (message: unknown) => void): void;
        removeListener(callback: (message: unknown) => void): void;
      };
      onDisconnect: {
        addListener(callback: (port: Port) => void): void;
        removeListener(callback: (port: Port) => void): void;
      };
      postMessage(message: unknown): void;
      disconnect(): void;
    }

    interface MessageSender {
      tab?: tabs.Tab;
      id?: string;
      url?: string;
    }

    interface PlatformInfo {
      /** "win" | "mac" | "linux" | "android" | "openbsd" | ... */
      os: string;
      arch: string;
    }

    const id: string;
    function connectNative(application: string): Port;
    function getURL(path: string): string;
    function getManifest(): { version: string; [key: string]: unknown };
    function getPlatformInfo(): Promise<PlatformInfo>;
    function sendMessage(message: unknown): Promise<unknown>;

    const onMessage: {
      addListener(
        callback: (
          message: unknown,
          sender: MessageSender,
          sendResponse: (response: unknown) => void,
        ) => boolean | void,
      ): void;
    };

    const onMessageExternal: {
      addListener(
        callback: (
          message: unknown,
          sender: MessageSender,
          sendResponse: (response: unknown) => void,
        ) => boolean | void,
      ): void;
    };

    interface InstalledDetails {
      /** "install" | "update" | "browser_update" | ... */
      reason: string;
      temporary?: boolean;
    }
    const onInstalled: {
      addListener(callback: (details: InstalledDetails) => void): void;
    };
  }

  namespace storage {
    interface StorageArea {
      get(keys: string | string[]): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
    }
    const local: StorageArea;
  }

  namespace tabs {
    interface Tab {
      id: number;
      url?: string;
      title?: string;
      active: boolean;
      windowId: number;
      index: number;
      pinned: boolean;
      status: string;
      discarded: boolean;
      audible: boolean;
      favIconUrl?: string;
      cookieStoreId?: string;
    }

    interface TabChangeInfo {
      status?: string;
      url?: string;
      [key: string]: unknown;
    }

    interface QueryInfo {
      active?: boolean;
      currentWindow?: boolean;
      [key: string]: unknown;
    }

    function query(queryInfo: QueryInfo): Promise<Tab[]>;
    function get(tabId: number): Promise<Tab>;
    function create(createProperties: { url?: string; active?: boolean; cookieStoreId?: string }): Promise<Tab>;
    function remove(tabId: number): Promise<void>;
    function update(tabId: number, updateProperties: { active?: boolean; url?: string }): Promise<Tab>;
    function reload(tabId: number, reloadProperties?: { bypassCache?: boolean }): Promise<void>;
    function sendMessage(
      tabId: number,
      message: unknown,
      options?: { frameId?: number },
    ): Promise<unknown>;
    interface ImageDetails {
      format?: string;
      quality?: number;
      /** Area of the document to capture, in CSS pixels (Firefox 82+). */
      rect?: { x: number; y: number; width: number; height: number };
    }

    function captureTab(tabId: number, options?: ImageDetails): Promise<string>;
    function goBack(tabId: number): Promise<void>;
    function goForward(tabId: number): Promise<void>;

    const onActivated: {
      addListener(callback: (activeInfo: { tabId: number; windowId: number }) => void): void;
    };
    const onUpdated: {
      addListener(callback: (tabId: number, changeInfo: TabChangeInfo, tab: Tab) => void): void;
      removeListener(callback: (tabId: number, changeInfo: TabChangeInfo, tab: Tab) => void): void;
    };
    const onRemoved: {
      addListener(
        callback: (tabId: number, removeInfo: { windowId: number; isWindowClosing: boolean }) => void,
      ): void;
      removeListener(
        callback: (tabId: number, removeInfo: { windowId: number; isWindowClosing: boolean }) => void,
      ): void;
    };
  }

  namespace webNavigation {
    /** onCompleted / onDOMContentLoaded details. */
    interface NavigationDetails {
      tabId: number;
      frameId: number;
      url: string;
    }
    interface NavigationEvent {
      addListener(callback: (details: NavigationDetails) => void): void;
      removeListener(callback: (details: NavigationDetails) => void): void;
    }
    const onCompleted: NavigationEvent;
    const onDOMContentLoaded: NavigationEvent;
  }

  namespace windows {
    interface Window {
      id: number;
      focused: boolean;
      state: string;
      type: string;
    }

    function get(windowId: number): Promise<Window>;
    function getAll(): Promise<Window[]>;
    function update(windowId: number, updateInfo: { focused?: boolean }): Promise<Window>;
  }

  namespace i18n {
    function getMessage(messageName: string, substitutions?: string | string[]): string;
    function getUILanguage(): string;
  }

  namespace browserAction {
    function setBadgeText(details: { text: string | null; tabId?: number }): Promise<void>;
    function setBadgeBackgroundColor(details: { color: string; tabId?: number }): Promise<void>;
    function setTitle(details: { title: string | null; tabId?: number }): Promise<void>;
    /** Firefox may refuse it outside a user action. */
    const openPopup: (() => Promise<void>) | undefined;
  }

  namespace notifications {
    interface NotificationOptions {
      type: string;
      title: string;
      message: string;
      iconUrl?: string;
    }
    function create(options: NotificationOptions): Promise<string>;
    function create(notificationId: string, options: NotificationOptions): Promise<string>;
    const clear: ((notificationId: string) => Promise<boolean>) | undefined;
    const onClicked: { addListener(callback: (notificationId: string) => void): void } | undefined;
  }

  interface ContextualIdentity {
    cookieStoreId: string;
    color: string;
    icon: string;
    name: string;
  }

  interface ContextualIdentities {
    query(details: { name?: string }): Promise<ContextualIdentity[]>;
    create(details: { name: string; color: string; icon: string }): Promise<ContextualIdentity>;
    remove(cookieStoreId: string): Promise<ContextualIdentity>;
    get(cookieStoreId: string): Promise<ContextualIdentity>;
  }

  const contextualIdentities: ContextualIdentities;

  // browser.find API (Firefox-specific)
  namespace find {
    interface FindResult {
      count: number;
      rangeData?: Array<{
        framePos: number;
        startTextNodePos: number;
        endTextNodePos: number;
        startOffset: number;
        endOffset: number;
      }>;
      rectData?: Array<{
        rectsAndTexts: {
          rectList: Array<{ top: number; left: number; bottom: number; right: number }>;
          textList: string[];
        };
        textList: string[];
      }>;
    }

    function find(queryphrase: string, params?: {
      tabId?: number;
      caseSensitive?: boolean;
      entireWord?: boolean;
      includeRangeData?: boolean;
      includeRectData?: boolean;
    }): Promise<FindResult>;
    function highlightResults(params?: { tabId?: number; rangeIndex?: number }): Promise<void>;
    function removeHighlighting(tabId?: number): Promise<void>;
  }

  namespace contextMenus {
    function create(createProperties: {
      id: string;
      title: string;
      contexts: string[];
    }): void;

    function remove(menuItemId: string): Promise<void>;

    const onClicked: {
      addListener(
        callback: (
          info: { menuItemId: string },
          tab: tabs.Tab,
        ) => void,
      ): void;
    };
  }
}

// ---------------------------------------------------------------------------
// Firefox content-script globals for sharing functions with page scripts
// (Xray vision). Only available in content scripts, and only in Firefox.
// ---------------------------------------------------------------------------

/**
 * Make a content-script function callable from the page's JS world. With
 * `defineAs`, it is also defined as that property of `targetScope`.
 */
declare function exportFunction<F extends (...args: never[]) => unknown>(
  func: F,
  targetScope: object,
  options?: { defineAs?: string; allowCrossOriginArguments?: boolean },
): F;

interface Window {
  /** Firefox content scripts: the page's own objects (Xray waived). */
  readonly wrappedJSObject?: Window & typeof globalThis;
  /** Set by content.ts once its listeners are registered in this document. */
  __fox_injected?: boolean;
}
