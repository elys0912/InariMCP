// Text of a caught value (pure; bundled into the background, the popup and
// the content script).

/**
 * The message of a thrown value. An Error from another realm (a page, the
 * browser) is not `instanceof Error` here, so any object with a string
 * `message` counts; anything else is converted with String().
 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return String(error);
}
