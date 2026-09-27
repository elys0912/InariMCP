// Minimal type declarations for Firefox WebExtension `browser.*` APIs
// used by KitsuneMCP background script.

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
      frameId?: number;
      id?: string;
      url?: string;
    }

    function connectNative(application: string): Port;
    function getURL(path: string): string;
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
    function captureVisibleTab(
      windowId: number,
      options?: { format?: string; quality?: number },
    ): Promise<string>;
    function executeScript(
      tabId: number,
      details: { code?: string; file?: string; runAt?: string; frameId?: number },
    ): Promise<unknown[]>;
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
    };
  }

  namespace webNavigation {
    interface CommittedDetails {
      tabId: number;
      frameId: number;
      url: string;
    }
    const onCommitted: {
      addListener(callback: (details: CommittedDetails) => void): void;
    };
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

  namespace notifications {
    function create(options: {
      type: string;
      title: string;
      message: string;
      iconUrl?: string;
    }): Promise<string>;
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

    const onClicked: {
      addListener(
        callback: (
          info: { menuItemId: string; pageX?: number; pageY?: number },
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
}
