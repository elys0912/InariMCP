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
    function create(createProperties: { url?: string; active?: boolean }): Promise<Tab>;
    function remove(tabId: number): Promise<void>;
    function update(tabId: number, updateProperties: { active?: boolean; url?: string }): Promise<Tab>;
    function reload(tabId: number, reloadProperties?: { bypassCache?: boolean }): Promise<void>;
    function sendMessage(tabId: number, message: unknown): Promise<unknown>;
    function captureVisibleTab(
      windowId: number,
      options?: { format?: string; quality?: number },
    ): Promise<string>;
    function executeScript(tabId: number, details: { code: string }): Promise<unknown[]>;
    function goBack(tabId: number): Promise<void>;
    function goForward(tabId: number): Promise<void>;

    const onActivated: {
      addListener(callback: (activeInfo: { tabId: number; windowId: number }) => void): void;
    };
    const onUpdated: {
      addListener(callback: (tabId: number, changeInfo: TabChangeInfo, tab: Tab) => void): void;
      removeListener(callback: (tabId: number, changeInfo: TabChangeInfo, tab: Tab) => void): void;
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
