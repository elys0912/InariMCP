// Context menu entries of the page: screenshot, inspect element (L5).
// Created once by background.ts (registerContextMenus).

import type { ContentRequest } from "../content/types";
import { t } from "../i18n";
import { TOP_FRAME_ID } from "./constants";
import { postToHost } from "./native-connection";
import { takeScreenshot } from "./screenshot";

export function registerContextMenus(): void {
  browser.contextMenus.create({
    id: "kitsune-screenshot",
    title: t("menuScreenshot"),
    contexts: ["page"],
  });

  browser.contextMenus.create({
    id: "kitsune-inspect",
    title: t("menuInspect"),
    contexts: ["all"],
  });

  browser.contextMenus.onClicked.addListener(
    (
      info: { menuItemId: string; frameId?: number },
      tab: browser.tabs.Tab,
    ): void => {
      if (info.menuItemId === "kitsune-screenshot") {
        void takeScreenshot(tab.id).then((result) => {
          if (!result.success) return;
          try {
            postToHost({
              action: "screenshotTaken",
              data: result.imageData,
              tab: { id: tab.id, url: tab.url ?? "", title: tab.title ?? "" },
            });
          } catch (error) {
            console.warn("[KitsuneMCP] Could not hand the screenshot to the native host:", (error as Error).message);
          }
        });
      } else if (info.menuItemId === "kitsune-inspect") {
        // The frame the menu was opened in. Its content script inspects the
        // element it saw the contextmenu event on: OnClickData has no
        // pageX / pageY in Firefox.
        browser.tabs
          .sendMessage(
            tab.id,
            { action: "inspectElement" } satisfies ContentRequest,
            { frameId: info.frameId ?? TOP_FRAME_ID },
          )
          .catch((error: unknown) => {
            // No content script in that frame (e.g. a page extensions cannot enter)
            console.warn("[KitsuneMCP] Inspect element failed:", (error as Error).message);
          });
      }
    },
  );
}
