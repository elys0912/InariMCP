/**
 * Password guard for keyboard input without a selector (headless fox_type):
 * is the element that receives the keys a password field?
 *
 * The focused element is followed through open shadow roots
 * (deepActiveElement) and into iframes, cross-origin ones included
 * (Playwright reaches every frame). When it cannot be determined (an iframe
 * without a frame, a frame gone meanwhile, nesting deeper than
 * FOCUS_MAX_FRAME_DEPTH, limits.ts) the answer is true: the guard fails closed.
 * Not seen: focus inside a closed shadow root (only its host is visible).
 */

import type { Frame } from 'playwright';
import { deepActiveElement, isPasswordElement } from '../safety/password-guard.js';
import { FOCUS_MAX_FRAME_DEPTH } from './limits.js';

export async function focusedIsPassword(frame: Frame): Promise<boolean> {
  try {
    let current = frame;
    for (let depth = 0; depth <= FOCUS_MAX_FRAME_DEPTH; depth++) {
      const element = (await current.evaluateHandle(deepActiveElement)).asElement();
      if (!element) return false; // nothing focused: the keys go nowhere
      const tag = await element.evaluate((el) => el.tagName);
      if (tag !== 'IFRAME' && tag !== 'FRAME') return await element.evaluate(isPasswordElement);
      const child = await element.contentFrame();
      if (!child) return true;
      current = child;
    }
    return true;
  } catch {
    return true;
  }
}
