// Abort of the commands running in this frame: the background asks for it
// when the user pauses agent actions while a command runs
// (background/dispatch.ts, ABORT_REQUEST_TYPE). A running command sees it at
// each of its steps: every wait between two steps is sleep() (dom.ts), which
// then ends at once with ABORTED_MESSAGE, and the waits on page events
// listen through whenAborted(). A command that starts later (after the pause
// is lifted) runs as usual: beginCommand().

/**
 * The error a command ends with when the pause stops it. It starts with
 * "paused", like the background's PAUSED_REFUSAL, which is what the MCP
 * Server gets in its place (background/dispatch.ts).
 */
export const ABORTED_MESSAGE = "paused: stopped when the user paused agent actions in the toolbar popup";

/** Aborted by abortRunningCommands; replaced when the next command starts. */
let controller = new AbortController();

/** A command starts (handler.ts): an abort sent before it does not apply to it. */
export function beginCommand(): void {
  if (controller.signal.aborted) controller = new AbortController();
}

/** Stop every command running in this frame now. */
export function abortRunningCommands(): void {
  controller.abort();
}

/** Whether the commands running now were told to stop. */
export function isAborted(): boolean {
  return controller.signal.aborted;
}

/** The error of a command the pause stopped. */
export function abortedError(): Error {
  return new Error(ABORTED_MESSAGE);
}

/**
 * Call `onAbort` once when the running commands are told to stop (in a
 * microtask when they already were, so the caller's own setup has finished).
 * Returns what stops listening.
 */
export function whenAborted(onAbort: () => void): () => void {
  const signal = controller.signal;
  if (signal.aborted) {
    queueMicrotask(onAbort);
    return () => {};
  }

  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}
