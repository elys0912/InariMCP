// Context menu entry of the page: screenshot (L5).
// background.ts registers the click listener once at load time
// (registerContextMenus) and shows the entry only while the user allows the
// connection (setScreenshotMenu, from applyControl): before that, and after
// the consent is withdrawn, the screenshot would have nowhere to go.

import { errorMessage } from "../error-message";
import { t } from "../i18n";
import { postToHost } from "./native-connection";
import { takeScreenshot } from "./screenshot";

const SCREENSHOT_MENU_ID = "inari-screenshot";

/** Whether the screenshot entry is in the menu now. */
let screenshotMenuShown = false;

export function registerContextMenus(): void {
  browser.contextMenus.onClicked.addListener(
    (
      info: { menuItemId: string },
      tab: browser.tabs.Tab,
    ): void => {
      if (info.menuItemId === SCREENSHOT_MENU_ID) {
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

/** Add the screenshot entry to the page menu (`shown`), or take it out. */
export function setScreenshotMenu(shown: boolean): void {
  if (shown === screenshotMenuShown) return;
  screenshotMenuShown = shown;
  if (shown) {
    browser.contextMenus.create({
      id: SCREENSHOT_MENU_ID,
      title: t("menuScreenshot"),
      contexts: ["page"],
    });
  } else {
    void browser.contextMenus.remove(SCREENSHOT_MENU_ID).catch((error: unknown) => {
      console.warn("[InariMCP] Could not remove the screenshot menu entry:", errorMessage(error));
    });
  }
}
