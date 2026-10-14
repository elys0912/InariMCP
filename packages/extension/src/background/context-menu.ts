// Context menu entry of the page: screenshot (L5).
// Created once by background.ts (registerContextMenus).

import { errorMessage } from "../error-message";
import { t } from "../i18n";
import { postToHost } from "./native-connection";
import { takeScreenshot } from "./screenshot";

export function registerContextMenus(): void {
  browser.contextMenus.create({
    id: "inari-screenshot",
    title: t("menuScreenshot"),
    contexts: ["page"],
  });

  browser.contextMenus.onClicked.addListener(
    (
      info: { menuItemId: string },
      tab: browser.tabs.Tab,
    ): void => {
      if (info.menuItemId === "inari-screenshot") {
        void takeScreenshot(tab.id).then((result) => {
          if (!result.success) return;
          try {
            postToHost({
              action: "screenshotTaken",
              data: result.imageData,
              tab: { id: tab.id, url: tab.url ?? "", title: tab.title ?? "" },
            });
          } catch (error) {
            console.warn("[InariMCP] Could not hand the screenshot to the native host:", errorMessage(error));
          }
        });
      }
    },
  );
}
