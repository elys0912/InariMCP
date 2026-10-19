/**
 * The headless backend with a way around the approval floor, for the tests
 * that drive the actions one by one. HeadlessBrowser itself has no such
 * method: the daemon runs every command through runCommand()
 * (headless-lifecycle.test.ts checks).
 */

import { HeadlessBrowser } from '../../src/headless/backend.js';
import { currentCommandContext, type CommandContext } from '../../src/connection/manager.js';

export class TestHeadlessBrowser extends HeadlessBrowser {
  /** Run one action without the floor. `ctx` as in runCommand(). */
  execute(
    action: string,
    tabId: number | undefined,
    args: Record<string, unknown>,
    ctx: CommandContext | undefined = currentCommandContext(),
  ): Promise<Record<string, unknown>> {
    return this._execute({ action, tabId, args, ctx }, null);
  }
}
