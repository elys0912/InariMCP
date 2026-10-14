// Context menu entry of the page: screenshot (L5).
// background.ts registers the click listener once at load time
// (registerContextMenuListener) and shows the entry only while the user
// allows the connection (setScreenshotMenu, from applyControl): before that,
// and after the consent is withdrawn, the screenshot would have nowhere to go.

import { errorMessage } from "../error-message";
import { t } from "../i18n";
import { postToHost } from "./native-connection";
import { takeScreenshot } from "./screenshot";

const SCREENSHOT_MENU_ID = "inari-screenshot";

/** Whether the screenshot entry is in the menu now. */
let screenshotMenuShown = false;

export function registerContextMenuListener(): void {
  browser.contextMenus.onClicked.addListener(
    (
      info: { menuItemId: string },
      tab: browser.tabs.Tab,
    ): void => {
      if (info.menuItemId !== SCREENSHOT_MENU_ID) return;

      void takeScreenshot(tab.id).then(async (result) => {
        if (!result.success) return;
        if (!postScreenshot(tab, result.imageData)) await notifyScreenshotNotSent();
      });
    },
  );
}

/** Hand a screenshot of `tab` to the native host; false when it could not. */
function postScreenshot(tab: browser.tabs.Tab, imageData: unknown): boolean {
  try {
    return postToHost({
      action: "screenshotTaken",
      data: imageData,
      tab: { id: tab.id, url: tab.url ?? "", title: tab.title ?? "" },
    });
  } catch (error) {
    console.warn("[InariMCP] Could not hand the screenshot to the native host:", errorMessage(error));
    return false;
  }
}

/**
 * Tell the user that the screenshot went nowhere: allowed, but not connected
 * to the native host (not installed, or not running yet).
 */
async function notifyScreenshotNotSent(): Promise<void> {
  try {
    await browser.notifications.create({
      type: "basic",
      title: t("notifyScreenshotNotSentTitle"),
      message: t("notifyScreenshotNotSentMessage"),
      iconUrl: browser.runtime.getURL("icons/icon.svg"),
    });
  } catch {
    // Notifications unavailable: log it instead.
    console.warn("[InariMCP] The screenshot was not sent: no connection to the native host");
  }
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
