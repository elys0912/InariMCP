// once(): a function that runs on its first call only. Used where an end
// (of a request, a wait, a command) may be reported more than once: by an
// event and a finally, or by a caller that calls it again. Pure; bundled
// into the background and the content script.

/** `fn`, run on the first call only; later calls do nothing. */
export function once(fn: () => void): () => void {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    fn();
  };
}
